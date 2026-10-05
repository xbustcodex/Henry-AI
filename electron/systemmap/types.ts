/**
 * The System Map schema — what Henry persists about a machine.
 *
 * ── The invariant every other module in this folder exists to protect ───────
 *
 * **A node row is metadata. It is never file content.**
 *
 * There is deliberately no field anywhere in this file that could hold the
 * bytes of a file, a preview of its first lines, a text extract, an embedding
 * or a summary. That is not a stylistic preference: on a real machine a
 * content-ingesting inventory would pull SSH keys, browser profiles, password
 * databases, `.env` files and private documents into a store the user never
 * asked to build. Making content inexpressible in the type means a future
 * contributor cannot add it by accident — there is nowhere to put it.
 *
 * Content indexing is a different, later, explicitly user-directed action, and
 * it does not belong here.
 *
 * ── What a node IS ──────────────────────────────────────────────────────────
 *
 * One row per directory and per file, carrying names, kinds, sizes, dates and
 * the relationship to the folder that contains it (`parentPath`). A folder is
 * additionally *classified* from those facts alone — from its name, its
 * children's names and the markers a project leaves on disk. No classifier here
 * opens a file.
 */

// ── Schema version ───────────────────────────────────────────────────────────

/**
 * Bumped when the persisted shape changes incompatibly.
 *
 * Stored alongside the rows. A snapshot written by an older Henry is detected
 * and rebuilt rather than misread — a map that silently loses its
 * classification would be worse than one that admits it is stale.
 */
export const SYSTEM_MAP_SCHEMA_VERSION = 1;

// ── File typing ──────────────────────────────────────────────────────────────

/**
 * What kind of thing a file is, inferred from its name alone.
 *
 * Extension-driven on purpose: it is the only signal available without reading
 * the file, and it is enough to answer "where are my PDFs and my videos".
 */
export type SystemMapFileType =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'text'
  | 'code'
  | 'config'
  | 'data'
  | 'database'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'executable'
  | 'library'
  | 'model'
  | 'font'
  | 'log'
  | 'other';

/** One node of the map: a directory or a file. Metadata, never contents. */
export interface SystemMapNode {
  /** Absolute, normalised path. The primary key. */
  path: string;
  /** The folder that contains this node. `null` only for a scan root. */
  parentPath: string | null;
  /** Base name, no directory part. */
  name: string;
  kind: 'file' | 'directory';
  /** Lower-case with the dot, e.g. `.ts`. `null` when the name has none. */
  extension: string | null;
  /** Kind of thing this file is, from its name alone. */
  fileType: SystemMapFileType;
  /** Size in bytes. Zero for directories (they have no meaningful one). */
  sizeBytes: number;
  /**
   * Creation time in epoch ms when the platform reports one, else `null`.
   *
   * `null` is honest: several Linux filesystems do not record one, and a zero
   * would read as "born at the epoch".
   */
  createdAt: number | null;
  /** Last modification, epoch ms. Drives the incremental sweep. */
  modifiedAt: number;
  /** Distance from the scan root. */
  depth: number;
  /** Directories only: what this folder is. */
  classification?: DirectoryClassification;
  /** Directories only: the evidence behind that classification, in words. */
  classificationReason?: string;
}

/**
 * What a folder IS, decided from metadata and naming conventions only.
 *
 * `other` is a real answer, not a failure: most folders on a machine are
 * ordinary folders and labelling them as something would be a lie.
 */
export type DirectoryClassification =
  | 'project'
  | 'git-repository'
  | 'documents'
  | 'applications'
  | 'model-store'
  | 'media'
  | 'cache'
  | 'user-data'
  | 'system'
  | 'other';

// ── Inventory sections ───────────────────────────────────────────────────────

/** A mounted drive or volume. */
export interface VolumeInfo {
  /** Stable id, e.g. `root`, `C:`, `/Volumes/Data`. */
  id: string;
  label: string;
  root: string;
  filesystem?: string;
  totalBytes?: number;
  freeBytes?: number;
}

/** A place the user's own work lives. Recorded so Henry can say "your files". */
export interface UserLocation {
  id: string;
  /** Plain-English name, e.g. "Documents". Never a raw path alone. */
  label: string;
  path: string;
  kind: 'home' | 'desktop' | 'documents' | 'downloads' | 'pictures' | 'music' | 'videos' | 'projects';
  exists: boolean;
}

/** One installed application, as the platform's own metadata describes it. */
export interface InstalledApplication {
  id: string;
  name: string;
  version?: string;
  path: string;
  /** Where it came from: a system-wide location or a per-user one. */
  scope: 'system' | 'user';
}

/** An executable sitting on PATH. Metadata: name, where, when it changed. */
export interface PathExecutable {
  name: string;
  path: string;
  /** The PATH directory it was found in. */
  directory: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** What kind of tool a development tool is. */
export type DevelopmentToolKind =
  | 'language'
  | 'build'
  | 'version-control'
  | 'container'
  | 'package-manager'
  | 'agent-runtime'
  | 'other';

/** A developer tool found on PATH, with a probed version when one answers. */
export interface DevelopmentTool {
  id: string;
  name: string;
  kind: DevelopmentToolKind;
  version?: string;
  path?: string;
}

/** A language runtime/compiler found on PATH. */
export interface LanguageRuntime {
  id: string;
  name: string;
  version?: string;
  path?: string;
}

/** One running service/process. Name and state, never arguments or memory. */
export interface ServiceInfo {
  name: string;
  pid: number | null;
  /** Running / sleeping / stopped, as the platform reports it. */
  state?: string;
}

/** Hardware and OS facts. */
export interface HardwareInfo {
  osName: string;
  osRelease: string;
  platform: string;
  arch: string;
  cpuModel?: string;
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  uptimeSeconds?: number;
}

/** A locally available AI model, from the runtime that actually reports it. */
export interface LocalModelInfo {
  id: string;
  name: string;
  /** Where the fact came from. Never a static catalogue. */
  source: 'ollama' | 'model-store';
  sizeBytes?: number;
  family?: string;
}

/**
 * What runtime discovery saw, recorded verbatim.
 *
 * `selected` mirrors the user's stored choice and is copied, never written.
 */
export interface RuntimeObservation {
  id: string;
  displayName: string;
  available: boolean;
  version?: string;
  binaryPath?: string;
  /** Whether the user had chosen this runtime. Reported, never changed. */
  selected: boolean;
}

/**
 * A runtime that has appeared since the last snapshot, offered to the user.
 *
 * An offer is a question, not an answer. Nothing in this file, in the store or
 * in the scan path writes a runtime selection: choosing is the user's act, made
 * through the runtime panel.
 */
export interface RuntimeOffer {
  runtimeId: string;
  displayName: string;
  version?: string;
  binaryPath?: string;
  reason: 'newly-available';
  /** The user's current selection, echoed for the offer to be shown against. */
  currentSelection: string | null;
}


/**
 * Everything that is not a filesystem node: what is installed, what is running,
 * what the hardware is, what the local runtime holds, and what runtime
 * discovery saw.
 */
export interface SystemMapInventory {
  volumes: VolumeInfo[];
  userLocations: UserLocation[];
  applications: InstalledApplication[];
  pathExecutables: PathExecutable[];
  developmentTools: DevelopmentTool[];
  languageRuntimes: LanguageRuntime[];
  services: ServiceInfo[];
  hardware: HardwareInfo | null;
  localModels: LocalModelInfo[];
  runtimes: RuntimeObservation[];
  runtimeOffers: RuntimeOffer[];
  /** The exclusion category ids that were in force for this scan. */
  exclusionsApplied: string[];
  /** Folder paths the user excluded by hand. */
  exclusionFolders: string[];
  /**
   * Everything that was thinner than it should have been, in plain words.
   *
   * Present because a map that silently omits a section reads as "you have no
   * processes" when the truth is "the process list could not be read". Each
   * warning names the section that degraded and why, so the UI can say so
   * rather than showing a confident zero.
   */
  warnings: string[];
}
// ── Snapshot ─────────────────────────────────────────────────────────────────

/** How a scan finished, including every place it had to stop short. */
export interface ScanStats {
  foldersScanned: number;
  filesScanned: number;
  bytesScanned: number;
  /** Which budget limits were hit, in words. Empty when none were. */
  truncations: string[];
  durationMs: number;
  /** True when a cancel arrived and the partial map was discarded. */
  cancelled: boolean;
}

/** Everything about the machine that is not a filesystem node. */
export interface SystemMapInventory {
  volumes: VolumeInfo[];
  userLocations: UserLocation[];
  applications: InstalledApplication[];
  pathExecutables: PathExecutable[];
  developmentTools: DevelopmentTool[];
  languageRuntimes: LanguageRuntime[];
  services: ServiceInfo[];
  hardware: HardwareInfo | null;
  localModels: LocalModelInfo[];
  runtimes: RuntimeObservation[];
  runtimeOffers: RuntimeOffer[];
  /** The exclusion category ids that were in force for this scan. */
  exclusionsApplied: string[];
  /** Folder paths the user excluded by hand. */
  exclusionFolders: string[];
}

/** The single-row header of a persisted snapshot. */
export interface SystemMapSnapshotMeta {
  schemaVersion: number;
  builtAt: number;
  updatedAt: number;
  /** How many scan roots the node table was built from. */
  rootCount: number;
  inventory: SystemMapInventory;
}

// ── Progress ─────────────────────────────────────────────────────────────────

/**
 * Live scan progress.
 *
 * `totalFiles` stays `null` until enumeration is complete. A progress bar drawn
 * against an invented total is a lie about work that has not happened.
 */
export interface ScanProgress {
  phase: 'scanning' | 'enumerating' | 'inventory' | 'done';
  foldersScanned: number;
  filesScanned: number;
  bytesScanned: number;
  totalFiles: number | null;
  currentFolder: string | null;
  appsFound: number;
  devToolsFound: number;
}

// ── Budget ───────────────────────────────────────────────────────────────────

/**
 * The resource ceiling for one scan.
 *
 * Defaults are chosen for a machine with hundreds of thousands of files: the
 * scan must degrade (recording what it hit and why) rather than exhaust memory,
 * the event loop or the disk.
 */
export interface ScanBudget {
  /** Deepest folder level walked. */
  maxDepth: number;
  /** Entries considered in a single directory before the rest are skipped. */
  maxEntriesPerDirectory: number;
  /** Hard ceiling on nodes recorded for the whole scan. */
  maxNodes: number;
  /** Hard ceiling on directories visited. */
  maxDirectories: number;
  /** Directory listings read in parallel. */
  concurrency: number;
  /** Wall-clock ceiling; the scan stops cleanly and records why. */
  maxDurationMs: number;
}

/** Conservative defaults. A 40-year-old laptop finishes inside these. */
export const DEFAULT_SCAN_BUDGET: ScanBudget = {
  maxDepth: 8,
  maxEntriesPerDirectory: 5_000,
  maxNodes: 250_000,
  maxDirectories: 40_000,
  concurrency: 8,
  maxDurationMs: 120_000,
};

/** Why a scan stopped before it had finished everything. */
export interface CancellationLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}