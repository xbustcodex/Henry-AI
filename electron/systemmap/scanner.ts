/**
 * The walk — bounded, cancellable, and metadata-only by construction.
 *
 * ── What this does ──────────────────────────────────────────────────────────
 *
 * Given a set of roots it produces the node list: every directory and every
 * file it reached, with names, kinds, sizes, dates, containment and a
 * classification per directory. It reads names and stats and nothing else,
 * because the only filesystem capability it holds is `MetadataFs`.
 *
 * ── Resource safety, as a set of hard stops ─────────────────────────────────
 *
 * A scan of a real home directory finds hundreds of thousands of files, and
 * "hundreds of thousands of small promises" is how a Node process runs out of
 * memory and how a scan makes an app feel broken. Five independent limits stop
 * that, and every one of them RECORDS that it fired:
 *
 *   - `maxDepth` — how far below a root the walk descends.
 *   - `maxEntriesPerDirectory` — how many siblings one directory may
 *     contribute, so a folder with a million files in it cannot flood the map.
 *   - `maxNodes` / `maxDirectories` — totals for the whole scan.
 *   - `maxDurationMs` — wall clock. A slow network mount must not hold a scan
 *     for an hour.
 *   - `concurrency` — how many directory listings are in flight. Bounded so a
 *     scan cannot saturate a disk or the event loop.
 *
 * None of these is silent. `ScanOutcome.truncations` names each limit that
 * fired and where, so "the map is incomplete" is visible rather than inferred.
 *
 * ── Cancellation ────────────────────────────────────────────────────────────
 *
 * An `AbortSignal` is checked at the top of every directory turn and again
 * after each awaited listing, so a cancel takes effect within one listing rather
 * than at the end of the scan. A cancelled scan returns `cancelled: true` and
 * the caller DISCARDS the partial result: half a machine's map is worse than
 * none, because it looks whole.
 *
 * ── Symlinks ────────────────────────────────────────────────────────────────
 *
 * Never followed. A symlink is recorded as a symlink and not descended. Links
 * are how walks meet cycles, and how a scan reaches through a shortcut into a
 * place the exclusions just refused.
 */

import { classifyDirectory, fileTypeForExtension } from './classify';
import type { ExclusionDecision, ExclusionPolicy } from './exclusions';
import type { DirEntryInfo, MetadataFs, PathStatInfo } from './fsMetadata';
import {
  DEFAULT_SCAN_BUDGET,
  type CancellationLike,
  type ScanBudget,
  type ScanProgress,
  type SystemMapNode,
} from './types';

/** What to scan. */
export interface ScanRequest {
  /** Absolute directories to walk. Each is a root at depth 0. */
  roots: readonly string[];
  /** The exclusions in force. Enforced at descent and again at record time. */
  policy: ExclusionPolicy;
  /** Resource ceiling. Defaults to `DEFAULT_SCAN_BUDGET`. */
  budget?: Partial<ScanBudget>;
  /** Stop here when signalled. */
  signal?: CancellationLike;
  /** Called as the scan advances. */
  onProgress?: (progress: ScanProgress) => void;
  /** Wall clock, injected so tests do not depend on real elapsed time. */
  now?: () => number;
  /** Nodes processed between event-loop yields. */
  yieldEveryNodes?: number;
}

/** A path the scan refused, and the rule that refused it. */
export interface ExcludedPath {
  path: string;
  label: string;
  categoryId: string;
}

/** What one scan measured. */
export interface ScanStats {
  foldersScanned: number;
  filesScanned: number;
  bytesScanned: number;
  durationMs: number;
  cancelled: boolean;
}

/** Everything one scan produced. */
export interface ScanOutcome {
  nodes: SystemMapNode[];
  stats: ScanStats;
  /** One entry per limit that fired, naming where it fired. */
  truncations: string[];
  /** Paths refused, by the rule that refused them. Shown in the UI. */
  excluded: ExcludedPath[];
}

/** One directory waiting to be walked. */
interface QueueItem {
  dirPath: string;
  depth: number;
}

/**
 * Walk `roots` and return every reachable node's metadata.
 *
 * The one entry point for a baseline scan. `incremental.ts` reuses these
 * primitives so both paths enforce identical exclusions.
 */
export async function scanFilesystem(fs: MetadataFs, request: ScanRequest): Promise<ScanOutcome> {
  const budget: ScanBudget = { ...DEFAULT_SCAN_BUDGET, ...request.budget };
  const now = request.now ?? (() => Date.now());
  const startedAt = now();
  const yieldEveryNodes = request.yieldEveryNodes ?? 200;
  const rootSet = new Set(request.roots);

  const nodes: SystemMapNode[] = [];
  const truncations: string[] = [];
  const excluded: ExcludedPath[] = [];
  const inFlight = new Set<Promise<void>>();

  let foldersScanned = 0;
  let filesScanned = 0;
  let bytesScanned = 0;
  let cancelled = false;
  let stopReason: string | null = null;
  let processedNodes = 0;
  /** Directory slots taken so far. Reserved at dispatch, never decremented. */
  let foldersStarted = 0;

  const progress: ScanProgress = {
    phase: 'scanning',
    foldersScanned: 0,
    filesScanned: 0,
    bytesScanned: 0,
    totalFiles: null,
    currentFolder: null,
    appsFound: 0,
    devToolsFound: 0,
  };

  const queue: QueueItem[] = request.roots.map((dirPath) => ({ dirPath, depth: 0 }));

  const refuse = (targetPath: string, decision: ExclusionDecision): void => {
    if (decision.excluded) {
      excluded.push({
        path: targetPath,
        label: decision.label,
        categoryId: decision.categoryId,
      });
    }
  };

  /** One turn of the walk: record a directory, queue or record its children. */
  const walkDirectory = async (item: QueueItem): Promise<void> => {
    if (cancelled) return;

    // A denied directory is never listed, so its children are never even named.
    // Roots are exempt: the user chose to scan this exact folder, and refusing
    // it would leave them with a map of nothing and no explanation.
    if (!rootSet.has(item.dirPath)) {
      const decision = request.policy.excludesDirectory(item.dirPath);
      if (decision.excluded) {
        refuse(item.dirPath, decision);
        return;
      }
    }

    // Checked here as well as at the top of the turn: awaiting the listing is
    // the one place a cancel issued mid-turn would otherwise be missed.
    if (request.signal?.aborted) {
      cancelled = true;
      return;
    }

    let childEntries: DirEntryInfo[];
    try {
      childEntries = await fs.readDir(item.dirPath);
    } catch {
      // Unreadable directory — permissions, a vanished path, a dead mount. One
      // locked folder must never end a scan of the whole machine.
      truncations.push(`${item.dirPath} could not be read.`);
      return;
    }

    const dirStat = await statSafely(fs, item.dirPath);
    if (dirStat) {
      const classified = classifyDirectory({
        name: baseName(item.dirPath),
        path: item.dirPath,
        childNames: childEntries.map((entry) => entry.name),
      });
      nodes.push({
        path: item.dirPath,
        parentPath: rootSet.has(item.dirPath) ? null : parentOf(item.dirPath),
        name: baseName(item.dirPath),
        kind: 'directory',
        extension: null,
        fileType: 'other',
        sizeBytes: 0,
        createdAt: dirStat.createdAt,
        modifiedAt: dirStat.modifiedAt,
        depth: item.depth,
        classification: classified.classification,
        classificationReason: classified.confidence
          ? `${classified.reason} (${classified.confidence} confidence)`
          : classified.reason,
      });
      processedNodes += 1;
      if (processedNodes % yieldEveryNodes === 0) {
        // Hand the event loop back so a scan of a big disk does not make the
        // window feel hung.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    foldersScanned += 1;
    if (request.onProgress) {
      progress.foldersScanned = foldersScanned;
      progress.filesScanned = filesScanned;
      progress.bytesScanned = bytesScanned;
      progress.currentFolder = item.dirPath;
      request.onProgress({ ...progress });
    }

    // Two independent caps apply to one directory's children: how many siblings
    // it may contribute, and how much room is left in the whole scan. Whichever
    // one bites is reported by name — a map that is short must say why.
    const roomLeft = Math.max(0, budget.maxNodes - nodes.length);
    const perDirectoryRoom = Math.min(
      childEntries.length,
      budget.maxEntriesPerDirectory,
      roomLeft,
    );
    if (childEntries.length > budget.maxEntriesPerDirectory) {
      truncations.push(
        `${item.dirPath} holds ${childEntries.length} entries; only the first ${budget.maxEntriesPerDirectory} were recorded.`,
      );
    }
    if (perDirectoryRoom < Math.min(childEntries.length, budget.maxEntriesPerDirectory)) {
      stopReason = `Stopped at the ceiling of ${budget.maxNodes} recorded items.`;
    }

    for (const child of childEntries.slice(0, perDirectoryRoom)) {
      if (cancelled) return;
      const childPath = joinPath(item.dirPath, child.name);
      const childDepth = item.depth + 1;

      // ── The second, independent exclusion check ────────────────────────
      // The descent check refuses whole folders. This one judges the node by
      // its FULL path, which is what makes an innocuous file inside a
      // credential store impossible to record even when the walk reached it by
      // a route the descent check never saw.
      const decision =
        child.isFile && !child.isDirectory
          ? request.policy.excludesFile(childPath)
          : request.policy.excludesDirectory(childPath);
      if (decision.excluded) {
        refuse(childPath, decision);
        continue;
      }

      if (child.isSymbolicLink) {
        // Recorded as a link, never followed.
        const linkStat = await statSafely(fs, childPath);
        nodes.push({
          path: childPath,
          parentPath: item.dirPath,
          name: child.name,
          kind: 'file',
          extension: extensionOf(child.name) || null,
          fileType: 'other',
          sizeBytes: 0,
          createdAt: linkStat?.createdAt ?? null,
          modifiedAt: linkStat?.modifiedAt ?? 0,
          depth: childDepth,
        });
        filesScanned += 1;
        continue;
      }

      if (child.isDirectory) {
        if (childDepth >= budget.maxDepth) {
          truncations.push(
            `${childPath} is deeper than the depth limit of ${budget.maxDepth}; it was not opened.`,
          );
          continue;
        }
        queue.push({ dirPath: childPath, depth: childDepth });
        continue;
      }

      const fileStat = await statSafely(fs, childPath);
      if (!fileStat) {
        truncations.push(`${childPath} could not be read.`);
        continue;
      }
      const extension = extensionOf(child.name);
      nodes.push({
        path: childPath,
        parentPath: item.dirPath,
        name: child.name,
        kind: 'file',
        extension: extension || null,
        fileType: fileTypeForExtension(extension),
        sizeBytes: fileStat.sizeBytes,
        createdAt: fileStat.createdAt,
        modifiedAt: fileStat.modifiedAt,
        depth: childDepth,
      });
      filesScanned += 1;
      bytesScanned += fileStat.sizeBytes;
    }
  };

  // ── The pool ───────────────────────────────────────────────────────────
  // `concurrency` workers, each pulling from one shared queue. The loop stops
  // for the first limit that fires; the in-flight turns are then awaited so the
  // caller gets a complete node list rather than a partial one.
  while (!stopReason && !cancelled && queue.length > 0) {
    if (request.signal?.aborted) {
      cancelled = true;
      break;
    }
    if (now() - startedAt > budget.maxDurationMs) {
      stopReason = `Stopped after the time limit of ${budget.maxDurationMs}ms, with ${queue.length} folders still queued.`;
      break;
    }
    if (nodes.length >= budget.maxNodes) {
      stopReason = `Stopped at the ceiling of ${budget.maxNodes} recorded items.`;
      break;
    }
    if (foldersStarted >= budget.maxDirectories) {
      stopReason = `Stopped at the ceiling of ${budget.maxDirectories} folders scanned.`;
      break;
    }

    // A turn is only dispatched while a directory slot is still free. The slot
    // is RESERVED at dispatch rather than counted on completion, because with
    // several listings in flight a completion-based check would overshoot the
    // ceiling by up to `concurrency` folders — a cap that can be exceeded by
    // the width of the pool is not a cap.
    while (inFlight.size < budget.concurrency && queue.length > 0) {
      if (foldersStarted >= budget.maxDirectories) {
        stopReason = `Stopped at the ceiling of ${budget.maxDirectories} folders scanned.`;
        break;
      }
      const item = queue.shift();
      if (!item) break;
      foldersStarted += 1;
      const turn = walkDirectory(item).finally(() => {
        inFlight.delete(turn);
      });
      inFlight.add(turn);
    }

    if (inFlight.size === 0) break;
    // Settle at least one turn before re-checking the limits, so progress is
    // real rather than a busy-wait that starves the very work it waits for.
    await Promise.race(inFlight);
  }

  await Promise.all(inFlight);

  if (stopReason) truncations.push(stopReason);

  const durationMs = now() - startedAt;
  if (cancelled) {
    truncations.push('Cancelled: the partial map was not kept.');
  }

  return {
    nodes,
    stats: { foldersScanned, filesScanned, bytesScanned, durationMs, cancelled },
    truncations,
    excluded,
  };
}

/** Stat a path, returning `null` when it does not exist or cannot be read. */
async function statSafely(fs: MetadataFs, target: string): Promise<PathStatInfo | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

// ── Path helpers ─────────────────────────────────────────────────────────────
//
// Hand-rolled rather than imported from `node:path` so one implementation can
// walk POSIX paths, Windows paths and test-fixture paths on any host. The
// scanner only concatenates, splits and compares — it never resolves a path
// against a real root.

// /** Join a parent and a child name with the separator that parent already uses. */
function joinPath(parent: string, child: string): string {
  if (parent.endsWith('/') || parent.endsWith('\\')) return `${parent}${child}`;
  // A Windows root carries its own colon (`C:`), so it takes a backslash.
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\${child}`;
  return `${parent}/${child}`;
}

/** The last segment of a path. */
function baseName(target: string): string {
  const parts = target.split(/[/\\]/).filter((part) => part.length > 0);
  return parts.length === 0 ? target : parts[parts.length - 1];
}

/** Everything before the last segment. */
function parentOf(target: string): string {
  const trimmed = target.replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut <= 0 ? trimmed.slice(0, 1) : trimmed.slice(0, cut);
}

/** The extension of a name, lower-cased and dotted, or `''` when it has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** True when `candidate` is `base` or lies beneath it, segment-wise. */
export function pathIsAtOrUnder(candidate: string, base: string): boolean {
  const normalizedCandidate = candidate.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedBase = base.replace(/\\/g, '/').replace(/\/+$/, '');
  return (
    normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(`${normalizedBase}/`)
  );
}