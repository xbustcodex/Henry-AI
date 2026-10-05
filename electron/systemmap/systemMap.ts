/**
 * The System Map, assembled.
 *
 * This module is the seam the IPC layer talks to. It owns the rules that hold
 * across every part of the scan, and it owns the promise the product makes:
 *
 *   - **One baseline scan, then incremental updates.** `buildSystemMap` is for
 *     the first scan; `refreshSystemMap` compares against what is stored.
 *   - **Metadata only.** The only filesystem capability in play is `MetadataFs`,
 *     which cannot read a file's bytes.
 *   - **Cancellable, and a cancelled scan leaves nothing behind.** The partial
 *     result is discarded rather than stored, because half a machine's map looks
 *     exactly like a whole one until someone is misled by it.
 *   - **A newly installed agent runtime is detected and offered, never selected.**
 *     The offer comes from the existing runtime-discovery architecture and the
 *     user's stored selection is echoed back untouched.
 */

import type { SystemMapExclusions, SystemMapContents } from '../../src/henry/systemMap';
import { defaultExclusions } from '../../src/henry/systemMap';
import { buildExclusionPolicy, exclusionsAreUnderstood, type ExclusionContext } from './exclusions';
import type { MetadataFs } from './fsMetadata';
import { nodeMetadataFs } from './fsMetadata';
import { collectInventory, type InventoryContext } from './inventory';
import { computeIncrementalDelta, type KnownDirectory, type KnownFile } from './incremental';
import { pathIsAtOrUnder, scanFilesystem } from './scanner';
import {
  applyDelta,
  countNodes,
  ensureSystemMapSchema,
  readSnapshot,
  replaceSnapshot,
  updateInventory,
  type StoredNode,
  type SystemMapDb,
} from './store';
import {
  SYSTEM_MAP_SCHEMA_VERSION,
  type CancellationLike,
  type LocalModelInfo,
  type ScanBudget,
  type ScanProgress,
  type SystemMapInventory,
  type SystemMapSnapshotMeta,
} from './types';

/** Everything one scan needs to know about the machine it is scanning. */
export interface SystemMapEnvironment {
  platform: NodeJS.Platform;
  homeDir: string;
  /** Where every user's home directory lives, when known. */
  usersRoot: string | null;
  /** Directories on PATH, in order. */
  pathDirectories: readonly string[];
  /** The roots to walk. Chosen by the caller, so a web build can pass none. */
  roots: readonly string[];
  fs?: MetadataFs;
  /** Base URL for the local model runtime. */
  ollamaBaseUrl?: string;
  /**
   * How the local model list is obtained. Defaults to asking the running
   * Ollama. Injectable so a caller that already knows the answer — or a test that
   * must not touch the network — does not have to go and ask again.
   */
  listLocalModels?: (baseUrl: string | undefined) => Promise<LocalModelInfo[]>;
  /**
   * Asks the agent-runtime adapters what is installed. Defaults to the real
   * discovery, which probes the actual binaries. Injectable so a caller that
   * already has the answer — or a test that must not spawn processes — can
   * supply it instead.
   */
  discoverRuntimes?: InventoryContext['discoverRuntimes'];
  /**
   * Where installed applications are recorded on this machine. Defaults to the
   * platform's own locations, including the XDG directories when the session
   * sets them.
   */
  applicationDirectories?: readonly string[];
  /** Reads the user's stored agent-runtime selection. Cannot write. */
  readSelectedRuntimeId: () => string | null | Promise<string | null>;
}

/** How a scan should run. */
export interface BuildOptions {
  exclusions: SystemMapExclusions;
  budget?: Partial<ScanBudget>;
  signal?: CancellationLike;
  onProgress?: (progress: ScanProgress) => void;
  now?: () => number;
}

/** What a completed scan produced. */
export interface BuildResult {
  status: 'completed' | 'cancelled';
  meta: SystemMapSnapshotMeta | null;
  nodes: StoredNode[];
  contents: SystemMapContents | null;
  /** Every place the scan had to stop short, in words. */
  truncations: string[];
  /** Paths the exclusions refused, for the UI to show. */
  excluded: { path: string; label: string; categoryId: string }[];
  /** Everything that degraded, in words. */
  warnings: string[];
}

/** A cancellation handle the IPC layer can trip. */
export class ScanCancellation {
  private controller = new AbortController();

  /** The signal the scan watches. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Ask the scan to stop. Idempotent. */
  cancel(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  /** True once cancelled. */
  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }
}

/** The exclusions this build understands, seeded from Henry's defaults. */
export function initialExclusions(): SystemMapExclusions {
  return defaultExclusions();
}

/**
 * Build the map from scratch and store it.
 *
 * `db` is optional so the scan itself can be exercised without a database; the
 * IPC layer always passes one.
 */
export async function buildSystemMap(
  environment: SystemMapEnvironment,
  options: BuildOptions,
  db?: SystemMapDb,
): Promise<BuildResult> {
  const fs = environment.fs ?? nodeMetadataFs();
  const exclusions = exclusionsAreUnderstood(options.exclusions)
    ? options.exclusions
    : initialExclusions();
  const context = exclusionContextFor(environment, exclusions);
  const policy = await buildExclusionPolicy(exclusions, context);

  const inventoryContext = inventoryContextFor(environment, fs);
  const outcome = await scanFilesystem(fs, {
    roots: environment.roots,
    policy,
    budget: options.budget,
    signal: options.signal,
    onProgress: options.onProgress,
    now: options.now,
  });

  const warnings: string[] = [];

  // A cancelled scan is DISCARDED. Nothing is stored, no contents are returned,
  // and the caller is told plainly that it was cancelled. Writing half a map
  // would leave a fileCount that looks like a fact about the machine.
  if (outcome.stats.cancelled) {
    return {
      status: 'cancelled',
      meta: null,
      nodes: [],
      contents: null,
      truncations: outcome.truncations,
      excluded: outcome.excluded,
      warnings: ['The scan was cancelled before it finished, so nothing was recorded.'],
    };
  }

  const inventory = await collectInventory(inventoryContext, {
    exclusionsApplied: exclusions.categories.map((category) => category.id),
    exclusionFolders: exclusions.folders.map((folder) => folder.path),
  });
  warnings.push(...inventory.warnings);

  const nodes = outcome.nodes.map(toStoredRow);
  const now = options.now ? options.now() : Date.now();
  const meta: SystemMapSnapshotMeta = {
    schemaVersion: SYSTEM_MAP_SCHEMA_VERSION,
    builtAt: now,
    updatedAt: now,
    rootCount: environment.roots.length,
    inventory: { ...inventory, warnings: [...inventory.warnings, ...outcome.truncations] },
  };

  if (db) {
    ensureSystemMapSchema(db);
    replaceSnapshot(db, toStoredHeader(meta), nodes);
  }

  return {
    status: 'completed',
    meta,
    nodes,
    contents: summarize(meta, nodes),
    truncations: outcome.truncations,
    excluded: outcome.excluded,
    warnings,
  };
}

/**
 * Bring the stored map up to date, without re-walking the machine.
 *
 * Returns the same shape as `buildSystemMap` so the UI has one code path. A
 * cancelled refresh also writes nothing: the stored map stays exactly as it was,
 * which is the correct outcome for "stop" — the previous map is still true about
 * everything it covered.
 */
export async function refreshSystemMap(
  environment: SystemMapEnvironment,
  options: BuildOptions & { force?: boolean },
  db: SystemMapDb,
): Promise<BuildResult> {
  const fs = environment.fs ?? nodeMetadataFs();
  const exclusions = exclusionsAreUnderstood(options.exclusions)
    ? options.exclusions
    : initialExclusions();
  const policy = await buildExclusionPolicy(exclusions, exclusionContextFor(environment, exclusions));

  ensureSystemMapSchema(db);
  const header = readSnapshot(db);
  if (!header) {
    // Nothing stored yet: a refresh is a build.
    return buildSystemMap(environment, options, db);
  }

  const previous = previousMapFrom(db);
  const inventoryContext = inventoryContextFor(environment, fs);
  const previouslyAvailable = (parseInventory(header).runtimes ?? [])
    .filter((runtime) => runtime.available)
    .map((runtime) => runtime.id);

  const result = await computeIncrementalDelta(fs, previous, {
    policy,
    budget: options.budget,
    signal: options.signal,
    now: options.now,
    force: options.force,
    onProgress: options.onProgress,
  });

  if (result.cancelled) {
    return {
      status: 'cancelled',
      meta: null,
      nodes: [],
      contents: null,
      truncations: [...result.truncations, 'The update was cancelled; the stored map was left as it was.'],
      excluded: [],
      warnings: [],
    };
  }

  // The runtime re-probe is cheap and is the only way to notice software that
  // was installed since the last scan — a new agent runtime among it.
  const inventory = await collectInventory(inventoryContext, {
    previouslyAvailableRuntimeIds: previouslyAvailable,
    exclusionsApplied: exclusions.categories.map((category) => category.id),
    exclusionFolders: exclusions.folders.map((folder) => folder.path),
  });

  applyDelta(db, result.delta);
  updateInventory(db, JSON.stringify(inventory), SYSTEM_MAP_SCHEMA_VERSION, options.now?.() ?? Date.now());

  const updatedHeader = readSnapshot(db);
  const meta: SystemMapSnapshotMeta = {
    schemaVersion: updatedHeader?.schemaVersion ?? SYSTEM_MAP_SCHEMA_VERSION,
    builtAt: updatedHeader?.builtAt ?? Date.now(),
    updatedAt: updatedHeader?.updatedAt ?? Date.now(),
    rootCount: updatedHeader?.rootCount ?? environment.roots.length,
    inventory,
  };
  const nodes = allNodes(db);
  return {
    status: 'completed',
    meta,
    nodes,
    contents: summarize(meta, nodes),
    truncations: [
      ...result.truncations,
      `${result.delta.added.length} path(s) added, ${result.delta.removed.length} removed, ${result.delta.renamed.length} moved, ${result.delta.updated.length} changed.`,
      `${result.unchangedDirectories} folder(s) were checked and had not changed.`,
    ],
    excluded: [],
    warnings: inventory.warnings,
  };
}

/**
 * The stored map as the renderer sees it, or null when none has been built.
 *
 * Built from the database rather than cached, so what the UI shows is what is
 * stored — including after an update applied a delta.
 */
export function readSystemMapContents(db: SystemMapDb): SystemMapContents | null {
  ensureSystemMapSchema(db);
  const header = readSnapshot(db);
  if (!header) return null;
  if (header.schemaVersion !== SYSTEM_MAP_SCHEMA_VERSION) {
    // A snapshot from another schema version is not reported as a map. Reading
    // it through this shape would silently lose its classification.
    return null;
  }
  const meta: SystemMapSnapshotMeta = {
    schemaVersion: header.schemaVersion,
    builtAt: header.builtAt,
    updatedAt: header.updatedAt,
    rootCount: header.rootCount,
    inventory: parseInventory(header),
  };
  return summarize(meta, allNodes(db));
}

/** Every stored node, as rows. */
export function allNodes(db: SystemMapDb): StoredNode[] {
  ensureSystemMapSchema(db);
  return db
    .prepare(
      `SELECT path, parent_path, name, kind, extension, file_type, size_bytes, created_at, modified_at, depth, classification, classification_reason
       FROM system_map_nodes ORDER BY depth, path`,
    )
    .all() as StoredNode[];
}

/** How many nodes the stored map holds. */
export function storedNodeCount(db: SystemMapDb): number {
  ensureSystemMapSchema(db);
  return countNodes(db);
}

// ── Summaries ────────────────────────────────────────────────────────────────

/**
 * Reduce a full node list to what the UI renders.
 *
 * The summary is what the user is shown; the rows stay in the database. Nothing
 * here invents a number: folder counts are sums over what was actually recorded.
 */
export function summarize(
  meta: SystemMapSnapshotMeta,
  nodes: readonly StoredNode[],
): SystemMapContents {
  const byFolder = new Map<string, { fileCount: number; totalBytes: number }>();
  const typeCounts = new Map<string, number>();
  let fileCount = 0;
  let totalBytes = 0;

  for (const node of nodes) {
    if (node.kind !== 'file') continue;
    fileCount += 1;
    totalBytes += node.size_bytes;
    const type = node.extension ?? 'no extension';
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    const folder = node.parent_path;
    if (!folder) continue;
    const bucket = byFolder.get(folder) ?? { fileCount: 0, totalBytes: 0 };
    bucket.fileCount += 1;
    bucket.totalBytes += node.size_bytes;
    byFolder.set(folder, bucket);
  }

  const inventory = meta.inventory;
  return {
    builtAt: meta.builtAt,
    folders: [...byFolder.entries()]
      .map(([folder, stats]) => ({
        path: folder,
        label: labelForFolder(folder),
        fileCount: stats.fileCount,
        totalBytes: stats.totalBytes,
      }))
      .sort((a, b) => b.fileCount - a.fileCount),
    fileCount,
    totalBytes,
    apps: inventory.applications.map((app) => ({
      name: app.name,
      ...(app.version ? { version: app.version } : {}),
    })),
    devTools: inventory.developmentTools.map((tool) => ({
      name: tool.name,
      ...(tool.version ? { version: tool.version } : {}),
    })),
    aiSoftware: [
      ...inventory.runtimes
        .filter((runtime) => runtime.available)
        .map((runtime) => ({
          id: runtime.id,
          name: runtime.displayName,
          ...(runtime.version ? { version: runtime.version } : {}),
        })),
      ...inventory.localModels.map((model) => ({
        id: `model:${model.id}`,
        name: model.name,
      })),
    ],
    fileTypes: [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** A folder's display name: its own last segment, falling back to the path. */
function labelForFolder(folder: string): string {
  const parts = folder.split(/[/\\]/).filter((part) => part.length > 0);
  return parts.length === 0 ? folder : parts[parts.length - 1];
}

// ── Wiring ───────────────────────────────────────────────────────────────────

/** The exclusion context for a machine, given the exclusions in force. */
function exclusionContextFor(
  environment: SystemMapEnvironment,
  exclusions: SystemMapExclusions,
): ExclusionContext {
  const platform = environment.platform;
  const browserProfileRoots: string[] = [];
  if (exclusions.categories.some((category) => category.id === 'browserProfiles')) {
    const configRoot = platform === 'win32' ? `${environment.homeDir}\\AppData\\Local` : `${environment.homeDir}/.config`;
    const supportRoot =
      platform === 'darwin'
        ? `${environment.homeDir}/Library/Application Support`
        : platform === 'win32'
          ? `${environment.homeDir}\\AppData\\Local`
          : `${environment.homeDir}/.config`;
    browserProfileRoots.push(
      `${configRoot}/google-chrome`,
      `${configRoot}/chromium`,
      `${configRoot}/BraveSoftware`,
      `${supportRoot}/Mozilla`,
      `${supportRoot}/Firefox`,
    );
  }
  return {
    platform,
    homeDir: environment.homeDir,
    usersRoot: environment.usersRoot,
    browserProfileRoots,
  };
}

/** The inventory context for a machine. */
function inventoryContextFor(
  environment: SystemMapEnvironment,
  fs: MetadataFs,
): InventoryContext {
  return {
    platform: environment.platform,
    homeDir: environment.homeDir,
    pathDirectories: environment.pathDirectories,
    fs,
    ollamaBaseUrl: environment.ollamaBaseUrl,
    listLocalModels: environment.listLocalModels,
    discoverRuntimes: environment.discoverRuntimes,
    applicationDirectories: environment.applicationDirectories,
    selectionReader: { readSelectedRuntimeId: environment.readSelectedRuntimeId },
  };
}

/** Rebuild the previous-map view the incremental pass needs, from the rows. */
function previousMapFrom(db: SystemMapDb): {
  directories: KnownDirectory[];
  files: KnownFile[];
} {
  const rows = allNodes(db);
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parent_path) continue;
    const bucket = childrenByParent.get(row.parent_path) ?? [];
    bucket.push(row.path);
    childrenByParent.set(row.parent_path, bucket);
  }

  const directories: KnownDirectory[] = [];
  const files: KnownFile[] = [];
  for (const row of rows) {
    if (row.kind === 'directory') {
      directories.push({
        path: row.path,
        modifiedAt: row.modified_at,
        createdAt: row.created_at,
        depth: row.depth,
        classification: row.classification,
        classificationReason: row.classification_reason,
        childPaths: childrenByParent.get(row.path) ?? [],
      });
      continue;
    }
    files.push({
      path: row.path,
      sizeBytes: row.size_bytes,
      modifiedAt: row.modified_at,
      createdAt: row.created_at,
      depth: row.depth,
    });
  }
  return { directories, files };
}

/** A scanned node as a store row. */
function toStoredRow(node: {
  path: string;
  parentPath: string | null;
  name: string;
  kind: 'file' | 'directory';
  extension: string | null;
  fileType: string;
  sizeBytes: number;
  createdAt: number | null;
  modifiedAt: number;
  depth: number;
  classification?: string;
  classificationReason?: string;
}): StoredNode {
  return {
    path: node.path,
    parent_path: node.parentPath,
    name: node.name,
    kind: node.kind,
    extension: node.extension,
    file_type: node.fileType,
    size_bytes: node.sizeBytes,
    created_at: node.createdAt,
    modified_at: node.modifiedAt,
    depth: node.depth,
    classification: node.classification ?? null,
    classification_reason: node.classificationReason ?? null,
  };
}

/** A snapshot header as the store wants it. */
function toStoredHeader(meta: SystemMapSnapshotMeta) {
  return {
    schemaVersion: meta.schemaVersion,
    builtAt: meta.builtAt,
    updatedAt: meta.updatedAt,
    rootCount: meta.rootCount,
    inventory: JSON.stringify(meta.inventory),
  };
}

/** The inventory half of a stored header, parsed defensively. */
function parseInventory(header: { inventory: string }): SystemMapInventory {
  const empty: SystemMapInventory = {
    volumes: [],
    userLocations: [],
    applications: [],
    pathExecutables: [],
    developmentTools: [],
    languageRuntimes: [],
    services: [],
    hardware: null,
    localModels: [],
    runtimes: [],
    runtimeOffers: [],
    exclusionsApplied: [],
    exclusionFolders: [],
    warnings: [],
  };
  try {
    const parsed = JSON.parse(header.inventory) as Partial<SystemMapInventory>;
    return { ...empty, ...parsed };
  } catch {
    // A corrupt inventory row must not take down the map: the filesystem half
    // is still good, so it is reported with an empty inventory rather than not
    // at all.
    return empty;
  }
}

export { pathIsAtOrUnder };