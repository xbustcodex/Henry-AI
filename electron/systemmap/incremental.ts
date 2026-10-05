/**
 * Keeping the map current without re-crawling the machine.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 *
 * A full scan of a home directory with 300,000 files takes minutes and reads
 * every directory on the disk. "What changed since yesterday?" does not justify
 * any of that, and doing it on a timer would make Henry a nuisance on someone's
 * laptop.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *
 * The snapshot already holds, for every directory it walked, that directory's
 * modification time. A directory's mtime changes when an entry inside it is
 * created, deleted or renamed — that is what the timestamp means on every
 * filesystem Henry runs on. So an incremental pass is:
 *
 *   1. For each **recorded directory**, `stat` it. One syscall.
 *   2. If its mtime is unchanged, nothing inside it changed, so it is skipped
 *      and none of its subtree is touched. This is where the saving comes from:
 *      an unchanged folder costs one stat, not a walk.
 *   3. If it changed, re-list it and compare against the recorded children.
 *      Names present now and absent then are ADDED. Names recorded and absent
 *      now are REMOVED, and their subtrees with them.
 *   4. A newly added directory is walked with the same bounded baseline
 *      scanner, so a new tree is discovered as deeply as the budget allows
 *      rather than only at its top level.
 *   5. A removed path and an added path that are the same file — same size,
 *      same mtime — are paired and reported as a rename, so a moved folder
 *      reads as a move rather than as a delete plus an unrelated create.
 *
 * ── What it does NOT claim ──────────────────────────────────────────────────
 *
 * A directory whose mtime did not move really has not changed. That is a
 * property of filesystems rather than a guess made here, and it is the only
 * reason the expensive case may be skipped. `force` exists for when that
 * evidence is unavailable, or when the user asked for a fresh look.
 *
 * ── Bounded, like the baseline ──────────────────────────────────────────────
 *
 * The same `ScanBudget` applies and the same `truncations` report comes out. An
 * incremental pass that could run away on a machine with a million files would
 * be worse than no incremental pass at all.
 */

import { classifyDirectory, fileTypeForExtension } from './classify';
import type { ExclusionPolicy } from './exclusions';
import type { MetadataFs } from './fsMetadata';
import { extensionOf, pathIsAtOrUnder, scanFilesystem } from './scanner';
import type { MapDelta, StoredNode } from './store';
import {
  DEFAULT_SCAN_BUDGET,
  type CancellationLike,
  type ScanBudget,
  type ScanProgress,
} from './types';

/** A directory the snapshot knows about, as the pass needs it. */
export interface KnownDirectory {
  path: string;
  /** The directory's mtime as recorded by the last scan. */
  modifiedAt: number;
  createdAt: number | null;
  depth: number;
  classification: string | null;
  classificationReason: string | null;
  /** Direct child paths recorded under it. */
  childPaths: readonly string[];
}

/** A file the snapshot knows about. */
export interface KnownFile {
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  createdAt: number | null;
  depth: number;
}

/** What the incremental pass needs to know about the previous snapshot. */
export interface PreviousMap {
  directories: readonly KnownDirectory[];
  files: readonly KnownFile[];
}

/** How many changed items one pass will report before it stops. */
export interface IncrementalResult {
  delta: MapDelta;
  /** Directories whose mtime was checked and found unchanged. */
  unchangedDirectories: number;
  /** Directories whose mtime moved and were therefore re-listed. */
  recheckedDirectories: number;
  truncations: string[];
  cancelled: boolean;
}

/** How to run the pass. */
export interface IncrementalRequest {
  policy: ExclusionPolicy;
  budget?: Partial<ScanBudget>;
  signal?: CancellationLike;
  now?: () => number;
  /** Re-list every known directory, ignoring the mtime shortcut. */
  force?: boolean;
  /**
   * Called as the pass advances.
   *
   * Present because the UI shows a progress indicator on every start, and a
   * rebuild that emitted nothing would leave that indicator frozen on a screen
   * where work is demonstrably happening. `totalFiles` is null throughout: an
   * update does not know how much work is left, and a progress bar drawn against
   * a guess is worse than an indeterminate one.
   */
  onProgress?: (progress: ScanProgress) => void;
  /**
   * Also stat the files inside folders whose mtime did not move.
   *
   * Off by default, and the reason is worth stating: an in-place edit does not
   * change the containing folder's mtime, so this is the only way to see one.
   * It costs a stat per known file, which is still far cheaper than a re-walk,
   * so it is offered rather than assumed — a map that silently missed every
   * document the user edited would be worse than one that said what it checked.
   */
  verifyFiles?: boolean;
}

/** Convert a scanned node into a store row. */
export function toStoredNode(node: {
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

/**
 * Compare what is on disk now against what was recorded, and produce the delta.
 *
 * Nothing here writes: the caller applies the delta to the store, so the same
 * comparison can be run against a snapshot without touching it.
 */
export async function computeIncrementalDelta(
  fs: MetadataFs,
  previous: PreviousMap,
  request: IncrementalRequest,
): Promise<IncrementalResult> {
  const budget: ScanBudget = { ...DEFAULT_SCAN_BUDGET, ...request.budget };
  const now = request.now ?? (() => Date.now());
  const startedAt = now();

  const added: StoredNode[] = [];
  const updated: StoredNode[] = [];
  const removed: string[] = [];
  const truncations: string[] = [];

  const knownDirectories = new Map(previous.directories.map((dir) => [dir.path, dir]));
  const knownFiles = new Map(previous.files.map((file) => [file.path, file]));

  let unchangedDirectories = 0;
  let recheckedDirectories = 0;
  let cancelled = false;

  /**
   * Record a path as gone, exactly once, and only at the TOP of its tree.
   *
   * Two different discoveries can name the same removal: a `stat` that fails
   * because the directory itself is gone, and a parent's re-listing that no
   * longer lists it. Both pushed independently, so a removed folder could land
   * in the delta twice — and, when its own children were visited first, it could
   * be reported alongside its own descendants.
   *
   * Duplicates are not cosmetic. `applyDelta` issues one DELETE per removal, so
   * the second is a wasted statement; and a descendant recorded separately
   * alongside its removed ancestor contradicts the design, which records only
   * the top precisely so one delete takes the whole subtree.
   */
  const recordRemoval = (target: string): void => {
    if (removed.some((gone) => pathIsAtOrUnder(target, gone))) return;
    for (let index = removed.length - 1; index >= 0; index -= 1) {
      if (pathIsAtOrUnder(removed[index], target)) removed.splice(index, 1);
    }
    removed.push(target);
  };

  /** Deepest-first order, so a change above is applied before its children. */
  const queue: string[] = [...previous.directories]
    .sort((a, b) => b.depth - a.depth || b.path.length - a.path.length)
    .map((dir) => dir.path);
  const visited = new Set<string>();

  while (queue.length > 0 && !cancelled) {
    if (request.signal?.aborted) {
      cancelled = true;
      break;
    }
    if (now() - startedAt > budget.maxDurationMs) {
      truncations.push(
        `Stopped at the time limit of ${budget.maxDurationMs}ms with ${queue.length} folders left to check.`,
      );
      break;
    }
    if (added.length + removed.length + updated.length >= budget.maxNodes) {
      truncations.push(
        `Stopped at the ceiling of ${budget.maxNodes} changed items; the rest of this pass was not checked.`,
      );
      break;
    }

    if (request.onProgress) {
      request.onProgress({
        phase: 'scanning',
        foldersScanned: unchangedDirectories + recheckedDirectories,
        filesScanned: added.length + updated.length,
        bytesScanned: added.reduce((total, node) => total + node.size_bytes, 0),
        totalFiles: null,
        currentFolder: queue[0] ?? null,
        appsFound: 0,
        devToolsFound: 0,
      });
    }

    const dirPath = queue.shift();
    if (!dirPath || visited.has(dirPath)) continue;
    visited.add(dirPath);
    const known = knownDirectories.get(dirPath);
    if (!known) continue;

    let stat;
    try {
      stat = await fs.stat(dirPath);
    } catch {
      // The directory is gone: it and everything under it are removed.
      recordRemoval(dirPath);
      continue;
    }

    // ── The mtime shortcut ────────────────────────────────────────────────
    // An unchanged mtime means no ENTRY inside changed. That is the filesystem's
    // own guarantee, and it is why the pass is cheap: the subtree costs one
    // stat instead of a walk.
    //
    // It does NOT mean no file inside was edited. Editing a file in place does
    // not touch the directory that holds it, so an edited file is invisible here
    // unless `verifyFiles` asks for it. That is stated rather than hidden,
    // because "we found every change" would be a claim this cannot make.
    if (!request.force && stat.modifiedAt === known.modifiedAt) {
      unchangedDirectories += 1;
      if (request.verifyFiles) {
        // Still no directory listing: only the files this map already knows
        // about, checked one stat each. Cheaper than a re-walk (no readdir, no
        // re-classification, no exclusion re-evaluation) and enough to catch an
        // in-place edit.
        for (const childPath of known.childPaths) {
          if (request.signal?.aborted || cancelled) {
            cancelled = true;
            break;
          }
          const knownFile = knownFiles.get(childPath);
          if (!knownFile) continue;
          const fileStat = await statSafely(fs, childPath);
          if (!fileStat || fileStat.modifiedAt === knownFile.modifiedAt) continue;
          const name = baseName(childPath);
          const extension = extensionOf(name);
          updated.push({
            path: childPath,
            parent_path: dirPath,
            name,
            kind: 'file',
            extension: extension || null,
            file_type: fileTypeForExtension(extension),
            size_bytes: fileStat.sizeBytes,
            created_at: fileStat.createdAt,
            modified_at: fileStat.modifiedAt,
            depth: knownFile.depth,
            classification: null,
            classification_reason: null,
          });
        }
      }
      continue;
    }
    recheckedDirectories += 1;

    let entries;
    try {
      entries = await fs.readDir(dirPath);
    } catch {
      truncations.push(`${dirPath} changed but could not be re-read.`);
      continue;
    }

    // The directory's own row may need updating even when its children do not.
    const classified = classifyDirectory({
      name: baseName(dirPath),
      path: dirPath,
      childNames: entries.map((entry) => entry.name),
    });
    updated.push({
      path: dirPath,
      parent_path: parentOf(dirPath),
      name: baseName(dirPath),
      kind: 'directory',
      extension: null,
      file_type: 'other',
      size_bytes: 0,
      created_at: known.createdAt,
      modified_at: stat.modifiedAt,
      depth: known.depth,
      classification: classified.classification,
      classification_reason: classified.reason,
    });

    const knownChildren = new Set(known.childPaths);
    const presentChildren = new Set(entries.map((entry) => joinPath(dirPath, entry.name)));

    // ── Removals ──────────────────────────────────────────────────────────
    // A recorded child that is no longer listed is gone. Only the TOP of the
    // removed tree is recorded: deleting one path takes its descendants with it.
    for (const childPath of knownChildren) {
      if (presentChildren.has(childPath)) continue;
      recordRemoval(childPath);
    }

    // ── Additions and metadata moves ──────────────────────────────────────
    const newDirectories: string[] = [];
    for (const entry of entries) {
      const childPath = joinPath(dirPath, entry.name);
      if (request.signal?.aborted) {
        cancelled = true;
        break;
      }

      if (knownChildren.has(childPath)) {
        const knownFile = knownFiles.get(childPath);
        if (!knownFile) continue;
        // A known file can only have changed in its own metadata, and checking
        // that costs one stat — cheaper than assuming either way.
        const fileStat = await statSafely(fs, childPath);
        if (!fileStat || fileStat.modifiedAt === knownFile.modifiedAt) continue;
        const extension = extensionOf(entry.name);
        updated.push({
          path: childPath,
          parent_path: dirPath,
          name: entry.name,
          kind: 'file',
          extension: extension || null,
          file_type: fileTypeForExtension(extension),
          size_bytes: fileStat.sizeBytes,
          created_at: fileStat.createdAt,
          modified_at: fileStat.modifiedAt,
          depth: knownFile.depth,
          classification: null,
          classification_reason: null,
        });
        continue;
      }

      // A new path goes through the SAME exclusion policy as a baseline scan.
      // An incremental pass must not become a way around the exclusions.
      const decision =
        entry.isFile && !entry.isDirectory
          ? request.policy.excludesFile(childPath)
          : request.policy.excludesDirectory(childPath);
      if (decision.excluded) continue;

      if (entry.isDirectory) {
        newDirectories.push(childPath);
        continue;
      }

      const fileStat = await statSafely(fs, childPath);
      if (!fileStat) continue;
      const extension = extensionOf(entry.name);
      added.push({
        path: childPath,
        parent_path: dirPath,
        name: entry.name,
        kind: 'file',
        extension: extension || null,
        // A symlink is recorded, never followed, exactly as in the baseline.
        file_type: entry.isSymbolicLink ? 'other' : fileTypeForExtension(extension),
        size_bytes: entry.isSymbolicLink ? 0 : fileStat.sizeBytes,
        created_at: fileStat.createdAt,
        modified_at: fileStat.modifiedAt,
        depth: known.depth + 1,
        classification: null,
        classification_reason: null,
      });
    }
    if (cancelled) break;

    // ── Walk newly discovered directories ────────────────────────────────
    // A new tree is scanned with the baseline scanner: same exclusions, same
    // budget, discovered as deeply as the limits allow.
    if (newDirectories.length > 0) {
      const outcome = await scanFilesystem(fs, {
        roots: newDirectories,
        policy: request.policy,
        budget: request.budget,
        signal: request.signal,
        now,
      });
      truncations.push(...outcome.truncations);
      // The sub-scan numbers depths from its own roots, so they are rebased
      // onto this folder's depth. Without the shift a new file would be stored
      // as if it lived near the top of the disk.
      const baseDepth = known.depth;
      for (const node of outcome.nodes) {
        added.push({ ...toStoredNode(node), depth: baseDepth + node.depth });
      }
      if (outcome.stats.cancelled) {
        cancelled = true;
        break;
      }
    }
  }

  const renames = detectRenames(added, removed, previous);
  const renamedFrom = new Set(renames.map((rename) => rename.from));
  const renamedTo = new Set(renames.map((rename) => rename.to));

  return {
    delta: {
      added: added.filter((node) => !renamedTo.has(node.path)),
      updated,
      removed: removed.filter((path) => !renamedFrom.has(path)),
      renamed: renames,
    },
    unchangedDirectories,
    recheckedDirectories,
    truncations,
    cancelled,
  };
}

/**
 * Pair removals with additions that are the same file, moved.
 *
 * A rename changes a file's name and nothing else, so size and modification
 * time survive it. That pair of facts is what identifies a move. Pairing is
 * one-to-one and only between a removal and an addition, so a file deleted and
 * an unrelated file created at the same second is reported as two events — a
 * safe way to be wrong.
 */
export function detectRenames(
  added: readonly StoredNode[],
  removed: readonly string[],
  previous: PreviousMap,
): { from: string; to: string }[] {
  const removedIdentity = new Map<string, string>();
  for (const file of previous.files) {
    removedIdentity.set(file.path, `${file.sizeBytes}:${file.modifiedAt}`);
  }

  const additionsByIdentity = new Map<string, StoredNode[]>();
  for (const node of added) {
    if (node.kind !== 'file') continue;
    const key = `${node.size_bytes}:${node.modified_at}`;
    const bucket = additionsByIdentity.get(key) ?? [];
    bucket.push(node);
    additionsByIdentity.set(key, bucket);
  }

  const renames: { from: string; to: string }[] = [];
  const usedAdditions = new Set<string>();
  for (const removedPath of removed) {
    const identity = removedIdentity.get(removedPath);
    if (!identity) continue;
    const candidates = additionsByIdentity.get(identity) ?? [];
    const match = candidates.find((node) => !usedAdditions.has(node.path));
    if (!match) continue;
    usedAdditions.add(match.path);
    renames.push({ from: removedPath, to: match.path });
  }
  return renames;
}

/** Stat a path, returning `null` when it is gone. */
async function statSafely(fs: MetadataFs, target: string) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

/** Join a parent and a child name with the separator the parent already uses. */
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