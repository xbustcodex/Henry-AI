/**
 * List recent Writer drafts from workspace Henry-Drafts/ via existing readDirectory IPC.
 */

import type { FileEntry } from '../types';
import { HENRY_WRITER_DRAFTS_SUBDIR } from './documentFilename';
import {
  WRITER_DOCUMENT_TYPES,
  type WriterDocumentTypeId,
  isWriterDocumentTypeId,
} from './documentTypes';
import { parseWriterDraftMetadataFromContent } from './writerDraftMetadata';

export interface WriterDraftListEntry {
  relativePath: string;
  filename: string;
  modified: string | null;
  documentTypeLabel: string | null;
  documentTypeId: WriterDocumentTypeId | null;
}

/**
 * Infer document type from standard Henry filename: `Henry AI – {filenameLabel} – …`
 */
export function inferWriterTypeFromFilename(filename: string): {
  label: string | null;
  id: WriterDocumentTypeId | null;
} {
  const m = filename.match(/^Henry AI [\u2013-] (.+?) [\u2013-] /u);
  if (!m) return { label: null, id: null };
  const segment = m[1].trim();
  const t = WRITER_DOCUMENT_TYPES.find(
    (x) => x.filenameLabel === segment || x.label === segment
  );
  return { label: segment, id: t?.id ?? null };
}

/**
 * Optional enrichment: read file head to parse metadata (overrides filename guess when present).
 */
async function peekEntryMeta(relativePath: string): Promise<ParsedWriterMeta | null> {
  try {
    const text = await window.henryAPI.readFile(relativePath);
    return parseWriterDraftMetadataFromContent(text);
  } catch {
    return null;
  }
}

type ParsedWriterMeta = ReturnType<typeof parseWriterDraftMetadataFromContent>;

function mergeMeta(
  filename: string,
  parsed: ParsedWriterMeta | null
): Pick<WriterDraftListEntry, 'documentTypeLabel' | 'documentTypeId'> {
  const parsedId =
    parsed?.documentTypeId && isWriterDocumentTypeId(parsed.documentTypeId)
      ? parsed.documentTypeId
      : null;
  if (parsedId && parsed?.documentTypeLabel) {
    return { documentTypeId: parsedId, documentTypeLabel: parsed.documentTypeLabel };
  }
  if (parsed?.documentTypeLabel) {
    const t = WRITER_DOCUMENT_TYPES.find((x) => x.label === parsed.documentTypeLabel);
    return {
      documentTypeLabel: parsed.documentTypeLabel,
      documentTypeId: t?.id ?? parsedId,
    };
  }
  const inferred = inferWriterTypeFromFilename(filename);
  return {
    documentTypeLabel: inferred.label,
    documentTypeId: inferred.id,
  };
}

export interface ListRecentWriterDraftsOptions {
  limit?: number;
}

/**
 * Returns markdown files under Henry-Drafts/, newest first.
 * Peeks file heads only when the filename does not match the standard Henry pattern (cheap metadata).
 */
export async function listRecentWriterDrafts(
  options?: ListRecentWriterDraftsOptions
): Promise<WriterDraftListEntry[]> {
  const limit = Math.min(Math.max(options?.limit ?? 12, 1), 40);

  let result;
  try {
    result = await window.henryAPI.readDirectory(HENRY_WRITER_DRAFTS_SUBDIR);
  } catch {
    return [];
  }

  const files = (result.entries || [])
    .filter((e: FileEntry) => !e.isDirectory && e.name.toLowerCase().endsWith('.md'))
    .map((e: FileEntry) => ({
      relativePath: e.path.replace(/\\/g, '/'),
      filename: e.name,
      modified: e.modified ?? null,
    }))
    .sort(
      (
        a: { relativePath: string; filename: string; modified: string | null },
        b: { relativePath: string; filename: string; modified: string | null }
      ) => {
      const ta = a.modified ? Date.parse(a.modified) : 0;
      const tb = b.modified ? Date.parse(b.modified) : 0;
      return tb - ta;
    }
    )
    .slice(0, limit);

  const out: WriterDraftListEntry[] = [];
  for (const f of files) {
    const inferred = inferWriterTypeFromFilename(f.filename);
    let meta: ParsedWriterMeta | null = null;
    if (!inferred.id) {
      meta = await peekEntryMeta(f.relativePath);
    }
    const { documentTypeLabel, documentTypeId } = mergeMeta(f.filename, meta);
    out.push({
      relativePath: f.relativePath,
      filename: f.filename,
      modified: f.modified,
      documentTypeLabel,
      documentTypeId,
    });
  }
  return out;
}

/** Parent directory relative to workspace (empty string = workspace root). */
export function writerDraftDirForPath(relativeFilePath: string): string {
  const norm = relativeFilePath.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(0, i) : '';
}
