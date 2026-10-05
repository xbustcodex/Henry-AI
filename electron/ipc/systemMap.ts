/**
 * System Map — IPC.
 *
 * Channels (matched by preload.ts):
 *   systemMap:exclusions       — read the reviewed exclusion set
 *   systemMap:exclusions/save  — persist it, so Settings can re-open it
 *   systemMap:scan/start       — build or refresh the map
 *   systemMap:scan/cancel      — stop a running scan
 *   systemMap:contents         — the stored map, or null
 *   systemMap:progress         — main → renderer progress events
 *
 * ── The rules this boundary holds ───────────────────────────────────────────
 *
 *   - **A scan starts only from a call.** Nothing here kicks one off on launch
 *     or on a timer; `systemMap:scan/start` is the single door, and it is
 *     called from a button the user pressed.
 *   - **The exclusions passed in are the exclusions used.** Not merged with
 *     "extra" defaults, not re-expanded. A category the user removed is
 *     genuinely scanned, because a toggle that quietly restores itself is worse
 *     than no toggle.
 *   - **A cancelled scan leaves the stored map exactly as it was.** No partial
 *     write, no half-updated inventory.
 *   - **Nothing here selects a runtime.** A newly installed agent runtime is
 *     detected and returned as an OFFER; the user's stored selection is read
 *     through the read-only `SelectionReader` and echoed back untouched.
 *
 * The renderer asks over preload/contextBridge like everything else, so no Node
 * built-in reaches it.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import {
  defaultExclusions,
  type SystemMapContents,
  type SystemMapExclusions,
  type SystemMapScanOutcome,
} from '../../src/henry/systemMap';
import { exclusionsAreUnderstood } from '../systemmap/exclusions';
import { nodeMetadataFs } from '../systemmap/fsMetadata';
import { setUsersProbe } from '../systemmap/exclusions';
import {
  ensureSystemMapSchema,
  readExclusions,
  writeExclusions,
  type SystemMapDb,
} from '../systemmap/store';
import {
  buildSystemMap,
  readSystemMapContents,
  refreshSystemMap,
  ScanCancellation,
  type BuildResult,
  type SystemMapEnvironment,
} from '../systemmap/systemMap';
import { RUNTIME_SELECTION_KEY } from './agentRuntimes';

/** The database surface this module needs. Satisfied by `better-sqlite3`. */
type Db = SystemMapDb;

/** What the main process needs to know about the machine it is running on. */
export interface SystemMapHost extends SystemMapEnvironment {
  /** Base URL for the local model runtime, when one is configured. */
  ollamaBaseUrl?: string;
}

/** The channel progress events travel on. */
export const SYSTEM_MAP_PROGRESS_CHANNEL = 'systemMap:progress';

/**
 * The running scan, if any.
 *
 * A module-level singleton on purpose: a scan is a machine-wide resource, and
 * two concurrent scans of the same disk is exactly the load this whole module
 * exists to avoid.
 */
let activeScan: { cancel: ScanCancellation; promise: Promise<BuildResult> } | null = null;

/** Whether a scan is running right now. */
export function isScanning(): boolean {
  return activeScan !== null;
}

/**
 * Teach the exclusion rules how to list home directories.
 *
 * Installed once at registration with a real directory listing, so "someone
 * else's folder" is decided against the machine rather than against a guess.
 */
export function installUsersProbe(fs = nodeMetadataFs()): void {
  setUsersProbe(async (root) => {
    try {
      const entries = await fs.readDir(root);
      return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
    } catch {
      // An unreadable users root yields no other users rather than no map.
      return [];
    }
  });
}

/** Read the exclusion set the user last reviewed, or Henry's defaults. */
export function readSavedExclusions(db: Db): SystemMapExclusions {
  const saved = readExclusions(db);
  if (!saved) return defaultExclusions();
  try {
    const parsed = JSON.parse(saved) as SystemMapExclusions;
    if (!parsed || !Array.isArray(parsed.categories) || !Array.isArray(parsed.folders)) {
      return defaultExclusions();
    }
    return parsed;
  } catch {
    // A corrupt settings row falls back to the documented defaults rather than
    // failing the stage that shows them.
    return defaultExclusions();
  }
}

/** Persist a reviewed exclusion set. */
export function saveExclusions(db: Db, exclusions: SystemMapExclusions): boolean {
  try {
    writeExclusions(
      db,
      JSON.stringify({ categories: exclusions.categories, folders: exclusions.folders }),
      Date.now(),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a scan, replacing any scan already running.
 *
 * Starting a second scan cancels the first: two walks of the same disk at once
 * is precisely the resource exhaustion the budget exists to prevent, and the
 * newer request is the one the user actually asked for.
 */
async function runScan(
  db: Db,
  host: SystemMapHost,
  exclusions: SystemMapExclusions,
  emit: (progress: { foldersScanned: number; filesScanned: number; bytesScanned: number; totalFiles: number | null; currentFolder: string | null; appsFound: number; devToolsFound: number }) => void,
): Promise<BuildResult> {
  activeScan?.cancel.cancel();
  const cancel = new ScanCancellation();
  const hasMap = readSystemMapContents(db) !== null;

  const run = hasMap
    ? refreshSystemMap(host, { exclusions, signal: cancel.signal, onProgress: emit }, db)
    : buildSystemMap(host, { exclusions, signal: cancel.signal, onProgress: emit }, db);

  const promise = run.finally(() => {
    if (activeScan?.cancel === cancel) activeScan = null;
  });
  activeScan = { cancel, promise };
  return promise;
}

/**
 * Register the System Map channels.
 *
 * `host` describes the machine; `getMainWindow` is where progress events go.
 */
export function registerSystemMapHandlers(
  db: Db,
  host: SystemMapHost,
  getMainWindow: () => BrowserWindow | null,
): void {
  installUsersProbe(host.fs ?? nodeMetadataFs());
  ensureSystemMapSchema(db);

  ipcMain.handle('systemMap:exclusions', () => readSavedExclusions(db));

  ipcMain.handle('systemMap:exclusions/save', (_event, exclusions: SystemMapExclusions) => {
    if (!exclusions || !Array.isArray(exclusions.categories) || !Array.isArray(exclusions.folders)) {
      return false;
    }
    // An exclusion set carrying a category this process cannot enforce is
    // refused rather than silently narrowed: a scan that quietly ignored a
    // "do not look at this" would be a lie told to the user.
    if (!exclusionsAreUnderstood(exclusions)) return false;
    return saveExclusions(db, exclusions);
  });

  ipcMain.handle('systemMap:scan/start', async (_event, exclusions: SystemMapExclusions) => {
    try {
      if (!exclusions || !Array.isArray(exclusions.categories) || !Array.isArray(exclusions.folders)) {
        return { status: 'failed', error: 'The exclusion set was missing or malformed.' } satisfies SystemMapScanOutcome;
      }
      if (!exclusionsAreUnderstood(exclusions)) {
        return {
          status: 'failed',
          error: 'This exclusion set names something Henry cannot enforce, so the scan was not started.',
        } satisfies SystemMapScanOutcome;
      }

      const emit = (progress: {
        foldersScanned: number;
        filesScanned: number;
        bytesScanned: number;
        totalFiles: number | null;
        currentFolder: string | null;
        appsFound: number;
        devToolsFound: number;
      }): void => {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send(SYSTEM_MAP_PROGRESS_CHANNEL, { phase: 'scanning', ...progress });
      };

      const result = await runScan(db, host, exclusions, emit);
      if (result.status === 'cancelled') {
        return { status: 'cancelled' } satisfies SystemMapScanOutcome;
      }
      if (!result.contents) {
        return {
          status: 'failed',
          error: 'The scan finished but produced no map to show.',
        } satisfies SystemMapScanOutcome;
      }
      return { status: 'completed', contents: result.contents } satisfies SystemMapScanOutcome;
    } catch (e: unknown) {
      return {
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      } satisfies SystemMapScanOutcome;
    }
  });

  ipcMain.handle('systemMap:scan/cancel', () => {
    activeScan?.cancel.cancel();
  });

  ipcMain.handle('systemMap:contents', (): SystemMapContents | null =>
    readSystemMapContents(db),
  );
}

/**
 * The settings key holding the chosen agent runtime, for the read-only
 * selection reader the scan uses.
 *
 * The scan reads it and nothing writes it. That is the whole reason a scan can
 * record runtime offers without being able to activate one.
 */
export function selectionReaderFor(db: Db) {
  return {
    readSelectedRuntimeId: (): string | null => {
      const row = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(RUNTIME_SELECTION_KEY) as { value: string } | undefined;
      return row?.value || null;
    },
  };
}