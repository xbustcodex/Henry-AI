/**
 * Path-safety helpers for the sandboxed IPC surface.
 *
 * Henry runs file operations on behalf of an AI, so "stay inside the allowed
 * directory" is a security boundary, not a nicety. These helpers are the single
 * source of truth for that check — `filesystem.ts`, `taskBroker.ts`, and the
 * terminal cwd guard all go through them.
 *
 * The bug this fixes: a naive `resolved.startsWith(root)` lets a SIBLING
 * directory escape, because `/work-evil`.startsWith(`/work`) is true. We require
 * either an exact match or a trailing path separator so `/work-evil` is rejected
 * while `/work/sub` is allowed.
 */

import path from 'path';
import fs from 'fs';

/**
 * True iff `target` is `root` itself or strictly inside it.
 * Both are resolved to absolute paths first. Avoids the sibling-prefix bug by
 * requiring a path separator after the root.
 */
export function isInsideRoot(target: string, root: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * Resolve `requestedPath` against `root` and guarantee the result stays inside
 * `root`. Defeats `..` traversal and the sibling-prefix bug. Also performs a
 * best-effort symlink check: if the path (or its nearest existing ancestor)
 * resolves through a symlink to somewhere outside `root`, it's rejected — so a
 * symlink planted inside the workspace can't be used to read/write outside it.
 *
 * Throws on any violation. Returns the absolute, validated path on success.
 */
export function safeResolve(root: string, requestedPath: string): string {
  const resolvedRoot = realpathOrSelf(path.resolve(root));
  const resolved = path.resolve(resolvedRoot, requestedPath ?? '');

  if (!isInsideRoot(resolved, resolvedRoot)) {
    throw new Error('Access denied: path is outside the allowed directory.');
  }

  // Symlink hardening — re-check against the real path of the deepest existing
  // ancestor (a write target may not exist yet). Best-effort: only rejects when
  // we can positively prove the real location is outside the root.
  const real = realpathOfNearestExisting(resolved);
  if (real && !isInsideRoot(real, resolvedRoot)) {
    throw new Error('Access denied: path resolves through a symlink outside the allowed directory.');
  }

  return resolved;
}

/** Resolve symlinks for an existing path; return the input unchanged if it
 * doesn't exist or can't be resolved. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Real (symlink-resolved) location of `target`, computed from its deepest
 * existing ancestor with the non-existing tail re-appended. Null if it can't be
 * determined. */
function realpathOfNearestExisting(target: string): string | null {
  let cur = target;
  for (let i = 0; i < 256; i++) {
    if (fs.existsSync(cur)) {
      try {
        const real = fs.realpathSync.native(cur);
        const tail = path.relative(cur, target);
        return tail && tail !== '' ? path.join(real, tail) : real;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break; // reached filesystem root
    cur = parent;
  }
  return null;
}
