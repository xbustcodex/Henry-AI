/**
 * System Map — renderer side.
 *
 * The System Map is a one-time, consent-based inventory of this computer: its
 * drives, applications, folders, files, development tools and AI software. Its
 * entire reason to exist is that Henry should stop rediscovering the same
 * machine on every conversation.
 *
 * ── The three promises this file is shaped around ──────────────────────────
 *
 * 1. **Nothing is read without consent.** Every entry point here is either a
 *    read of something the user already built, or a call the user pressed a
 *    button for. There is no scan-on-mount, no scan-on-refresh.
 *
 * 2. **Exclusions are decided by the user, before the scan starts.**
 *    `getSystemMapExclusions()` reports the current set; the user edits it;
 *    the edited set is what is handed to `startSystemMapScan`. The backend
 *    receives exactly the exclusions the user reviewed.
 *
 * 3. **File contents are never read.** The map records file NAMES, TYPES,
 *    SIZES and DATES. There is no function here that returns file content, and
 *    the UI says so in those words before the scan runs.
 *
 * No Node built-in reaches this module — asking "what is on this disk?" is a
 * privileged question, asked over IPC exactly the way a screenshot is.
 */

// ── Exclusions ───────────────────────────────────────────────────────────────

/** One category of thing the scan will not look at, described in plain words. */
export interface SystemMapExclusionCategory {
  /** Stable id the main process matches against. */
  id: string;
  /**
   * Plain, non-technical wording, shown verbatim to the user. "Other people's
   * folders", never `/home/*`.
   */
  label: string;
  /**
   * Henry excludes this category out of the box. The user may still choose to
   * include it; the flag only records where the suggestion came from.
   */
  isDefault: boolean;
}

/** A folder the user excluded by hand. */
export interface SystemMapFolderExclusion {
  path: string;
}

/** The exclusion set, exactly as the user reviewed it. */
export interface SystemMapExclusions {
  /** Categories currently excluded. Absent from this list ⇒ scanned. */
  categories: SystemMapExclusionCategory[];
  /** Folders the user added. Absolute paths. */
  folders: SystemMapFolderExclusion[];
}

/**
 * What Henry excludes unless the user says otherwise.
 *
 * This list is the product's opinion, expressed in the user's language rather
 * than in path globs. It lives here — not in the renderer components — because
 * it is part of the promise made on screen before anyone clicks, and it is used
 * verbatim when the main process is unavailable so the stage never renders an
 * empty, meaningless exclusion list.
 */
export const DEFAULT_EXCLUSION_CATEGORIES: readonly SystemMapExclusionCategory[] = [
  { id: 'otherUsers', label: "Other people's folders", isDefault: true },
  { id: 'secrets', label: 'Passwords and key files', isDefault: true },
  { id: 'browserProfiles', label: 'Browser profiles', isDefault: true },
  { id: 'systemFiles', label: 'System and application files', isDefault: true },
  { id: 'caches', label: 'Caches and temporary files', isDefault: true },
];

/** The exclusions a first launch starts from. */
export function defaultExclusions(): SystemMapExclusions {
  return {
    categories: DEFAULT_EXCLUSION_CATEGORIES.map((c) => ({ ...c })),
    folders: [],
  };
}

/**
 * The sentence shown before the scan, verbatim, in every surface.
 *
 * It is a constant rather than copy scattered across components so that the
 * claim "we do not read your files" has exactly one definition to be checked
 * against.
 */
export const CONTENTS_NEVER_READ =
  'Scanning records file names, types, sizes and dates — not file contents. Nothing inside your files is read, opened or stored.';

/** Drop a category back in (i.e. stop excluding it). */
export function includeCategory(
  exclusions: SystemMapExclusions,
  categoryId: string,
): SystemMapExclusions {
  return {
    ...exclusions,
    categories: exclusions.categories.filter((c) => c.id !== categoryId),
  };
}

/** Exclude a category again. Unknown ids are ignored rather than invented. */
export function excludeCategory(
  exclusions: SystemMapExclusions,
  category: SystemMapExclusionCategory,
): SystemMapExclusions {
  if (exclusions.categories.some((c) => c.id === category.id)) return exclusions;
  return { ...exclusions, categories: [...exclusions.categories, category] };
}

/** Add a user folder. Blank and duplicate paths are dropped. */
export function addFolderExclusion(
  exclusions: SystemMapExclusions,
  rawPath: string,
): SystemMapExclusions {
  const path = rawPath.trim();
  if (!path) return exclusions;
  if (exclusions.folders.some((f) => f.path === path)) return exclusions;
  return { ...exclusions, folders: [...exclusions.folders, { path }] };
}

/** Remove a user folder. */
export function removeFolderExclusion(
  exclusions: SystemMapExclusions,
  path: string,
): SystemMapExclusions {
  return { ...exclusions, folders: exclusions.folders.filter((f) => f.path !== path) };
}

/** True when the two sets would scan the same machine. Used by the tests. */
export function sameExclusions(a: SystemMapExclusions, b: SystemMapExclusions): boolean {
  if (a.categories.length !== b.categories.length) return false;
  if (a.folders.length !== b.folders.length) return false;
  if (!a.categories.every((c) => b.categories.some((o) => o.id === c.id))) return false;
  return a.folders.every((f) => b.folders.some((o) => o.path === f.path));
}

// ── Progress ─────────────────────────────────────────────────────────────────

/**
 * Live scan progress.
 *
 * `totalFiles` is null until enumeration has finished, because a scan that
 * invented a total to draw a progress bar against would be lying about work it
 * has not done. The UI shows an indeterminate bar until it becomes known.
 */
export interface SystemMapScanProgress {
  phase: 'scanning';
  foldersScanned: number;
  filesScanned: number;
  bytesScanned: number;
  /** Null while unknown; a number once enumeration has completed. */
  totalFiles: number | null;
  /** The folder being walked right now, for the "scanning…" sentence. */
  currentFolder: string | null;
  appsFound: number;
  devToolsFound: number;
}

// ── What the map contains ────────────────────────────────────────────────────

export interface SystemMapFolderSummary {
  path: string;
  label: string;
  fileCount: number;
  totalBytes: number;
}

export interface SystemMapEntrySummary {
  name: string;
  version?: string;
}

/** One piece of AI software the map found installed. */
export interface SystemMapAiSoftware extends SystemMapEntrySummary {
  id: string;
}

/**
 * The finished map.
 *
 * Every field is metadata. There is deliberately no field anywhere in this
 * interface that could hold the contents of a file.
 */
export interface SystemMapContents {
  builtAt: number;
  folders: SystemMapFolderSummary[];
  fileCount: number;
  totalBytes: number;
  apps: SystemMapEntrySummary[];
  devTools: SystemMapEntrySummary[];
  aiSoftware: SystemMapAiSoftware[];
  /** Counts by file extension, e.g. `{ type: '.ts', count: 812 }`. */
  fileTypes: { type: string; count: number }[];
}

export type SystemMapScanOutcome =
  | { status: 'completed'; contents: SystemMapContents }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string };

/**
 * A byte count as something a person can read.
 *
 * Binary units under decimal labels, because that is how disk sizes are
 * written everywhere else in the app. Zero reads as "0 B" rather than an empty
 * string, so a row never renders blank where a count belongs.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  return `${power === 0 ? value : value.toFixed(1)} ${units[power]}`;
}

// ── Bridge ───────────────────────────────────────────────────────────────────

interface SystemMapBridge {
  getSystemMapExclusions?: () => Promise<SystemMapExclusions>;
  saveSystemMapExclusions?: (exclusions: SystemMapExclusions) => Promise<boolean>;
  startSystemMapScan?: (exclusions: SystemMapExclusions) => Promise<SystemMapScanOutcome>;
  cancelSystemMapScan?: () => Promise<void>;
  getSystemMapContents?: () => Promise<SystemMapContents | null>;
  onSystemMapProgress?: (cb: (progress: SystemMapScanProgress) => void) => () => void;
}

function bridge(): SystemMapBridge | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window.henryAPI as unknown as SystemMapBridge | undefined);
}

/** True when this build can actually scan. A web build cannot. */
export function isSystemMapAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(bridge()?.getSystemMapContents);
}

/**
 * The exclusion set to review.
 *
 * Falls back to Henry's defaults when the main process is unavailable, so the
 * stage shows the real promise ("these are excluded by default") rather than
 * an empty list that implies nothing is protected.
 */
export async function getSystemMapExclusions(): Promise<SystemMapExclusions> {
  try {
    const res = await bridge()?.getSystemMapExclusions?.();
    if (res && Array.isArray(res.categories) && Array.isArray(res.folders)) return res;
  } catch {
    // Fall through to the documented defaults.
  }
  return defaultExclusions();
}

/** Persist a reviewed exclusion set so it can be re-opened and edited later. */
export async function saveSystemMapExclusions(
  exclusions: SystemMapExclusions,
): Promise<boolean> {
  try {
    return (await bridge()?.saveSystemMapExclusions?.(exclusions)) === true;
  } catch {
    return false;
  }
}

/**
 * Start a scan with the exclusions the user just reviewed.
 *
 * Only ever called from a button press. It reports; it does not decide.
 *
 * Resolves when the scan reaches a terminal state, so callers never infer
 * completion from the absence of progress events — a scan that dies quietly
 * has to be able to say `failed`.
 */
export async function startSystemMapScan(
  exclusions: SystemMapExclusions,
): Promise<SystemMapScanOutcome> {
  try {
    const outcome = await bridge()?.startSystemMapScan?.(exclusions);
    if (outcome && typeof outcome === 'object' && 'status' in outcome) {
      return outcome as SystemMapScanOutcome;
    }
    return {
      status: 'failed',
      error: 'The system map scanner is unavailable in this build.',
    };
  } catch (e: unknown) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Stop a running scan. The partial map is discarded, not half-saved. */
export async function cancelSystemMapScan(): Promise<void> {
  try {
    await bridge()?.cancelSystemMapScan?.();
  } catch {
    // Cancelling is best-effort: the user asked for it either way.
  }
}

/** The existing map, or null when one has never been built. */
export async function getSystemMapContents(): Promise<SystemMapContents | null> {
  try {
    return (await bridge()?.getSystemMapContents?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Subscribe to scan progress. Returns an unsubscribe function.
 *
 * A no-op subscription is returned when the build has no scanner, so a caller
 * never has to branch on availability just to clean up.
 */
export function onSystemMapProgress(
  handler: (progress: SystemMapScanProgress) => void,
): () => void {
  const sub = bridge()?.onSystemMapProgress?.(handler);
  return typeof sub === 'function' ? sub : () => {};
}