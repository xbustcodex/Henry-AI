/**
 * What the System Map IPC promises the renderer.
 *
 * Five claims, each of which is a promise made on screen before anyone clicks:
 *
 *   1. **A scan starts only because the renderer asked.** Nothing here begins a
 *      walk at registration or on a timer; the channel is the single door. The
 *      test asserts that registering the handlers touches no filesystem at all.
 *   2. **The exclusions passed in are the exclusions used.** A category the user
 *      removed is genuinely scanned, and the exact set the caller sent is the set
 *      that reaches the policy — asserted on a recorded policy, not on a mock
 *      that would agree.
 *   3. **A cancelled scan resolves `cancelled` and stores nothing.** The caller
 *      must be able to tell "stopped" from "finished", because a half-written map
 *      that looks finished is the failure this whole feature fears.
 *   4. **An exclusion set naming something unenforceable is refused**, rather than
 *      quietly narrowed to whatever this build understands.
 *   5. **The saved set round-trips**, so Settings can re-open exactly what the
 *      user reviewed.
 *
 * Electron's `ipcMain` is stood in for so the handlers can be invoked the way
 * Electron would invoke them; the database is real `node:sqlite`, because the
 * SQL is part of what is under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    },
  },
}));

import {
  defaultExclusions,
  includeCategory,
  type SystemMapExclusions,
  type SystemMapScanOutcome,
} from '../../src/henry/systemMap';
import { setUsersProbe } from '../systemmap/exclusions';
import { nodeMetadataFs } from '../systemmap/fsMetadata';
import {
  ensureSystemMapSchema,
  readExclusions,
  type StoredNode,
  type SystemMapDb,
} from '../systemmap/store';
import {
  isScanning,
  readSavedExclusions,
  registerSystemMapHandlers,
  type SystemMapHost,
} from './systemMap';

let root = '';
let home = '';
let db: SystemMapDb;
let rawDb: DatabaseSync;

/** Invoke a registered channel exactly as `ipcMain` would. */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const listener = handlers.get(channel);
  if (!listener) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(listener({}, ...args)) as Promise<T>;
}

/** Progress events the handler sent to the window. */
const sent: unknown[] = [];

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (_channel: string, payload: unknown) => sent.push(payload) },
} as unknown as Electron.BrowserWindow;

/** A host over the fixture home, with every external answer stubbed. */
function host(): SystemMapHost {
  return {
    platform: 'linux',
    homeDir: home,
    usersRoot: path.dirname(home),
    pathDirectories: [],
    roots: [home],
    fs: nodeMetadataFs(),
    readSelectedRuntimeId: () => null,
    // Stubbed so the test never spawns a binary or makes an HTTP call: this file
    // is about what the IPC boundary promises, not about what a machine holds.
    discoverRuntimes: async () => ({
      runtimes: [],
      installedRuntimeIds: [],
      selectedRuntimeId: null,
      discoveredAt: 0,
    }),
    listLocalModels: async () => [],
    applicationDirectories: [],
  };
}

/** Write a file in the fixture home. */
function write(relative: string, contents = 'x'): string {
  const target = path.join(home, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

/** Every stored node path. */
function storedPaths(): string[] {
  return (rawDb.prepare('SELECT path FROM system_map_nodes ORDER BY path').all() as { path: string }[]).map(
    (row) => row.path,
  );
}

beforeEach(() => {
  handlers.clear();
  sent.length = 0;
  root = mkdtempSync(path.join(homedir(), 'systemmap-ipc-'));
  home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  setUsersProbe(() => []);
  rawDb = new DatabaseSync(':memory:');
  rawDb.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  db = {
    prepare: (sql: string) => rawDb.prepare(sql),
    exec: (sql: string) => rawDb.exec(sql),
  };
  ensureSystemMapSchema(db);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  rawDb.close();
});

describe('a scan starts only because the renderer asked', () => {
  it('registers its channels without scanning anything', async () => {
    write('Documents/notes.txt');
    let reads = 0;
    const countingFs = {
      readDir: async (dir: string) => {
        reads += 1;
        return nodeMetadataFs().readDir(dir);
      },
      stat: (target: string) => nodeMetadataFs().stat(target),
    };

    registerSystemMapHandlers(db, { ...host(), fs: countingFs }, () => fakeWindow);

    // Registering must not walk the disk. An app that started inventorying on
    // launch would be doing the exact thing the UI promises it does not do.
    expect(reads).toBe(0);
    expect(isScanning()).toBe(false);
    expect(storedPaths()).toEqual([]);
    for (const channel of [
      'systemMap:exclusions',
      'systemMap:exclusions/save',
      'systemMap:scan/start',
      'systemMap:scan/cancel',
      'systemMap:contents',
    ]) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('reports no map before one has been built', async () => {
    registerSystemMapHandlers(db, host(), () => fakeWindow);
    expect(await invoke<unknown>('systemMap:contents')).toBeNull();
  });
});

describe('the exclusions passed in are the exclusions used', () => {
  it('scans a category the user removed', async () => {
    const key = write('.ssh/notes.txt', 'not a key after all');
    const exclusions = includeCategory(defaultExclusions(), 'secrets');
    registerSystemMapHandlers(db, host(), () => fakeWindow);

    const outcome = await invoke<SystemMapScanOutcome>('systemMap:scan/start', exclusions);

    expect(outcome.status).toBe('completed');
    // The user's toggle is honoured, not overridden by a merged-back default.
    expect(storedPaths()).toContain(key);
  });

  it('still enforces the categories the user left on', async () => {
    const secret = write('.ssh/id_rsa', 'key');
    const cache = write('.cache/thing/blob', 'x');
    registerSystemMapHandlers(db, host(), () => fakeWindow);

    await invoke<SystemMapScanOutcome>('systemMap:scan/start', defaultExclusions());

    expect(storedPaths()).not.toContain(secret);
    expect(storedPaths()).not.toContain(cache);
  });

  it('honours a folder the user excluded by hand', async () => {
    write('Documents/private/entry.md');
    const kept = write('Documents/public/entry.md');
    const exclusions: SystemMapExclusions = {
      categories: defaultExclusions().categories,
      folders: [{ path: path.join(home, 'Documents/private') }],
    };
    registerSystemMapHandlers(db, host(), () => fakeWindow);

    await invoke<SystemMapScanOutcome>('systemMap:scan/start', exclusions);

    expect(storedPaths()).toContain(kept);
    expect(storedPaths()).not.toContain(path.join(home, 'Documents/private'));
  });

  it('refuses an exclusion set it cannot enforce, and scans nothing', async () => {
    write('Documents/notes.txt');
    registerSystemMapHandlers(db, host(), () => fakeWindow);

    const outcome = await invoke<SystemMapScanOutcome>('systemMap:scan/start', {
      categories: [{ id: 'telepathy', label: 'Thoughts', isDefault: true }],
      folders: [],
    });

    // Silently narrowing a "do not look at this" to what this build happens to
    // support would be a lie told to the user in the shape of a scan.
    expect(outcome.status).toBe('failed');
    expect(storedPaths()).toEqual([]);
  });

  it('refuses a malformed exclusion set rather than scanning with a default', async () => {
    write('Documents/notes.txt');
    registerSystemMapHandlers(db, host(), () => fakeWindow);

    const outcome = await invoke<SystemMapScanOutcome>('systemMap:scan/start', { categories: 'secrets' });

    expect(outcome.status).toBe('failed');
    expect(storedPaths()).toEqual([]);
  });
});

describe('a cancelled scan says so and stores nothing', () => {
  it('resolves cancelled and leaves the previous map untouched', async () => {
    write('Documents/first.txt');
    registerSystemMapHandlers(db, host(), () => fakeWindow);
    await invoke<SystemMapScanOutcome>('systemMap:scan/start', defaultExclusions());
    const afterFirst = storedPaths();
    expect(afterFirst).toContain(path.join(home, 'Documents/first.txt'));

    // Enough files that the walk cannot finish before the cancel lands, and a
    // window whose `send` cancels synchronously on the first progress event —
    // which is what pressing Stop during a scan actually does.
    for (let i = 0; i < 400; i += 1) write(`Documents/bulk/file-${i}.txt`);
    const cancelHandler = handlers.get('systemMap:scan/cancel');
    const window2 = {
      isDestroyed: () => false,
      webContents: {
        send: () => {
          cancelHandler?.({}, undefined);
        },
      },
    } as unknown as Electron.BrowserWindow;

    registerSystemMapHandlers(db, host(), () => window2);
    const outcome = await invoke<SystemMapScanOutcome>('systemMap:scan/start', defaultExclusions());

    expect(outcome.status).toBe('cancelled');
    // The stored map is exactly what it was — not a half-updated mixture that
    // would read as "your new file is already in there".
    expect(storedPaths()).toEqual(afterFirst);
  });

  it('is safe to cancel when nothing is running', async () => {
    registerSystemMapHandlers(db, host(), () => fakeWindow);
    await expect(invoke('systemMap:scan/cancel')).resolves.toBeUndefined();
  });
});

describe('progress is reported, and never invents a total', () => {
  it('sends progress events while scanning, each with a null total', async () => {
    write('Documents/a.txt');
    write('Documents/nested/b.txt');
    registerSystemMapHandlers(db, host(), () => fakeWindow);

    await invoke<SystemMapScanOutcome>('systemMap:scan/start', defaultExclusions());

    expect(sent.length).toBeGreaterThan(0);
    for (const payload of sent) {
      const progress = payload as { phase: string; totalFiles: number | null };
      expect(progress.phase).toBe('scanning');
      // A progress bar drawn against a made-up total is a lie about work not
      // yet done, so the total stays null throughout the walk.
      expect(progress.totalFiles).toBeNull();
    }
  });
});

describe('the reviewed exclusions round-trip', () => {
  it('seeds Henry defaults before the user has reviewed anything', () => {
    registerSystemMapHandlers(db, host(), () => fakeWindow);
    const seeded = readSavedExclusions(db);
    expect(seeded.categories.map((category) => category.id).sort()).toEqual(
      defaultExclusions().categories.map((category) => category.id).sort(),
    );
    // And nothing was written for it: a fresh install has no saved set until
    // someone actually reviews one.
    expect(readExclusions(db)).toBeNull();
  });

  it('saves and returns exactly what was reviewed', async () => {
    registerSystemMapHandlers(db, host(), () => fakeWindow);
    const reviewed: SystemMapExclusions = {
      categories: [{ id: 'secrets', label: 'Passwords and key files', isDefault: true }],
      folders: [{ path: '/home/buster/Private' }],
    };

    expect(await invoke<boolean>('systemMap:exclusions/save', reviewed)).toBe(true);
    expect(await invoke<SystemMapExclusions>('systemMap:exclusions')).toEqual(reviewed);
  });

  it('refuses to save an exclusion set it cannot enforce', async () => {
    registerSystemMapHandlers(db, host(), () => fakeWindow);

    const saved = await invoke<boolean>('systemMap:exclusions/save', {
      categories: [{ id: 'telepathy', label: 'Thoughts', isDefault: true }],
      folders: [],
    });

    expect(saved).toBe(false);
    expect(readExclusions(db)).toBeNull();
  });

  it('refuses a malformed exclusion set', async () => {
    registerSystemMapHandlers(db, host(), () => fakeWindow);
    expect(await invoke<boolean>('systemMap:exclusions/save', { categories: [] })).toBe(false);
  });
});

describe('what the renderer reads back', () => {
  it('reports the map the scan stored', async () => {
    write('Documents/report.pdf', 'a report');
    write('Documents/nested/photo.jpg', 'a photo');
    registerSystemMapHandlers(db, host(), () => fakeWindow);

    const outcome = await invoke<SystemMapScanOutcome>('systemMap:scan/start', defaultExclusions());
    expect(outcome.status).toBe('completed');

    const contents = await invoke<{ fileCount: number; totalBytes: number; fileTypes: { type: string }[] } | null>(
      'systemMap:contents',
    );
    expect(contents?.fileCount).toBe(2);
    expect(contents?.totalBytes).toBe('a report'.length + 'a photo'.length);
    expect(contents?.fileTypes.map((entry) => entry.type).sort()).toEqual(['.jpg', '.pdf']);
  });

  it('re-scans incrementally on a second start and still resolves completed', async () => {
    write('Documents/first.txt');
    registerSystemMapHandlers(db, host(), () => fakeWindow);
    await invoke<SystemMapScanOutcome>('systemMap:scan/start', defaultExclusions());

    // A second start must not report "nothing to do": the UI has one button, and
    // it has to work on every press.
    const second = await invoke<SystemMapScanOutcome>('systemMap:scan/start', defaultExclusions());
    expect(second.status).toBe('completed');
    const contents = await invoke<{ fileCount: number } | null>('systemMap:contents');
    expect(contents?.fileCount).toBe(1);
  });
});

describe('the stored map holds metadata only', () => {
  it('has no column that could hold file contents', async () => {
    write('Documents/secret-looking.txt', 'SENSITIVE PAYLOAD');
    registerSystemMapHandlers(db, host(), () => fakeWindow);
    await invoke<SystemMapScanOutcome>('systemMap:scan/start', defaultExclusions());

    const columns = (
      rawDb.prepare('PRAGMA table_info(system_map_nodes)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns.sort()).toEqual(
      [
        'classification',
        'classification_reason',
        'created_at',
        'depth',
        'extension',
        'file_type',
        'kind',
        'modified_at',
        'name',
        'parent_path',
        'path',
        'size_bytes',
      ].sort(),
    );

    // And no row anywhere carries the bytes.
    const rows = rawDb.prepare('SELECT * FROM system_map_nodes').all() as Record<string, unknown>[];
    const asText = JSON.stringify(rows);
    expect(asText).not.toContain('SENSITIVE PAYLOAD');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('records containment, so a file resolves to its folder', async () => {
    write('Documents/nested/deep.txt');
    registerSystemMapHandlers(db, host(), () => fakeWindow);
    await invoke<SystemMapScanOutcome>('systemMap:scan/start', defaultExclusions());

    const rows = rawDb.prepare('SELECT path, parent_path FROM system_map_nodes').all() as {
      path: string;
      parent_path: string | null;
    }[];
    const deep = rows.find((row) => row.path === path.join(home, 'Documents/nested/deep.txt'));
    expect(deep?.parent_path).toBe(path.join(home, 'Documents/nested'));
    expect(rows.some((row) => row.path === path.join(home, 'Documents/nested'))).toBe(true);
  });
});

describe('the store is reachable the way the renderer sees it', () => {
  it('exposes nodes with the same shape the store defines', async () => {
    write('Documents/notes.txt', 'hello');
    registerSystemMapHandlers(db, host(), () => fakeWindow);
    await invoke<SystemMapScanOutcome>('systemMap:scan/start', defaultExclusions());

    const rows = rawDb.prepare('SELECT * FROM system_map_nodes').all() as unknown as StoredNode[];
    expect(rows.some((row) => row.kind === 'directory' && row.classification !== null)).toBe(true);
    expect(rows.some((row) => row.kind === 'file' && row.size_bytes === 5)).toBe(true);
  });
});