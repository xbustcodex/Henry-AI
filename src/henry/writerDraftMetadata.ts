/**
 * Lightweight metadata prefix for Writer-mode markdown saves (HTML comment, like Design3D).
 */

import type { WriterDocumentTypeId } from './documentTypes';
import { getWriterDocumentType } from './documentTypes';

export interface WriterDraftMetadataFields {
  documentTypeId: WriterDocumentTypeId;
  documentTypeLabel: string;
  relativePath: string;
  workspaceHint?: string | null;
}

/** First ~2k is enough for the comment block. */
const PEEK_LEN = 2048;

export function prependWriterDraftMetadata(
  body: string,
  meta: WriterDraftMetadataFields
): string {
  // Idempotent: don't prepend if metadata comment already exists
  if (body.trimStart().startsWith('<!--') && body.includes('Henry Writer draft')) {
    return body;
  }
  const t = getWriterDocumentType(meta.documentTypeId);
  const when = new Date().toISOString();
  const ws = meta.workspaceHint?.trim();
  const lines = [
    '<!--',
    'Henry Writer draft',
    `document_type_id: ${meta.documentTypeId}`,
    `document_type_label: ${t?.label ?? meta.documentTypeLabel}`,
    `relative_save_path: ${meta.relativePath.trim()}`,
    `generated: ${when}`,
    'generated_by: Henry AI (Writer mode)',
    'mode: writer',
    ws ? `workspace_hint: ${ws.slice(0, 200)}` : 'workspace_hint: (not recorded)',
    'note: File body is not auto-loaded into prompts — user continues via chat or paste.',
    '-->',
    '',
  ];
  return `${lines.join('\n')}${body.trimStart()}`;
}

export interface ParsedWriterDraftMetadata {
  documentTypeId?: string;
  documentTypeLabel?: string;
  relativePath?: string;
}

/**
 * Best-effort parse of our metadata comment from saved markdown (for indexing / display).
 */
export function parseWriterDraftMetadataFromContent(content: string): ParsedWriterDraftMetadata | null {
  const head = content.slice(0, PEEK_LEN);
  if (!head.includes('Henry Writer draft')) return null;
  const close = head.indexOf('-->');
  if (close < 0) return null;
  const block = head.slice(0, close);
  const out: ParsedWriterDraftMetadata = {};
  const pick = (key: string): string | undefined => {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'im');
    const m = block.match(re);
    return m?.[1]?.trim();
  };
  const id = pick('document_type_id');
  const label = pick('document_type_label');
  const rp = pick('relative_save_path');
  if (id) out.documentTypeId = id as WriterDocumentTypeId;
  if (label) out.documentTypeLabel = label;
  if (rp) out.relativePath = rp;
  return Object.keys(out).length ? out : null;
}
