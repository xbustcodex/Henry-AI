/**
 * Writer / document mode — system-prompt additions (structured markdown, no fluff).
 */

import type { WriterDocumentTypeId } from './documentTypes';
import { DEFAULT_WRITER_DOCUMENT_TYPE_ID, getWriterDocumentType } from './documentTypes';
import { getDocumentScaffoldMarkdown } from './formatDocumentDraft';

/** Core writer discipline (mode-level). */
export function getWriterModeInstruction(_documentTypeId?: WriterDocumentTypeId): string {
  return `You are Henry in Writer / document mode: calm, wise, strong, and direct. Turn the user's goal into a structured deliverable — not a generic chat wall.

Rules:
- Prefer headings (H1 for title, H2/H3 for sections), short paragraphs, and bullets for lists, requirements, and tasks.
- Make the output easy to save as markdown and reuse; avoid filler, hedging stacks, and corporate padding.
- Default to concise; expand only when the task clearly needs depth.
- Support iteration: offer to refine sections, tighten tone, or produce an outline first if the ask is ambiguous.
- End with concrete next steps or open questions when appropriate.`;
}

export function getDocumentScaffoldHint(documentTypeId: WriterDocumentTypeId): string {
  const id =
    documentTypeId && getWriterDocumentType(documentTypeId)
      ? documentTypeId
      : DEFAULT_WRITER_DOCUMENT_TYPE_ID;
  const t = getWriterDocumentType(id)!;
  const flow = t.defaultSections.join(' → ');
  return `Active document type: **${t.label}** — ${t.description}
Suggested section flow: ${flow}. Adapt section titles if the user's request implies a different shape; keep structure intentional.`;
}

export interface BuildWriterSystemAdditionOptions {
  /** Workspace-relative path to a draft the user chose for continuity (contents not loaded here). */
  activeDraftRelativePath?: string | null;
}

function buildWriterActiveDraftSection(relativePath: string): string {
  const p = relativePath.trim();
  return `## Active draft file (path only)
The user marked \`${p}\` as the Writer draft they are **continuing or revising**. This is a **continuity hint** — the file body is **not** loaded into the system prompt. Do not invent or quote unseen text; ask for paste or summaries when specifics matter. Prefer lean follow-up: build on chat history and explicit user input.`;
}

/**
 * Full block appended in Companion system prompt when operating mode is \`writer\`.
 */
export function buildWriterSystemAddition(
  documentTypeId?: WriterDocumentTypeId,
  options?: BuildWriterSystemAdditionOptions
): string {
  const id =
    documentTypeId && getWriterDocumentType(documentTypeId)
      ? documentTypeId
      : DEFAULT_WRITER_DOCUMENT_TYPE_ID;

  const scaffold = getDocumentScaffoldMarkdown(id);
  const draftPath = options?.activeDraftRelativePath?.trim() || null;
  const draftBlock = draftPath ? `\n${buildWriterActiveDraftSection(draftPath)}\n` : '';

  return `${getWriterModeInstruction(id)}

${getDocumentScaffoldHint(id)}
${draftBlock}
If useful, you may start from this empty scaffold (replace entirely when the user already provided structure):
\`\`\`markdown
${scaffold.trimEnd()}
\`\`\``;
}
