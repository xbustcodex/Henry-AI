/**
 * Lightweight markdown scaffold before or alongside model output.
 */

import type { WriterDocumentTypeId } from './documentTypes';
import { getWriterDocumentType } from './documentTypes';

export function getDocumentScaffoldMarkdown(documentTypeId: WriterDocumentTypeId): string {
  const t = getWriterDocumentType(documentTypeId);
  if (!t) {
    return '# Document\n\n';
  }
  const lines: string[] = [`# ${t.label}`, '', `*${t.description}*`, ''];
  for (const section of t.defaultSections) {
    lines.push(`## ${section}`, '', '_…_', '');
  }
  return lines.join('\n').trimEnd() + '\n';
}
