/**
 * Active Writer draft selection (path-only context; no auto file load).
 */

export const HENRY_WRITER_ACTIVE_DRAFT_KEY = 'henry_writer_active_draft_path';
export const HENRY_WRITER_CONTEXT_CHANGED_EVENT = 'henry_writer_context_changed';

/** Navigate Files tab to this relative directory on next mount (workspace-relative). */
export const HENRY_FILES_NAVIGATE_DIR_KEY = 'henry_files_open_relative_dir';

export function readWriterActiveDraftPath(): string | null {
  try {
    const raw = localStorage.getItem(HENRY_WRITER_ACTIVE_DRAFT_KEY)?.trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function setWriterActiveDraftPath(path: string | null): void {
  try {
    if (path?.trim()) {
      localStorage.setItem(HENRY_WRITER_ACTIVE_DRAFT_KEY, path.trim());
    } else {
      localStorage.removeItem(HENRY_WRITER_ACTIVE_DRAFT_KEY);
    }
    window.dispatchEvent(
      new CustomEvent(HENRY_WRITER_CONTEXT_CHANGED_EVENT, {
        detail: { path: path?.trim() || null },
      })
    );
  } catch {
    /* ignore */
  }
}

export function requestFilesTabOpenRelativeDir(relativeDir: string): void {
  const d = relativeDir.trim().replace(/\/+$/, '');
  if (!d) return;
  try {
    localStorage.setItem(HENRY_FILES_NAVIGATE_DIR_KEY, d);
  } catch {
    /* ignore */
  }
}
