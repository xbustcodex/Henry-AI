/**
 * Which agent runtime the user has chosen.
 *
 * This is the ONLY place a runtime selection is written, and it is written only
 * from an explicit user action. That separation is the whole point: discovery
 * reads this and reports it, and has no way to reach any writer here.
 *
 * No default is ever written. A fresh install has no selection, and keeps having
 * none until the user picks one — even on a machine where a runtime is installed
 * and working. Choosing is theirs to make.
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import type { SelectionReader } from '../runtimes/discovery';
import { discoverRuntimes } from '../runtimes/discovery';
import { getRuntimeAdapter } from '../runtimes/registry';

/** The narrow database surface this module needs: a settings table, nothing else. */
type Db = Pick<Database.Database, 'prepare'>;

/** Settings key holding the chosen runtime id. Empty/absent means "none". */
export const RUNTIME_SELECTION_KEY = 'agent_runtime';

function readSetting(db: Db, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    // A not-yet-created settings table means nothing has been chosen, which is
    // exactly what an absent value means.
    return null;
  }
}

/**
 * The stored selection, read through the read-only interface discovery takes.
 *
 * Note the type: `SelectionReader` has no write method. Passing `db` into
 * discovery therefore cannot give discovery a way to change the selection even
 * by accident.
 */
export function selectionReader(db: Db): SelectionReader {
  return {
    readSelectedRuntimeId: () => readSetting(db, RUNTIME_SELECTION_KEY),
  };
}

/** The chosen runtime id, or null when the user has chosen none. */
export function readSelectedRuntime(db: Db): string | null {
  return readSetting(db, RUNTIME_SELECTION_KEY) || null;
}

export type SelectRuntimeResult =
  | { ok: true; selectedRuntimeId: string | null }
  | { ok: false; error: string };

/**
 * Persist a runtime choice. Called only from an explicit user action.
 *
 * An empty id clears the selection — "use no external runtime" is a choice too,
 * and it is the honest answer for a user who has not opted in.
 *
 * An id that is not registered is refused rather than stored. Persisting a
 * selection Henry cannot honour would leave the settings panel claiming a
 * runtime the user cannot actually run.
 */
export function writeSelectedRuntime(db: Db, runtimeId: string): SelectRuntimeResult {
  const trimmed = (runtimeId ?? '').trim();
  if (trimmed && !getRuntimeAdapter(trimmed)) {
    return { ok: false, error: `Unknown agent runtime: ${trimmed}` };
  }
  try {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(RUNTIME_SELECTION_KEY, trimmed);
    return { ok: true, selectedRuntimeId: trimmed || null };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
// ── IPC ────────────────────────────────────────────────────────────────────
//
// Three channels, and the asymmetry between them is the invariant made visible
// at the boundary:
//
//   agentRuntimes:discover — READS the selection, never writes it.
//   agentRuntimes:selection — READS the selection.
//   agentRuntimes:select   — WRITES the selection, and only from a user action.
//
// The renderer goes through preload/contextBridge for all three, so no Node
// built-in ever reaches the renderer.

/**
 * IPC for runtime discovery and selection.
 *
 * `agentRuntimes:discover` is deliberately given only `selectionReader(db)` —
 * an object with a single read method — so there is no writer in scope for it to
 * call. `discoveryDoesNotMutateStoredSelection` asserts that end to end.
 */
export function registerAgentRuntimeHandlers(db: Db): void {
  ipcMain.handle('agentRuntimes:discover', async (_event, opts?: { includeModels?: boolean }) => {
    try {
      return await discoverRuntimes(selectionReader(db), {
        includeModels: opts?.includeModels === true,
      });
    } catch (e: unknown) {
      // A discovery failure must not look like "nothing is installed": that is
      // the read a user would act on. Say what went wrong instead.
      return {
        error: e instanceof Error ? e.message : String(e),
        runtimes: [],
        installedRuntimeIds: [],
        selectedRuntimeId: readSelectedRuntime(db),
        discoveredAt: Date.now(),
      };
    }
  });

  ipcMain.handle('agentRuntimes:selection', async () => readSelectedRuntime(db));

  ipcMain.handle('agentRuntimes:select', async (_event, runtimeId: string) =>
    writeSelectedRuntime(db, runtimeId ?? ''),
  );
}
