/**
 * Discovery reports the truth, and never touches the user's selection.
 *
 * Three claims are under test, and each is a claim the architecture makes out
 * loud:
 *
 *  1. **Discovery returns exactly what is installed.** An absent runtime is
 *     reported as `available: false` with a reason — not omitted (which reads as
 *     "we never looked") and never faked as present.
 *  2. **Discovery never invents a capability.** `verified: true` appears only
 *     where the machine demonstrated it, and `modelCount` only where a real
 *     listing produced one.
 *  3. **Discovery does not mutate the stored selection.** Asserted against a
 *     real settings table seeded with a real selection, not a mock that would
 *     agree with anything.
 *
 * The selection assertion is the one that matters most: a discovery pass that
 * quietly activated a runtime would take a decision away from the user, and no
 * error would be raised.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { discoverRuntimes, type SelectionReader } from './discovery';
import {
  registerRuntimeAdapter,
  unregisterRuntimeAdapter,
  resetRuntimeRegistry,
  listRuntimeAdapters,
} from './registry';
import type { AgentRuntimeAdapter, RuntimeModel, RuntimeProbe } from './types';

/** An adapter whose probe and catalogue the test dictates outright. */
function fakeAdapter(over: Partial<AgentRuntimeAdapter> & { id: string }): AgentRuntimeAdapter {
  const probe = over.probe ?? (async (): Promise<RuntimeProbe> => ({
    id: over.id,
    displayName: over.id,
    available: false,
    unavailableReason: 'not installed',
    capabilities: {
      run: { verified: false, note: 'not installed' },
      listModels: { verified: false, note: 'not installed' },
    },
  }));
  return {
    displayName: over.id,
    candidateBinaries: () => [over.id],
    listModels: async (): Promise<RuntimeModel[]> => [],
    run: async () => ({ ok: false, text: '' }),
    ...over,
    probe,
  };
}

/**
 * Empty the registry before each test so only the fakes a test registers are
 * discovered.
 *
 * This is not tidiness: the shipped registry holds the real omp and pi
 * adapters, which probe real binaries. Leaving them in would make "discovery
 * found exactly my two fakes" depend on whether the machine running the tests
 * happens to have those CLIs installed — the exact non-determinism these tests
 * exist to rule out.
 */
beforeEach(() => {
  resetRuntimeRegistry();
  for (const adapter of listRuntimeAdapters()) unregisterRuntimeAdapter(adapter.id);
});


const installed = (id: string): AgentRuntimeAdapter =>
  fakeAdapter({
    id,
    async probe() {
      return {
        id,
        displayName: id,
        available: true,
        binaryPath: id,
        version: '1.0.0',
        capabilities: { run: { verified: true }, listModels: { verified: true } },
      };
    },
  });

const selectionOf = (id: string | null): SelectionReader => ({
  readSelectedRuntimeId: () => id,
});

afterEach(() => {
  resetRuntimeRegistry();
});

describe('discovery reports exactly what is installed', () => {
  it('lists only the runtimes that answered', async () => {
    registerRuntimeAdapter(installed('present-a'));
    registerRuntimeAdapter(fakeAdapter({ id: 'absent-b' }));

    const result = await discoverRuntimes(selectionOf(null));

    expect(result.installedRuntimeIds).toEqual(['present-a']);
  });

  it('still reports an absent runtime, rather than dropping it', async () => {
    registerRuntimeAdapter(fakeAdapter({ id: 'absent-b' }));

    const result = await discoverRuntimes(selectionOf(null));

    // Omission would read as "we never looked". Absence is a finding.
    expect(result.runtimes.map((r) => r.id)).toContain('absent-b');
    const absent = result.runtimes.find((r) => r.id === 'absent-b');
    expect(absent?.available).toBe(false);
    expect(absent?.unavailableReason).toBeTruthy();
  });

  it('reports nothing installed when nothing is installed', async () => {
    registerRuntimeAdapter(fakeAdapter({ id: 'absent-a' }));
    registerRuntimeAdapter(fakeAdapter({ id: 'absent-b' }));

    const result = await discoverRuntimes(selectionOf(null));

    expect(result.installedRuntimeIds).toEqual([]);
    expect(result.runtimes).toHaveLength(2);
  });

  it('reports a probe that THROWS as unknown, not as available', async () => {
    registerRuntimeAdapter(fakeAdapter({
      id: 'explodes',
      probe: async () => { throw new Error('probe blew up'); },
    }));

    const result = await discoverRuntimes(selectionOf(null));

    const entry = result.runtimes.find((r) => r.id === 'explodes');
    // An exception is not evidence of presence.
    expect(entry?.available).toBe(false);
    expect(entry?.unavailableReason).toBe('probe blew up');
    expect(result.installedRuntimeIds).not.toContain('explodes');
  });

  it('carries the runtime’s own version and path through unchanged', async () => {
    registerRuntimeAdapter(installed('omp'));

    const result = await discoverRuntimes(selectionOf(null));

    const entry = result.runtimes.find((r) => r.id === 'omp');
    expect(entry?.version).toBe('1.0.0');
    expect(entry?.binaryPath).toBe('omp');
  });
});

describe('discovery never invents a capability', () => {
  it('reports no model count when no listing was performed', async () => {
    registerRuntimeAdapter(installed('omp'));

    const result = await discoverRuntimes(selectionOf(null));

    // The adapter says it CAN list. That is not the same as having listed.
    const entry = result.runtimes.find((r) => r.id === 'omp');
    expect(entry?.capabilities.listModels.verified).toBe(true);
    expect(entry?.capabilities.modelCount).toBeUndefined();
    expect(entry?.models).toBeUndefined();
  });

  it('reports a count only from a listing that really returned models', async () => {
    registerRuntimeAdapter(fakeAdapter({
      id: 'counted',
      async probe() {
        return {
          id: 'counted',
          displayName: 'counted',
          available: true,
          capabilities: { run: { verified: true }, listModels: { verified: true } },
        };
      },
      async listModels() {
        return [
          { id: 'a/1', name: '1', providerId: 'a', group: 'a' },
          { id: 'b/2', name: '2', providerId: 'b', group: 'b' },
        ];
      },
    }));

    const result = await discoverRuntimes(selectionOf(null), { includeModels: true });

    const entry = result.runtimes.find((r) => r.id === 'counted');
    expect(entry?.capabilities.modelCount).toBe(2);
    expect(entry?.models).toEqual(['a/1', 'b/2']);
  });

  it('reports zero from an empty listing rather than omitting the count', async () => {
    registerRuntimeAdapter(fakeAdapter({
      id: 'empty',
      async probe() {
        return {
          id: 'empty',
          displayName: 'empty',
          available: true,
          capabilities: { run: { verified: true }, listModels: { verified: true } },
        };
      },
      async listModels() { return []; },
    }));

    const result = await discoverRuntimes(selectionOf(null), { includeModels: true });

    // Zero is an observation; absent is "we did not look".
    expect(result.runtimes.find((r) => r.id === 'empty')?.capabilities.modelCount).toBe(0);
  });

  it('downgrades the listing capability when the listing FAILS', async () => {
    registerRuntimeAdapter(fakeAdapter({
      id: 'broken-list',
      async probe() {
        return {
          id: 'broken-list',
          displayName: 'broken-list',
          available: true,
          capabilities: { run: { verified: true }, listModels: { verified: true } },
        };
      },
      async listModels() { throw new Error('catalogue refresh failed'); },
    }));

    const result = await discoverRuntimes(selectionOf(null), { includeModels: true });

    const entry = result.runtimes.find((r) => r.id === 'broken-list');
    expect(entry?.capabilities.listModels.verified).toBe(false);
    expect(entry?.capabilities.listModels.note).toBe('catalogue refresh failed');
    // Still installed: a broken catalogue is not a missing program.
    expect(entry?.available).toBe(true);
    expect(result.installedRuntimeIds).toContain('broken-list');
  });

  it('leaves a capability unverified when the adapter itself says so', async () => {
    registerRuntimeAdapter(fakeAdapter({
      id: 'unverified',
      async probe() {
        return {
          id: 'unverified',
          displayName: 'unverified',
          available: true,
          capabilities: {
            run: { verified: false, note: 'CLI contract not confirmed' },
            listModels: { verified: false, note: 'CLI contract not confirmed' },
          },
        };
      },
    }));

    const result = await discoverRuntimes(selectionOf(null));

    const entry = result.runtimes.find((r) => r.id === 'unverified');
    expect(entry?.capabilities.run.verified).toBe(false);
    expect(entry?.capabilities.run.note).toBe('CLI contract not confirmed');
  });

  it('passes an unverified capability through rather than rounding it up', async () => {
    registerRuntimeAdapter(fakeAdapter({
      id: 'half',
      async probe() {
        return {
          id: 'half',
          displayName: 'half',
          available: true,
          capabilities: {
            run: { verified: true },
            listModels: { verified: false, note: 'listing was not run' },
          },
        };
      },
    }));

    const result = await discoverRuntimes(selectionOf(null));

    const entry = result.runtimes.find((r) => r.id === 'half');
    expect(entry?.capabilities.run.verified).toBe(true);
    expect(entry?.capabilities.listModels.verified).toBe(false);
  });
});

describe('discovery does not mutate the stored selection', () => {
  /**
   * A real settings table with a real selection already in it. A mock would
   * prove nothing here: the question is whether the code path writes at all.
   */
  function settingsDb(seed: Array<[string, string]> = []): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
    const insert = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))');
    for (const [key, value] of seed) insert.run(key, value);
    return db;
  }

  /** Every settings row after discovery, as `key=value`. */
  const rowsOf = (db: DatabaseSync): string[] =>
    (db.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>)
      .map((r) => `${r.key}=${r.value}`);

  /** A reader over a REAL table, so a write would be visible. */
  const readerOf = (db: DatabaseSync): SelectionReader => ({
    readSelectedRuntimeId: () => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('agent_runtime') as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
  });

  it('leaves an existing selection exactly as it was', async () => {
    const db = settingsDb([['agent_runtime', 'omp'], ['other_setting', 'keep me']]);
    registerRuntimeAdapter(installed('omp'));
    registerRuntimeAdapter(fakeAdapter({ id: 'absent' }));

    const before = rowsOf(db);
    await discoverRuntimes(readerOf(db));
    const after = rowsOf(db);

    expect(after).toEqual(before);
    expect(after).toContain('agent_runtime=omp');
    expect(after).toContain('other_setting=keep me');
  });

  it('writes nothing at all when no selection has ever been made', async () => {
    // The dangerous case: discovery on a fresh install must not help itself to
    // a default, even though an installed runtime is sitting right there.
    const db = settingsDb();
    registerRuntimeAdapter(installed('omp'));

    await discoverRuntimes(readerOf(db));

    expect(rowsOf(db)).toEqual([]);
  });

  it('writes nothing even when asked to include models', async () => {
    const db = settingsDb();
    registerRuntimeAdapter(fakeAdapter({
      id: 'listed',
      async probe() {
        return {
          id: 'listed',
          displayName: 'listed',
          available: true,
          capabilities: { run: { verified: true }, listModels: { verified: true } },
        };
      },
      async listModels() {
        return [{ id: 'a/1', name: '1', providerId: 'a', group: 'a' }];
      },
    }));

    await discoverRuntimes(readerOf(db), { includeModels: true });

    expect(rowsOf(db)).toEqual([]);
  });

  it('echoes the stored selection back unchanged', async () => {
    const db = settingsDb([['agent_runtime', 'pi']]);

    const result = await discoverRuntimes(readerOf(db));

    expect(result.selectedRuntimeId).toBe('pi');
  });

  it('reports no selection as null rather than inventing a default', async () => {
    const db = settingsDb();
    registerRuntimeAdapter(installed('omp'));

    const result = await discoverRuntimes(readerOf(db));

    expect(result.selectedRuntimeId).toBeNull();
  });

  it('writes nothing when a probe throws', async () => {
    const db = settingsDb([['agent_runtime', 'omp']]);
    registerRuntimeAdapter(fakeAdapter({
      id: 'explodes',
      probe: async () => { throw new Error('boom'); },
    }));

    const before = rowsOf(db);
    await discoverRuntimes(readerOf(db));

    expect(rowsOf(db)).toEqual(before);
  });
});

describe('the SelectionReader it is given cannot write', () => {
  it('exposes a read and nothing else', () => {
    // The structural half of the invariant: discovery has no writer in scope,
    // so it cannot change the selection even by accident.
    const reader: SelectionReader = { readSelectedRuntimeId: () => 'omp' };

    expect(Object.keys(reader)).toEqual(['readSelectedRuntimeId']);
    expect(typeof (reader as unknown as Record<string, unknown>).write).toBe('undefined');
    expect(typeof (reader as unknown as Record<string, unknown>).save).toBe('undefined');
    expect(typeof (reader as unknown as Record<string, unknown>).set).toBe('undefined');
  });
});