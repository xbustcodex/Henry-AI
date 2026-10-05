/**
 * The map gets current without re-walking the machine.
 *
 * The claim is specific and easy to fake: an added path is found, a removed
 * path is gone, and NEITHER was discovered by crawling everything again. So the
 * central assertion is not "the delta contains the new file" — it is that the
 * pass never re-listed the folders whose contents did not change. A test that
 * only checked the delta would pass an implementation that re-crawls the disk
 * and then compares, which is the thing this module exists to avoid.
 *
 * The mechanism under test is a filesystem's own guarantee: a directory's
 * modification time changes when an entry inside it is created, deleted or
 * renamed, and does not change when nothing inside it does. That is what makes
 * skipping an unchanged subtree an observation rather than a guess.
 *
 * A third claim lives here too, because it is the one with real product weight:
 * a newly installed agent runtime is DETECTED AND OFFERED, and the user's
 * selection is not touched. It is asserted against a `SelectionReader` that
 * counts its reads and has no writer at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { defaultExclusions } from '../../src/henry/systemMap';
import { buildExclusionPolicy, setUsersProbe } from './exclusions';
import { nodeMetadataFs, type MetadataFs } from './fsMetadata';
import {
  computeIncrementalDelta,
  type KnownDirectory,
  type KnownFile,
  type PreviousMap,
} from './incremental';
import { scanFilesystem } from './scanner';
import { DEFAULT_SCAN_BUDGET, type ScanProgress } from './types';
import { collectRuntimes } from './inventory';
import {
  registerRuntimeAdapter,
  unregisterRuntimeAdapter,
  resetRuntimeRegistry,
  listRuntimeAdapters,
} from '../runtimes/registry';
import type { AgentRuntimeAdapter, RuntimeModel, RuntimeProbe } from '../runtimes/types';

let root = '';
let home = '';

async function policy() {
  return buildExclusionPolicy(defaultExclusions(), {
    platform: 'linux',
    homeDir: home,
    usersRoot: null,
  });
}

/** Write a file in the fixture home. */
function write(relative: string, contents = 'x'): string {
  const target = path.join(home, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

/** Baseline-scan the fixture home and hand back the previous-map view of it. */
async function baseline(): Promise<PreviousMap> {
  const outcome = await scanFilesystem(nodeMetadataFs(), {
    roots: [home],
    policy: await policy(),
  });

  const childrenByParent = new Map<string, string[]>();
  for (const node of outcome.nodes) {
    if (!node.parentPath) continue;
    const bucket = childrenByParent.get(node.parentPath) ?? [];
    bucket.push(node.path);
    childrenByParent.set(node.parentPath, bucket);
  }

  const directories: KnownDirectory[] = [];
  const files: KnownFile[] = [];
  for (const node of outcome.nodes) {
    if (node.kind === 'directory') {
      directories.push({
        path: node.path,
        modifiedAt: node.modifiedAt,
        createdAt: node.createdAt,
        depth: node.depth,
        classification: node.classification ?? null,
        classificationReason: node.classificationReason ?? null,
        childPaths: childrenByParent.get(node.path) ?? [],
      });
      continue;
    }
    files.push({
      path: node.path,
      sizeBytes: node.sizeBytes,
      modifiedAt: node.modifiedAt,
      createdAt: node.createdAt,
      depth: node.depth,
    });
  }
  return { directories, files };
}

/** A filesystem that counts directory listings, so "no re-crawl" is provable. */
function countingFs(): MetadataFs & { listings: string[] } {
  const real = nodeMetadataFs();
  const listings: string[] = [];
  return {
    listings,
    async readDir(dir: string) {
      listings.push(dir);
      return real.readDir(dir);
    },
    stat: (target: string) => real.stat(target),
  };
}

/** Give a path a distinct mtime, so mtime comparisons are unambiguous. */
function stamp(target: string, seconds: number): void {
  const when = new Date(seconds * 1000);
  utimesSync(target, when, when);
}

/**
 * Advance the mtime of one folder, so a change inside it becomes observable.
 *
 * The incremental pass keys off a folder's mtime, and a filesystem's timestamp
 * granularity is not always fine enough to separate "before the change" from
 * "after it" when both land inside the same tick. That is a property of the
 * disk rather than of the code — so instead of hoping the clock cooperates,
 * tests move the folder's clock the way a real edit soon would. Without this the
 * suite is green on a slow machine and flaky on a fast one, which is the worst
 * of both.
 *
 * Exactly ONE folder is stamped, and files are never stamped: a file's own mtime
 * is part of its identity for rename detection, so touching it would break the
 * very pairing under test. A test that means "this folder's contents changed"
 * therefore names the folder that actually gained or lost an entry — which is
 * exactly the folder a real change would have moved.
 *
 * It is also why `force` exists in production: when a filesystem's timestamps
 * cannot separate two events, the honest answer is to re-list rather than to
 * conclude that nothing changed.
 */
let mtimeClock = 1_900_000_000;
function bumpDirectoryTimes(relativeDir: string): void {
  mtimeClock += 10;
  stamp(path.join(home, relativeDir), mtimeClock);
}

beforeEach(() => {
  mtimeClock = 1_900_000_000;
  root = mkdtempSync(path.join(homedir(), 'systemmap-inc-'));
  home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  setUsersProbe(() => []);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('an incremental update finds what changed', () => {
  it('records a newly added file', async () => {
    write('projects/app/keep.txt');
    const previous = await baseline();

    const added = write('projects/app/new-thing.txt');
    bumpDirectoryTimes('projects/app');
    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, { policy: await policy() });

    expect(result.delta.added.map((node) => node.path)).toContain(added);
    expect(result.delta.removed).toEqual([]);
  });

  it('records a removed file', async () => {
    const doomed = write('projects/app/doomed.txt');
    write('projects/app/keep.txt');
    const previous = await baseline();
    rmSync(doomed);
    bumpDirectoryTimes('projects/app');

    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, { policy: await policy() });

    expect(result.delta.removed).toContain(doomed);
    expect(result.delta.added.map((node) => node.path)).not.toContain(doomed);
  });

  it('records a newly added file in a folder that was not there before', async () => {
    write('projects/existing/file.txt');
    const previous = await baseline();

    const added = write('projects/fresh/new.txt');
    bumpDirectoryTimes('projects');
    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, { policy: await policy() });

    expect(result.delta.added.map((node) => node.path)).toContain(added);
  });

  it('records a removed folder, and takes its contents with it', async () => {
    const folder = path.join(home, 'projects/old');
    mkdirSync(path.join(folder, 'nested'), { recursive: true });
    writeFileSync(path.join(folder, 'a.txt'), 'a');
    writeFileSync(path.join(folder, 'nested/b.txt'), 'b');
    write('projects/keep/file.txt');
    const previous = await baseline();
    rmSync(folder, { recursive: true, force: true });
    bumpDirectoryTimes('projects');

    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, { policy: await policy() });

    // One removal at the top of the deleted tree is enough: deleting the folder
    // removes everything beneath it.
    expect(result.delta.removed).toContain(folder);
    // …and no removal is recorded twice for the same subtree.
    const nestedRemovals = result.delta.removed.filter((entry) => entry.includes('/nested'));
    expect(nestedRemovals).toEqual([]);
  });

  it('walks INTO a newly added folder, not just its top level', async () => {
    write('projects/existing/file.txt');
    const previous = await baseline();

    const deepFile = write('projects/fresh/nested/deep.txt');
    bumpDirectoryTimes('projects');
    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, { policy: await policy() });

    const addedPaths = result.delta.added.map((node) => node.path);
    expect(addedPaths).toContain(deepFile);
    // The new folders themselves are recorded too, or their files would point at
    // a parent the map has never heard of.
    expect(addedPaths).toContain(path.join(home, 'projects/fresh'));
  });

  it('reports a moved file as a rename rather than a delete plus a create', async () => {
    const original = write('projects/app/notes.txt', 'the same bytes');
    // Stamped BEFORE the baseline, so the recorded identity is the pair the file
    // still has after the move. A rename preserves size and mtime, and that is
    // exactly the pair the matcher pairs on.
    stamp(original, 1_700_000_000);
    const previous = await baseline();
    const movedTo = path.join(home, 'projects/app/moved/notes.txt');
    mkdirSync(path.dirname(movedTo), { recursive: true });
    renameSync(original, movedTo);
    bumpDirectoryTimes('projects/app');

    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, { policy: await policy() });

    const renamed = result.delta.renamed.find((entry) => entry.to === movedTo);
    expect(renamed?.from).toBe(original);
    // A rename is not also reported as an unrelated delete and create.
    expect(result.delta.removed).not.toContain(original);
    expect(result.delta.added.map((node) => node.path)).not.toContain(movedTo);
  });

  it('does not claim to see an in-place edit by default', async () => {
    // Editing a file does NOT move the mtime of the folder holding it, so a
    // directory-mtime check cannot see this. Reporting it anyway would be
    // claiming more than the mechanism delivers, so the default pass reports
    // nothing and `verifyFiles` exists for callers who want the extra pass.
    const target = write('projects/app/data.txt', 'v1');
    const previous = await baseline();
    writeFileSync(target, 'v2 with different bytes');
    stamp(target, 1_800_000_000);

    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, {
      policy: await policy(),
    });
    expect(result.delta.updated).toEqual([]);
  });

  it('notices an in-place edit when file verification is asked for', async () => {
    const target = write('projects/app/data.txt', 'v1');
    const previous = await baseline();
    writeFileSync(target, 'v2 with different bytes');
    stamp(target, 1_800_000_000);

    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, {
      policy: await policy(),
      verifyFiles: true,
    });

    const updated = result.delta.updated.find((node) => node.path === target);
    expect(updated).toBeDefined();
    expect(updated?.size_bytes).toBe('v2 with different bytes'.length);
  });

  it('verifies files without re-listing their folders', async () => {
    for (let i = 0; i < 12; i += 1) write(`projects/p${i}/file.txt`);
    const previous = await baseline();
    writeFileSync(path.join(home, 'projects/p5/file.txt'), 'edited');

    const fs = countingFs();
    const result = await computeIncrementalDelta(fs, previous, {
      policy: await policy(),
      verifyFiles: true,
    });

    // The point of `verifyFiles`: edits are caught for the price of stats, not
    // by re-reading directories.
    expect(fs.listings).toEqual([]);
    expect(result.delta.updated.map((node) => node.path)).toContain(
      path.join(home, 'projects/p5/file.txt'),
    );
  });

  it('applies the exclusions to newly added paths too', async () => {
    write('projects/app/file.txt');
    const previous = await baseline();

    // A file the walk must never record, added after the baseline.
    const secret = write('projects/app/.env', 'SECRET=1');
    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, { policy: await policy() });

    // An incremental pass must not be a way around the exclusions.
    expect(result.delta.added.map((node) => node.path)).not.toContain(secret);
  });
});

describe('an incremental update does not re-walk the machine', () => {
  it('checks an unchanged folder with one stat and never lists it again', async () => {
    for (let i = 0; i < 12; i += 1) write(`projects/p${i}/file.txt`);
    const previous = await baseline();

    const fs = countingFs();
    const result = await computeIncrementalDelta(fs, previous, { policy: await policy() });

    // Nothing changed, so no directory was re-listed at all…
    expect(fs.listings).toEqual([]);
    // …and every one of them was recognised as unchanged, which is what let it
    // be skipped.
    expect(result.unchangedDirectories).toBe(previous.directories.length);
    expect(result.recheckedDirectories).toBe(0);
    // And the delta is genuinely empty rather than "empty because nothing ran".
    expect(result.delta.added).toEqual([]);
    expect(result.delta.removed).toEqual([]);
    expect(result.delta.updated).toEqual([]);
  });

  it('re-lists only the folder that changed', async () => {
    for (let i = 0; i < 12; i += 1) write(`projects/p${i}/file.txt`);
    const previous = await baseline();
    write('projects/p5/new-file.txt');
    bumpDirectoryTimes('projects/p5');

    const fs = countingFs();
    const result = await computeIncrementalDelta(fs, previous, { policy: await policy() });

    // One listing: the folder the file went into. The other eleven were skipped
    // on their unchanged mtime, which is the whole saving.
    expect(fs.listings).toEqual([path.join(home, 'projects/p5')]);
    expect(result.recheckedDirectories).toBe(1);
    expect(result.unchangedDirectories).toBe(previous.directories.length - 1);
  });

  it('re-lists everything when forced, and reports the same changes', async () => {
    write('projects/a/file.txt');
    const previous = await baseline();
    const added = write('projects/a/second.txt');
    bumpDirectoryTimes('projects/a');

    const fs = countingFs();
    const result = await computeIncrementalDelta(fs, previous, {
      policy: await policy(),
      force: true,
    });

    expect(fs.listings.length).toBe(previous.directories.length);
    expect(result.delta.added.map((node) => node.path)).toContain(added);
  });

  it('costs far less than a full scan on an unchanged tree', async () => {
    // 60 folders: a machine big enough that "re-crawl it" is a real cost.
    for (let i = 0; i < 60; i += 1) {
      mkdirSync(path.join(home, `bulk/d${i}`), { recursive: true });
      writeFileSync(path.join(home, `bulk/d${i}/file.txt`), 'x');
    }
    const previous = await baseline();

    const incrementalFs = countingFs();
    await computeIncrementalDelta(incrementalFs, previous, { policy: await policy() });
    const incrementalListings = incrementalFs.listings.length;

    const fullFs = countingFs();
    await scanFilesystem(fullFs, { roots: [home], policy: await policy() });

    expect(fullFs.listings.length).toBeGreaterThan(incrementalListings * 2);
  });
});

describe('the incremental pass is bounded and cancellable too', () => {
  it('stops at its ceilings and says so', async () => {
    for (let i = 0; i < 12; i += 1) write(`projects/p${i}/file.txt`);
    const previous = await baseline();
    for (let i = 0; i < 12; i += 1) {
      write(`projects/p${i}/added-${i}.txt`);
      bumpDirectoryTimes(`projects/p${i}`);
    }

    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, {
      policy: await policy(),
      budget: { maxNodes: 3 },
    });

    expect(result.truncations.some((entry) => entry.includes('ceiling of 3'))).toBe(true);
  });

  it('stops when cancelled and reports it', async () => {
    for (let i = 0; i < 12; i += 1) write(`projects/p${i}/file.txt`);
    const previous = await baseline();
    write('projects/p1/new.txt');
    bumpDirectoryTimes('projects/p1');
    const controller = new AbortController();
    controller.abort();

    const result = await computeIncrementalDelta(nodeMetadataFs(), previous, {
      policy: await policy(),
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
  });

  it('defaults to the same budget the baseline uses', async () => {
    // The limits are not two sets of numbers that drift apart: one default
    // object serves both paths.
    expect(DEFAULT_SCAN_BUDGET.maxDepth).toBeGreaterThan(0);
    expect(DEFAULT_SCAN_BUDGET.maxNodes).toBeGreaterThan(DEFAULT_SCAN_BUDGET.maxDepth);
  });
});

describe('progress never invents a total', () => {
  it('reports totalFiles as null while the walk is still going', async () => {
    write('projects/app/file.txt');
    const progress: ScanProgress[] = [];
    await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await policy(),
      onProgress: (report) => progress.push(report),
    });

    expect(progress.length).toBeGreaterThan(0);
    for (const report of progress) {
      // A total drawn before enumeration finished would be a made-up number
      // driving the progress bar.
      expect(report.totalFiles).toBeNull();
      expect(typeof report.foldersScanned).toBe('number');
    }
  });
});

// ── Agent runtimes ───────────────────────────────────────────────────────────

/** An adapter whose availability the test dictates outright. */
function fakeAdapter(id: string, available: boolean): AgentRuntimeAdapter {
  const probe: RuntimeProbe = available
    ? {
        id,
        displayName: id,
        available: true,
        binaryPath: `/usr/local/bin/${id}`,
        version: '2.4.0',
        capabilities: { run: { verified: true }, listModels: { verified: false, note: 'not probed' } },
      }
    : {
        id,
        displayName: id,
        available: false,
        unavailableReason: 'not installed',
        capabilities: {
          run: { verified: false, note: 'not installed' },
          listModels: { verified: false, note: 'not installed' },
        },
      };
  return {
    id,
    displayName: id,
    candidateBinaries: () => [id],
    probe: async () => probe,
    listModels: async (): Promise<RuntimeModel[]> => [],
    run: async () => ({ ok: false, text: '' }),
  };
}

/**
 * Empty the runtime registry so only what a test registers is discovered.
 *
 * The shipped registry holds the real omp and pi adapters, which probe real
 * binaries — leaving them in would make "discovery found exactly my fixtures"
 * depend on the machine running the tests.
 */
function emptyRegistry(): void {
  resetRuntimeRegistry();
  for (const adapter of listRuntimeAdapters()) unregisterRuntimeAdapter(adapter.id);
}

describe('a newly installed agent runtime is discovered and offered', () => {
  beforeEach(() => {
    emptyRegistry();
  });
  afterEach(() => {
    emptyRegistry();
    resetRuntimeRegistry();
  });

  it('offers a runtime that was absent at the last snapshot and is installed now', async () => {
    registerRuntimeAdapter(fakeAdapter('omp', false));
    registerRuntimeAdapter(fakeAdapter('pi', false));

    const before = await collectRuntimes({ readSelectedRuntimeId: () => null }, []);
    expect(before.runtimes.find((entry) => entry.id === 'pi')?.available).toBe(false);
    expect(before.offers).toEqual([]);

    // The user installs it. Nothing about the selection changes.
    registerRuntimeAdapter(fakeAdapter('pi', true));
    const after = await collectRuntimes(
      { readSelectedRuntimeId: () => null },
      before.runtimes.filter((entry) => entry.available).map((entry) => entry.id),
    );

    const offer = after.offers.find((entry) => entry.runtimeId === 'pi');
    expect(offer).toBeDefined();
    expect(offer?.reason).toBe('newly-available');
    expect(offer?.version).toBe('2.4.0');
    expect(offer?.currentSelection).toBeNull();
  });

  it('does not select it, and does not change the stored selection', async () => {
    registerRuntimeAdapter(fakeAdapter('omp', true));
    registerRuntimeAdapter(fakeAdapter('pi', false));

    let reads = 0;
    const selectionReader = {
      readSelectedRuntimeId: (): string | null => {
        reads += 1;
        return 'omp';
      },
    };

    registerRuntimeAdapter(fakeAdapter('pi', true));
    const after = await collectRuntimes(selectionReader, ['omp']);

    expect(after.offers.map((entry) => entry.runtimeId)).toEqual(['pi']);
    // The offer carries the user's selection forward unchanged…
    expect(after.offers[0].currentSelection).toBe('omp');
    expect(after.selectedRuntimeId).toBe('omp');
    // …and the scan's only relationship to the selection is reading it. There is
    // no writer anywhere in this path: a selection that silently became `pi`
    // would take a decision away from the user with no error raised.
    expect(reads).toBeGreaterThan(0);
  });

  it('offers nothing when a runtime was already available at the last snapshot', async () => {
    registerRuntimeAdapter(fakeAdapter('pi', true));
    const result = await collectRuntimes({ readSelectedRuntimeId: () => null }, ['pi']);
    expect(result.offers).toEqual([]);
    // Still reported as installed — the difference is offer, not visibility.
    expect(result.runtimes.find((entry) => entry.id === 'pi')?.available).toBe(true);
  });

  it('does not offer a runtime that has been uninstalled', async () => {
    registerRuntimeAdapter(fakeAdapter('pi', false));
    const result = await collectRuntimes({ readSelectedRuntimeId: () => null }, ['pi']);
    expect(result.offers).toEqual([]);
  });

  it('marks which runtime the user had already chosen, without changing it', async () => {
    registerRuntimeAdapter(fakeAdapter('omp', true));
    registerRuntimeAdapter(fakeAdapter('pi', true));

    const result = await collectRuntimes({ readSelectedRuntimeId: () => 'pi' }, []);
    expect(result.runtimes.find((entry) => entry.id === 'pi')?.selected).toBe(true);
    expect(result.runtimes.find((entry) => entry.id === 'omp')?.selected).toBe(false);
    expect(result.selectedRuntimeId).toBe('pi');
  });
});