/**
 * The map survives a restart, and updates without being rebuilt.
 *
 * These tests drive REAL SQL through `node:sqlite` rather than a fake. The
 * statements in `store.ts` are the behaviour under test — an upsert that does
 * not upsert, a subtree delete that only deletes its root — and a fake that
 * agreed with whatever was written would prove nothing at all.
 *
 * Three claims:
 *
 *   1. **A snapshot round-trips.** What the scan recorded is what comes back,
 *      and a fresh database holds no map until one is built.
 *   2. **A delta is applied, not replayed.** An update writes only what changed,
 *      which is what makes staying current cheaper than re-scanning — and the
 *      subtree-delete test is the load-bearing one, because a delete that
 *      removed only the folder it was handed would leave orphans behind forever.
 *   3. **The schema is versioned, and a foreign one is not read as a map.**
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import {
  applyDelta,
  countNodes,
  ensureSystemMapSchema,
  readExclusions,
  readSnapshot,
  replaceSnapshot,
  updateInventory,
  writeExclusions,
  type StoredNode,
  type SystemMapDb,
} from './store';
import { buildSystemMap, readSystemMapContents, refreshSystemMap, type SystemMapEnvironment } from './systemMap';
import { defaultExclusions } from '../../src/henry/systemMap';
import { setUsersProbe } from './exclusions';
import { nodeMetadataFs } from './fsMetadata';

/** A fresh in-memory database with the map schema applied. */
function freshDb(): SystemMapDb {
  const db = new DatabaseSync(':memory:');
  // The exclusions live in the settings table Henry already has.
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  const handle: SystemMapDb = {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
  };
  ensureSystemMapSchema(handle);
  return handle;
}

/** One stored row, for tests that do not need a whole tree. */
function node(overrides: Partial<StoredNode> & { path: string }): StoredNode {
  return {
    parent_path: null,
    name: 'thing',
    kind: 'file',
    extension: '.txt',
    file_type: 'document',
    size_bytes: 10,
    created_at: 1_700_000_000_000,
    modified_at: 1_700_000_000_000,
    depth: 1,
    classification: null,
    classification_reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  setUsersProbe(() => []);
});

describe('the snapshot round-trips', () => {
  it('holds nothing until a map is built', () => {
    const db = freshDb();
    expect(readSnapshot(db)).toBeNull();
    expect(countNodes(db)).toBe(0);
  });

  it('stores what a scan recorded and reads it back', () => {
    const db = freshDb();
    replaceSnapshot(
      db,
      {
        schemaVersion: 1,
        builtAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        rootCount: 1,
        inventory: JSON.stringify({ applications: [], warnings: [] }),
      },
      [
        node({ path: '/home/buster/notes.txt', name: 'notes.txt', parent_path: '/home/buster' }),
        node({ path: '/home/buster', name: 'buster', kind: 'directory', extension: null, file_type: 'other', depth: 0 }),
      ],
    );

    expect(countNodes(db)).toBe(2);
    const header = readSnapshot(db);
    expect(header?.rootCount).toBe(1);
    expect(header?.builtAt).toBe(1_700_000_000_000);

    const stored = db
      .prepare('SELECT path, kind, size_bytes FROM system_map_nodes ORDER BY path')
      .all() as { path: string; kind: string; size_bytes: number }[];
    expect(stored.map((row) => row.path)).toEqual(['/home/buster', '/home/buster/notes.txt']);
    expect(stored[1].size_bytes).toBe(10);
  });

  it('replaces a previous map rather than accumulating duplicates', () => {
    const db = freshDb();
    replaceSnapshot(
      db,
      { schemaVersion: 1, builtAt: 1, updatedAt: 1, rootCount: 1, inventory: '{}' },
      [node({ path: '/a.txt' })],
    );
    replaceSnapshot(
      db,
      { schemaVersion: 1, builtAt: 2, updatedAt: 2, rootCount: 1, inventory: '{}' },
      [node({ path: '/b.txt' })],
    );

    const stored = db.prepare('SELECT path FROM system_map_nodes').all() as { path: string }[];
    expect(stored.map((row) => row.path)).toEqual(['/b.txt']);
  });
});

describe('a delta is applied, not replayed', () => {
  it('adds and updates without touching what did not change', () => {
    const db = freshDb();
    replaceSnapshot(
      db,
      { schemaVersion: 1, builtAt: 1, updatedAt: 1, rootCount: 1, inventory: '{}' },
      [node({ path: '/keep.txt', size_bytes: 10 })],
    );

    applyDelta(db, {
      added: [node({ path: '/new.txt', size_bytes: 20 })],
      updated: [node({ path: '/keep.txt', size_bytes: 99 })],
      removed: [],
      renamed: [],
    });

    const stored = db
      .prepare('SELECT path, size_bytes FROM system_map_nodes ORDER BY path')
      .all() as { path: string; size_bytes: number }[];
    expect(stored).toEqual([
      { path: '/keep.txt', size_bytes: 99 },
      { path: '/new.txt', size_bytes: 20 },
    ]);
  });

  it('removes a whole subtree when the folder above it goes', () => {
    const db = freshDb();
    replaceSnapshot(
      db,
      { schemaVersion: 1, builtAt: 1, updatedAt: 1, rootCount: 1, inventory: '{}' },
      [
        node({ path: '/home/buster', name: 'buster', kind: 'directory', extension: null, file_type: 'other', depth: 0 }),
        node({ path: '/home/buster/keep.txt' }),
        node({ path: '/home/buster/old', name: 'old', kind: 'directory', extension: null, file_type: 'other' }),
        node({ path: '/home/buster/old/a.txt', parent_path: '/home/buster/old', depth: 2 }),
        node({ path: '/home/buster/old/deep/b.txt', parent_path: '/home/buster/old/deep', depth: 3 }),
      ],
    );

    applyDelta(db, { added: [], updated: [], removed: ['/home/buster/old'], renamed: [] });

    // One removal statement took three rows with it. A delete that removed only
    // the path it was handed would leave orphans that no future pass could ever
    // reach, because nothing would still know their parent had gone.
    const stored = db.prepare('SELECT path FROM system_map_nodes ORDER BY path').all() as { path: string }[];
    expect(stored.map((row) => row.path)).toEqual(['/home/buster', '/home/buster/keep.txt']);
  });

  it('applies a rename as a move rather than a delete and an insert', () => {
    const db = freshDb();
    replaceSnapshot(
      db,
      { schemaVersion: 1, builtAt: 1, updatedAt: 1, rootCount: 1, inventory: '{}' },
      [node({ path: '/old/notes.txt', parent_path: '/old' })],
    );

    applyDelta(db, {
      added: [],
      updated: [],
      removed: [],
      renamed: [{ from: '/old/notes.txt', to: '/new/notes.txt' }],
    });

    const stored = db
      .prepare('SELECT path, parent_path FROM system_map_nodes')
      .all() as { path: string; parent_path: string }[];
    expect(stored).toEqual([{ path: '/new/notes.txt', parent_path: '/new' }]);
  });

  it('replaces the inventory without rewriting the nodes', () => {
    const db = freshDb();
    replaceSnapshot(
      db,
      { schemaVersion: 1, builtAt: 1, updatedAt: 1, rootCount: 1, inventory: '{}' },
      [node({ path: '/a.txt' })],
    );

    updateInventory(db, JSON.stringify({ applications: [{ id: 'app:x', name: 'x', path: '/x', scope: 'system' }], warnings: [] }), 1, 4_242);

    expect(countNodes(db)).toBe(1);
    const header = readSnapshot(db);
    expect(header?.updatedAt).toBe(4_242);
    expect(JSON.parse(header!.inventory).applications).toHaveLength(1);
  });
});

describe('the exclusions survive a restart', () => {
  it('reads back what was saved, and reports nothing before that', () => {
    const db = freshDb();
    expect(readExclusions(db)).toBeNull();

    const reviewed = {
      categories: [{ id: 'secrets', label: 'Passwords and key files', isDefault: true }],
      folders: [{ path: '/home/buster/Private' }],
    };
    writeExclusions(db, JSON.stringify(reviewed), 1_700_000_000_000);

    const saved = JSON.parse(readExclusions(db)!) as typeof reviewed;
    expect(saved.categories.map((entry) => entry.id)).toEqual(['secrets']);
    // A folder the user added by hand comes back, so Settings can re-open the
    // set exactly as they left it.
    expect(saved.folders).toEqual([{ path: '/home/buster/Private' }]);
  });
});

describe('a map is read back through the renderer contract', () => {
  it('reports no map before one exists, and one after a scan', async () => {
    const db = freshDb();
    const environment: SystemMapEnvironment = {
      platform: 'linux',
      homeDir: '/nonexistent-home',
      usersRoot: null,
      pathDirectories: [],
      roots: [],
      fs: nodeMetadataFs(),
      readSelectedRuntimeId: () => null,
      // No HTTP: asking a real Ollama would make this test wait out a real
      // network timeout to learn that there are no models, which is a test of
      // the network rather than of the store.
      listLocalModels: async () => [],
      // No binary probing either: the real discovery spawns each registered
      // adapter, which on a machine with omp installed takes seconds and makes a
      // store test a test of process startup.
      discoverRuntimes: async () => ({
        runtimes: [],
        installedRuntimeIds: [],
        selectedRuntimeId: null,
        discoveredAt: 0,
      }),
      // And no scan of the real `/usr/share/applications`, whose contents differ
      // per machine — a test asserting an empty app list must be empty because
      // the fixture is empty, not because the runner happens to have no apps.
      applicationDirectories: [],
    };

    expect(readSystemMapContents(db)).toBeNull();

    const built = await buildSystemMap(environment, { exclusions: defaultExclusions() }, db);
    expect(built.status).toBe('completed');

    const contents = readSystemMapContents(db);
    expect(contents).not.toBeNull();
    expect(contents?.fileCount).toBe(0);
    expect(contents?.apps).toEqual([]);
  });

  it('refuses to read a snapshot written by a different schema version', async () => {
    const db = freshDb();
    // A map from a future Henry, or a corrupted header.
    replaceSnapshot(
      db,
      { schemaVersion: 99, builtAt: 1, updatedAt: 1, rootCount: 1, inventory: '{}' },
      [node({ path: '/a.txt' })],
    );

    // Reported as no map rather than as a map with its classification dropped:
    // a half-understood map is worse than an absent one.
    expect(readSystemMapContents(db)).toBeNull();
  });

  it('survives a corrupt inventory row by still reporting the filesystem half', () => {
    const db = freshDb();
    replaceSnapshot(
      db,
      { schemaVersion: 1, builtAt: 1, updatedAt: 1, rootCount: 1, inventory: 'not json' },
      [node({ path: '/home/buster/a.txt', parent_path: '/home/buster' })],
    );

    const contents = readSystemMapContents(db);
    expect(contents?.fileCount).toBe(1);
    expect(contents?.apps).toEqual([]);
  });
});

describe('the second scan updates rather than rebuilding', () => {
  it('updates the stored map in place', async () => {
    const db = freshDb();
    const environment: SystemMapEnvironment = {
      platform: 'linux',
      homeDir: '/nonexistent-home',
      usersRoot: null,
      pathDirectories: [],
      // A root that does not exist: the test is about the store's update path,
      // and a missing folder is the honest fixture for "nothing to walk".
      roots: ['/nonexistent-root'],
      fs: nodeMetadataFs(),
      readSelectedRuntimeId: () => null,
      // No HTTP: asking a real Ollama would make this test wait out a real
      // network timeout to learn that there are no models, which is a test of
      // the network rather than of the store.
      listLocalModels: async () => [],
      // No binary probing either: the real discovery spawns each registered
      // adapter, which on a machine with omp installed takes seconds and makes a
      // store test a test of process startup.
      discoverRuntimes: async () => ({
        runtimes: [],
        installedRuntimeIds: [],
        selectedRuntimeId: null,
        discoveredAt: 0,
      }),
      // And no scan of the real `/usr/share/applications`, whose contents differ
      // per machine — a test asserting an empty app list must be empty because
      // the fixture is empty, not because the runner happens to have no apps.
      applicationDirectories: [],
    };

    await buildSystemMap(environment, { exclusions: defaultExclusions() }, db);
    db.prepare(
      'INSERT INTO system_map_nodes (path, parent_path, name, kind, extension, file_type, size_bytes, created_at, modified_at, depth, classification, classification_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      '/nonexistent-root/old.txt',
      '/nonexistent-root',
      'old.txt',
      'file',
      '.txt',
      'document',
      5,
      1,
      1,
      1,
      null,
      null,
    );
    db.prepare(
      'INSERT INTO system_map_nodes (path, parent_path, name, kind, extension, file_type, size_bytes, created_at, modified_at, depth, classification, classification_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      '/nonexistent-root',
      null,
      'nonexistent-root',
      'directory',
      null,
      'other',
      0,
      1,
      1,
      0,
      'other',
      'An ordinary folder.',
    );
    expect(countNodes(db)).toBe(2);

    const refreshed = await refreshSystemMap(
      environment,
      { exclusions: defaultExclusions() },
      db,
    );

    expect(refreshed.status).toBe('completed');
    // The recorded file's folder no longer exists, so the update removed it —
    // without a full rescan rebuilding the table from scratch.
    expect(countNodes(db)).toBe(0);
  });

  it('builds a map on refresh when there is nothing stored yet', async () => {
    const db = freshDb();
    const environment: SystemMapEnvironment = {
      platform: 'linux',
      homeDir: '/nonexistent-home',
      usersRoot: null,
      pathDirectories: [],
      roots: [],
      fs: nodeMetadataFs(),
      readSelectedRuntimeId: () => null,
      // No HTTP: asking a real Ollama would make this test wait out a real
      // network timeout to learn that there are no models, which is a test of
      // the network rather than of the store.
      listLocalModels: async () => [],
      // No binary probing either: the real discovery spawns each registered
      // adapter, which on a machine with omp installed takes seconds and makes a
      // store test a test of process startup.
      discoverRuntimes: async () => ({
        runtimes: [],
        installedRuntimeIds: [],
        selectedRuntimeId: null,
        discoveredAt: 0,
      }),
      // And no scan of the real `/usr/share/applications`, whose contents differ
      // per machine — a test asserting an empty app list must be empty because
      // the fixture is empty, not because the runner happens to have no apps.
      applicationDirectories: [],
    };

    // A refresh with no map behind it must not report "nothing to update"; it
    // builds one, or the user's first click after a reset would look like a
    // silent no-op.
    const result = await refreshSystemMap(environment, { exclusions: defaultExclusions() }, db);
    expect(result.status).toBe('completed');
    expect(readSnapshot(db)).not.toBeNull();
  });
});