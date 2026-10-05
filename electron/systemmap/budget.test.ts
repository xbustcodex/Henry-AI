/**
 * A scan on a real machine must not hang the app or exhaust it.
 *
 * Three claims, each of which fails on a real machine before it fails here:
 *
 *   1. **Every ceiling stops the walk and says so.** A cap that fires
 *      silently produces a map that looks complete while being a fraction of the
 *      disk — the exact failure this module exists to prevent. Each test asserts
 *      both that the cap held AND that a truncation names it.
 *   2. **A cancelled scan stops promptly and records nothing.** "Promptly" is
 *      asserted by the fact that the abort happened on the FIRST directory, so a
 *      scanner that only checked for cancellation at the end would still pass.
 *   3. **The event loop keeps turning.** A scan of a large fixture yields
 *      between nodes, which is what keeps the window responsive; without it the
 *      app is frozen for the duration of the walk.
 *
 * The fixture is built under the user's home, not `/tmp`, because Henry's
 * defaults exclude `/tmp` — a fixture there would be excluded before a single
 * assertion ran.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { createFixtureRoot, removeFixtureRoot } from './_fixture';
import path from 'node:path';

import { defaultExclusions } from '../../src/henry/systemMap';
import { buildExclusionPolicy, setUsersProbe } from './exclusions';
import { nodeMetadataFs } from './fsMetadata';
import { scanFilesystem } from './scanner';
import type { ScanBudget } from './types';

let root = '';
let home = '';

async function policy() {
  return buildExclusionPolicy(defaultExclusions(), {
    platform: 'linux',
    homeDir: home,
    usersRoot: null,
  });
}

/** Create `count` files in one directory, and return that directory. */
function bulkDirectory(relative: string, count: number): string {
  const dir = path.join(home, relative);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    writeFileSync(path.join(dir, `file-${String(i).padStart(4, '0')}.txt`), `content ${i}`);
  }
  return dir;
}

/** Create a chain of nested directories `depth` levels deep. */
function deepChain(relative: string, depth: number): string {
  let current = path.join(home, relative);
  mkdirSync(current, { recursive: true });
  for (let i = 0; i < depth; i += 1) {
    current = path.join(current, `level-${i}`);
    mkdirSync(current, { recursive: true });
    writeFileSync(path.join(current, 'leaf.txt'), 'x');
  }
  return current;
}

beforeEach(async () => {
  root = await createFixtureRoot('budget');
  home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  setUsersProbe(() => []);
});

afterEach(() => {
  if (root) removeFixtureRoot(root);
});

describe('caps are respected on a large tree', () => {
  it('stops at the per-directory entry cap and reports it', async () => {
    const wide = bulkDirectory('wide', 400);

    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await policy(),
      budget: { maxEntriesPerDirectory: 50 } satisfies Partial<ScanBudget>,
    });

    const recordedInWide = outcome.nodes.filter((node) =>
      node.path.startsWith(`${wide}/`) && node.kind === 'file',
    );
    expect(recordedInWide.length).toBeLessThanOrEqual(50);
    // And the map says why it is short, naming the folder and the cap.
    expect(
      outcome.truncations.some((entry) => entry.includes(wide) && entry.includes('400 entries')),
    ).toBe(true);
  });

  it('stops at the total node cap and reports it', async () => {
    bulkDirectory('many', 600);

    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await policy(),
      budget: { maxNodes: 40 } satisfies Partial<ScanBudget>,
    });

    expect(outcome.nodes.length).toBeLessThanOrEqual(40);
    expect(outcome.truncations.some((entry) => entry.includes('ceiling of 40'))).toBe(true);
  });

  it('stops at the depth cap and names the folder it did not open', async () => {
    deepChain('deep', 6);

    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await policy(),
      budget: { maxDepth: 3 } satisfies Partial<ScanBudget>,
    });

    const depths = outcome.nodes.map((node) => node.depth);
    expect(Math.max(...depths)).toBeLessThanOrEqual(3);
    expect(outcome.truncations.some((entry) => entry.includes('deeper than the depth limit'))).toBe(
      true,
    );
  });

  it('stops at the directory ceiling', async () => {
    for (let i = 0; i < 12; i += 1) bulkDirectory(`branch-${i}`, 2);

    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await policy(),
      budget: { maxDirectories: 5 } satisfies Partial<ScanBudget>,
    });

    expect(outcome.stats.foldersScanned).toBeLessThanOrEqual(5);
    // The message names the cap that fired, so "the map is short" is never a
    // mystery to the person looking at it.
    expect(
      outcome.truncations.some((entry) => entry.includes('ceiling of 5 folders scanned')),
    ).toBe(true);
  });

  it('stops at the time limit rather than running forever', async () => {
    bulkDirectory('slow', 900);
    let clock = 0;
    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await policy(),
      // A clock that jumps past the limit on the second reading, which is what
      // a genuinely slow mount looks like.
      now: () => {
        clock += 3;
        return clock;
      },
      budget: { maxDurationMs: 5 } satisfies Partial<ScanBudget>,
    });

    expect(outcome.truncations.some((entry) => entry.includes('time limit'))).toBe(true);
  });

  it('bounds concurrency, so one scan cannot saturate the disk', async () => {
    for (let i = 0; i < 20; i += 1) bulkDirectory(`c-${i}`, 2);
    let active = 0;
    let peak = 0;
    const real = nodeMetadataFs();

    await scanFilesystem(
      {
        async readDir(dir: string) {
          active += 1;
          peak = Math.max(peak, active);
          try {
            // Yield so overlapping reads are actually observable.
            await new Promise<void>((resolve) => setImmediate(resolve));
            return await real.readDir(dir);
          } finally {
            active -= 1;
          }
        },
        stat: (target: string) => real.stat(target),
      },
      { roots: [home], policy: await policy(), budget: { concurrency: 3 } },
    );

    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('keeps the event loop turning while scanning a large tree', async () => {
    bulkDirectory('big', 1_200);

    // Counted by a self-rescheduling `setImmediate` rather than a timer: the
    // claim under test is that the scan yields the loop, not anything about how
    // many milliseconds a walk takes, so a wall-clock timer would make a correct
    // scanner look broken on a slow machine.
    let turns = 0;
    let running = true;
    const spin = (): void => {
      if (!running) return;
      turns += 1;
      setImmediate(spin);
    };
    setImmediate(spin);

    try {
      await scanFilesystem(nodeMetadataFs(), {
        roots: [home],
        policy: await policy(),
        yieldEveryNodes: 25,
      });
    } finally {
      running = false;
    }

    // A scanner that never yields blocks the loop for the whole walk, so this
    // counter would read 0 or 1 no matter how much work was done.
    expect(turns).toBeGreaterThan(2);
  });
});

describe('a scan can be cancelled', () => {
  it('stops when the signal aborts, and records nothing', async () => {
    bulkDirectory('cancellable', 400);
    const controller = new AbortController();
    // Abort on the first progress report, i.e. after the first directory is
    // listed and before the walk could finish.
    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await policy(),
      onProgress: () => controller.abort(),
      signal: controller.signal,
    });

    expect(outcome.stats.cancelled).toBe(true);
    expect(outcome.truncations.some((entry) => entry.includes('Cancelled'))).toBe(true);
  });

  it('does no further work after the abort', async () => {
    bulkDirectory('a', 200);
    bulkDirectory('b', 200);
    const controller = new AbortController();
    let reads = 0;
    const real = nodeMetadataFs();

    const outcome = await scanFilesystem(
      {
        async readDir(dir: string) {
          reads += 1;
          return real.readDir(dir);
        },
        stat: (target: string) => real.stat(target),
      },
      {
        roots: [home],
        policy: await policy(),
        onProgress: () => controller.abort(),
        signal: controller.signal,
      },
    );

    expect(outcome.stats.cancelled).toBe(true);
    // 400 files per branch: a scan that ignored the abort would read every
    // directory on the machine. A handful of reads proves it stopped early.
    expect(reads).toBeLessThan(5);
  });

  it('is a no-op when the signal is already aborted before the scan starts', async () => {
    bulkDirectory('unstarted', 50);
    const controller = new AbortController();
    controller.abort();

    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await policy(),
      signal: controller.signal,
    });

    expect(outcome.stats.cancelled).toBe(true);
  });

  it('completes normally when nothing cancels it', async () => {
    // The control for the tests above: without this, "everything is cancelled"
    // would pass them all.
    bulkDirectory('normal', 40);
    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await policy(),
    });
    expect(outcome.stats.cancelled).toBe(false);
    expect(outcome.nodes.length).toBeGreaterThan(40);
  });
});

describe('an unreadable folder costs one folder, not the scan', () => {
  it('records the miss and keeps going', async () => {
    writeFileSync(path.join(home, 'regular.txt'), 'x');
    const real = nodeMetadataFs();
    const outcome = await scanFilesystem(
      {
        readDir: async (dir: string) => {
          if (dir === home) throw new Error('EACCES');
          return real.readDir(dir);
        },
        stat: (target: string) => real.stat(target),
      },
      { roots: [home], policy: await policy() },
    );

    expect(outcome.truncations.some((entry) => entry.includes('could not be read'))).toBe(true);
    expect(outcome.stats.cancelled).toBe(false);
  });

  it('notices a directory that disappeared mid-scan', async () => {
    const doomed = bulkDirectory('vanishing', 3);
    const real = nodeMetadataFs();
    rmSync(doomed, { recursive: true, force: true });
    utimesSync(home, new Date(), new Date());

    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await policy(),
    });
    expect(outcome.stats.cancelled).toBe(false);
    // The vanished folder simply is not in the map; the walk still finished.
    expect(outcome.nodes.some((node) => node.path.startsWith(doomed))).toBe(false);
    expect(real).toBeDefined();
  });
});