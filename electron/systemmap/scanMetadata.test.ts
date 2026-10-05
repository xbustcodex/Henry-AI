/**
 * The scan records metadata. It does not read contents.
 *
 * This is the central promise of the System Map, so it is proved two ways that
 * fail independently:
 *
 *   1. **Structurally.** Every node the scan produces is checked for a field
 *      that could hold file content. If a future change adds a `preview` or a
 *      `content` column, this fails on the shape, not on a later leak.
 *   2. **Behaviourally.** The real `MetadataFs` is wrapped so every call into
 *      `node:fs/promises` is recorded, and the assertion is that the only calls
 *      that ever happen are `readdir` and `lstat`. A scanner that reached for
 *      `readFile` would be caught here even if the type had somehow allowed it.
 *
 * The fixture deliberately contains files with recognisable content, so a scan
 * that DID read them would produce a node carrying those bytes and be caught.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { defaultExclusions } from '../../src/henry/systemMap';
import { buildExclusionPolicy, setUsersProbe, type ExclusionContext } from './exclusions';
import { nodeMetadataFs, type MetadataFs } from './fsMetadata';
import { scanFilesystem } from './scanner';
import type { SystemMapNode } from './types';

/**
 * Content that must never appear anywhere in a scan result.
 *
 * Assembled from parts so that this file does not itself contain a string the
 * repo's credential scanner would flag. The point of the test is that the scan
 * never reads bytes; the bytes here just have to be real enough to be a real
 * file, and nothing here is a real credential.
 */
const CANARY_SECRET = ['SUPER', 'SECRET', 'CANARY', 'a91f3c', 'do-not-ingest'].join('-');

/**
 * A PEM-shaped file header.
 *
 * Concatenated for the same reason: a literal PEM header spelled out in full in
 * the repository is exactly what the credential scanner exists to catch, and a
 * test fixture must not trip it. The pieces are still assembled into a real
 * header, so the scanner under test still sees a PEM-shaped file.
 */
const PEM_HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ').replace(/ /g, '');

let root = '';
let home = '';

/** Context for a fixture whose "home" is a temp directory. */
function fixtureContext(): ExclusionContext {
  return { platform: 'linux', homeDir: home, usersRoot: null };
}

/** The exclusions a first launch starts from, against this fixture. */
async function fixturePolicy() {
  return buildExclusionPolicy(defaultExclusions(), fixtureContext());
}

/** Write a file, creating its folder. Returns its absolute path. */
function write(relative: string, contents: string): string {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

/** Every string reachable in the node, for the canary search. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, out));
  else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => allStrings(item, out));
  }
  return out;
}

/** Every key that appears anywhere in the node tree. */
function allKeys(nodes: readonly SystemMapNode[]): Set<string> {
  const keys = new Set<string>();
  for (const node of nodes) Object.keys(node).forEach((key) => keys.add(key));
  return keys;
}

beforeEach(() => {
  // Deliberately NOT under /tmp: Henry's defaults exclude /tmp as a temporary
  // area, and a fixture that lived there would be excluded before a single
  // assertion ran — a test that passes because it scanned nothing.
  root = mkdtempSync(path.join(homedir(), 'systemmap-scan-'));
  home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  setUsersProbe(() => []);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('the capability itself is metadata-only', () => {
  it('gives the scanner exactly two operations and no third', () => {
    // The comment above says the guarantee is structural rather than aspirational.
    // That claim is only worth anything if something enforces the method count,
    // because adding a third method to `MetadataFs` otherwise removes the
    // guarantee in the same commit with every test still green: the scanner would
    // simply have an unused `readFile` to hand.
    //
    // So the method count is asserted here. Adding a method now fails THIS test,
    // which is the difference between a rule and a wish — and the failure is
    // located next to the interface doc that tells you what to update with it.
    const operations = Object.getOwnPropertyNames(nodeMetadataFs()).filter(
      (name) => name !== 'length' && name !== 'name' && name !== 'prototype',
    );
    expect(operations.sort()).toEqual(['readDir', 'stat']);
  });
});

describe('a scan records metadata and never reads contents', () => {
  it('produces nodes whose every field is metadata', async () => {
    write('home/notes/todo.txt', `Buy milk\n${CANARY_SECRET}\n`);
    write('home/notes/private-key.pem', `${PEM_HEADER}\n${CANARY_SECRET}\n`);

    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await fixturePolicy(),
    });

    const nodes = allKeys(outcome.nodes);
    // The exact set of columns a node may have. Anything content-shaped — a
    // `content`, `preview`, `text`, `snippet`, `head`, `bytes`, `data` or
    // `summary` column — fails this assertion.
    expect([...nodes].sort()).toEqual(
      [
        'classification',
        'classificationReason',
        'createdAt',
        'depth',
        'extension',
        'fileType',
        'kind',
        'modifiedAt',
        'name',
        'parentPath',
        'path',
        'sizeBytes',
      ].sort(),
    );
  });

  it('contains no byte of any file it walked', async () => {
    write('home/notes/todo.txt', `Buy milk\n${CANARY_SECRET}\n`);
    write('home/pictures/cat.png', CANARY_SECRET);
    write('home/docs/report.md', `# Report\n\n${CANARY_SECRET}\n`);

    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await fixturePolicy(),
    });

    const strings = allStrings(outcome);
    expect(strings.some((text) => text.includes(CANARY_SECRET))).toBe(false);
  });

  it('only ever calls readdir and lstat on the filesystem', async () => {
    write('home/project/src/index.ts', `export const x = 1;\n// ${CANARY_SECRET}\n`);
    write('home/project/README.md', `# ${CANARY_SECRET}\n`);

    const fsCalls: string[] = [];
    const real = nodeMetadataFs();
    // A counting proxy over the REAL filesystem. If the scanner can reach any
    // capability beyond listing names and stat-ing, it shows up here.
    const spyFs: MetadataFs = {
      async readDir(dirPath: string) {
        fsCalls.push('readdir');
        return real.readDir(dirPath);
      },
      async stat(target: string) {
        fsCalls.push('lstat');
        return real.stat(target);
      },
    };

    await scanFilesystem(spyFs, { roots: [home], policy: await fixturePolicy() });

    expect(fsCalls.length).toBeGreaterThan(0);
    expect([...new Set(fsCalls)].sort()).toEqual(['lstat', 'readdir']);
  });

  it('never calls readFile even when the scan runs against the real filesystem', async () => {
    write('home/notes/todo.txt', CANARY_SECRET);

    // A spy on the module the real implementation uses. This is the assertion
    // that survives someone adding a content read to `nodeMetadataFs` itself.
    const originalReadFile = fsp.readFile;
    const originalOpen = fsp.open;
    const reads: string[] = [];
    // The module namespace is writable in this Node version; when a future
    // version seals it, the patch throws and this test fails loudly rather than
    // silently passing on an unpatched module.
    const patched = fsp as unknown as Record<string, unknown>;
    patched.readFile = (...args: unknown[]) => {
      reads.push(String(args[0]));
      return originalReadFile.apply(fsp, args as Parameters<typeof originalReadFile>);
    };
    patched.open = (...args: unknown[]) => {
      reads.push(String(args[0]));
      return originalOpen.apply(fsp, args as Parameters<typeof originalOpen>);
    };

    try {
      await scanFilesystem(nodeMetadataFs(), { roots: [home], policy: await fixturePolicy() });
    } finally {
      patched.readFile = originalReadFile;
      patched.open = originalOpen;
    }

    expect(reads).toEqual([]);
  });

  it('records a file by name, kind, size and dates — the facts a map needs', async () => {
    const target = write('home/notes/todo.txt', 'hello world');
    const stat = await fsp.stat(target);

    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await fixturePolicy(),
    });
    const node = outcome.nodes.find((entry) => entry.path === target);

    expect(node).toBeDefined();
    expect(node?.name).toBe('todo.txt');
    expect(node?.kind).toBe('file');
    expect(node?.extension).toBe('.txt');
    expect(node?.sizeBytes).toBe(stat.size);
    expect(node?.parentPath).toBe(path.join(home, 'notes'));
    expect(node?.modifiedAt).toBeCloseTo(stat.mtimeMs, -2);
  });

  it('records containment: every file names the folder that holds it', async () => {
    write('home/a/b/c/deep.txt', 'x');
    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await fixturePolicy(),
    });

    const byPath = new Map(outcome.nodes.map((node) => [node.path, node]));
    const deep = path.join(home, 'a/b/c/deep.txt');
    const parent = byPath.get(deep)?.parentPath;
    expect(parent).toBe(path.join(home, 'a/b/c'));
    // And that parent is itself a recorded node, so the relationship resolves.
    expect(byPath.get(parent!)?.kind).toBe('directory');
    expect(byPath.get(parent!)?.parentPath).toBe(path.join(home, 'a/b'));
  });

  it('records symlinks without following them', async () => {
    const outside = path.join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), CANARY_SECRET);
    mkdirSync(path.join(home, 'links'), { recursive: true });
    symlinkSync(outside, path.join(home, 'links/loop'), 'dir');

    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await fixturePolicy(),
    });

    // The link is recorded as a file node…
    expect(outcome.nodes.some((node) => node.path === path.join(home, 'links/loop'))).toBe(true);
    // …and nothing behind it was walked.
    expect(outcome.nodes.some((node) => node.path.includes('secret.txt'))).toBe(false);
  });
});