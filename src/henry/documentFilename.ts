/**
 * Suggested filenames for Writer-mode saves (workspace-relative).
 */

import type { WriterDocumentTypeId } from './documentTypes';
import { getWriterDocumentType } from './documentTypes';

function sanitizeFilenameSegment(segment: string): string {
  return segment
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * e.g. `Henry AI – Vision Brief – Apr 2026 v1.md`
 */
export function buildHenryDocumentFilename(
  documentTypeId: WriterDocumentTypeId,
  options?: { date?: Date; version?: number }
): string {
  const t = getWriterDocumentType(documentTypeId);
  const label = sanitizeFilenameSegment(t?.filenameLabel ?? 'Document');
  const d = options?.date ?? new Date();
  const monthYear = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  const v = options?.version ?? 1;
  const base = `Henry AI – ${label} – ${monthYear} v${v}.md`;
  return sanitizeFilenameSegment(base.replace(/ – /g, ' – ')) || 'Henry-AI-Document.md';
}

/** Default subfolder for writer saves */
export const HENRY_WRITER_DRAFTS_SUBDIR = 'Henry-Drafts';

export function defaultWriterDraftRelativePath(documentTypeId: WriterDocumentTypeId): string {
  return `${HENRY_WRITER_DRAFTS_SUBDIR}/${buildHenryDocumentFilename(documentTypeId)}`;
}
