/**
 * The filesystem surface the System Map is allowed to touch.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The map must not read file contents. "Must not" is not enforceable by a
 * comment on a function that also happens to need to list directories — so the
 * capability is removed from the type instead. `MetadataFs` has exactly two
 * operations: list a directory's names, and stat one path. There is no read, no
 * open, no stream, no byte. A scanner written against this interface cannot
 * ingest a file even by accident, and the test suite proves it by spying on the
 * underlying module and asserting that the only calls which ever happen are
 * `readdir` and `lstat`.
 *
 * `lstat` rather than `stat` on purpose: a symlink is recorded as a symlink and
 * is never followed. Following links is how a scan ends up in a cycle, or in
 * another person's home through a shortcut, and neither is worth the metadata.
 *
 * Everything the map knows about a file comes from its name and from the three
 * numbers `stat` returns: size, mtime, birthtime.
 */

import { promises as fsp } from 'node:fs';

/** One entry as `readdir(..., { withFileTypes: true })` reports it. */
export interface DirEntryInfo {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

/** The three facts about a path that are metadata rather than content. */
export interface PathStatInfo {
  /** Bytes, for files. Zero for directories. */
  sizeBytes: number;
  /** Epoch ms. */
  modifiedAt: number;
  /** Epoch ms, or `null` when the platform does not record one. */
  createdAt: number | null;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

/**
 * Everything the scanner may ask the filesystem.
 *
 * Note what is absent: there is no `readFile`, no `readText`, no `open`. The
 * absence is the feature.
 *
 * ── Do not add a third method without thinking about this ──────────────────
 *
 * "The map never reads file contents" is not enforced by a comment or by a
 * test that greps for `readFile`; it is enforced *structurally*, by this type
 * having exactly these two operations. Nothing can read a file's bytes because
 * the scanner has no way to ask for them.
 *
 * That means adding a third method here silently removes the guarantee — not
 * gradually, but at the moment it lands. Before adding one, ask what breaks if
 * it can be handed to the scanner, and update `CONTENTS_NEVER_READ`
 * (`src/henry/systemMap.ts`) and the copy on screen in the same change, or do
 * not add it.
 */
export interface MetadataFs {
  /** Names and kinds of a directory's direct children. Throws if unreadable. */
  readDir(dirPath: string): Promise<DirEntryInfo[]>;
  /** Size and timestamps for one path. Throws if it does not exist. */
  stat(targetPath: string): Promise<PathStatInfo>;
}

/** The real filesystem, restricted to the two operations above. */
export function nodeMetadataFs(): MetadataFs {
  return {
    async readDir(dirPath: string): Promise<DirEntryInfo[]> {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        // A symlink is reported as a symlink even when it points at a
        // directory: whether it points somewhere is exactly what we refuse to
        // find out.
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    },
    async stat(targetPath: string): Promise<PathStatInfo> {
      const s = await fsp.lstat(targetPath);
      return {
        sizeBytes: s.isDirectory() ? 0 : s.size,
        modifiedAt: s.mtimeMs,
        createdAt: s.birthtimeMs > 0 ? s.birthtimeMs : null,
        isDirectory: s.isDirectory(),
        isFile: s.isFile(),
        isSymbolicLink: s.isSymbolicLink(),
      };
    },
  };
}