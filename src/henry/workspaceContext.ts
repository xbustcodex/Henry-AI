/**
 * User-selected workspace path for chat (file or folder) — path-first, honest about loading.
 */

export const HENRY_ACTIVE_WORKSPACE_CONTEXT_KEY = 'henry_active_workspace_context_v1';
export const HENRY_WORKSPACE_CONTEXT_CHANGED_EVENT = 'henry-workspace-context-changed';

export type WorkspaceContextKind = 'file' | 'folder';

export interface ActiveWorkspaceContext {
  /** Path relative to workspace root (forward slashes). */
  path: string;
  kind: WorkspaceContextKind;
  /** Short display label (usually basename). */
  label: string;
}

function normalizeRelativePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

export function contextBasename(path: string): string {
  const n = normalizeRelativePath(path);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) || n : n || path;
}

export function readActiveWorkspaceContext(): ActiveWorkspaceContext | null {
  try {
    const raw = localStorage.getItem(HENRY_ACTIVE_WORKSPACE_CONTEXT_KEY)?.trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    const path = typeof o.path === 'string' ? normalizeRelativePath(o.path) : '';
    const kind = o.kind === 'folder' ? 'folder' : o.kind === 'file' ? 'file' : null;
    if (!path || !kind) return null;
    const label =
      typeof o.label === 'string' && o.label.trim() ? o.label.trim() : contextBasename(path);
    return { path, kind, label };
  } catch {
    return null;
  }
}

export function setActiveWorkspaceContext(params: {
  path: string;
  kind: WorkspaceContextKind;
  label?: string;
}): void {
  const path = normalizeRelativePath(params.path);
  if (!path) return;
  const label = params.label?.trim() || contextBasename(path);
  const ctx: ActiveWorkspaceContext = { path, kind: params.kind, label };
  try {
    localStorage.setItem(HENRY_ACTIVE_WORKSPACE_CONTEXT_KEY, JSON.stringify(ctx));
    window.dispatchEvent(
      new CustomEvent(HENRY_WORKSPACE_CONTEXT_CHANGED_EVENT, { detail: { context: ctx } })
    );
  } catch {
    /* ignore */
  }
}

export function clearActiveWorkspaceContext(): void {
  try {
    localStorage.removeItem(HENRY_ACTIVE_WORKSPACE_CONTEXT_KEY);
    window.dispatchEvent(
      new CustomEvent(HENRY_WORKSPACE_CONTEXT_CHANGED_EVENT, { detail: { context: null } })
    );
  } catch {
    /* ignore */
  }
}

/**
 * Match workspace_index hints from lean memory (query-based); may be empty or unrelated.
 */
export function findIndexHintForContext(
  ctx: ActiveWorkspaceContext,
  hints: ReadonlyArray<{ file_path: string; summary: string }>
): string | null {
  const norm = normalizeRelativePath(ctx.path);
  for (const h of hints) {
    const hp = normalizeRelativePath(h.file_path);
    const sum = (h.summary || '').trim();
    if (!sum) continue;
    if (ctx.kind === 'file' && hp === norm) return sum.length > 400 ? `${sum.slice(0, 399)}…` : sum;
    if (ctx.kind === 'folder' && (hp === norm || hp.startsWith(`${norm}/`)))
      return sum.length > 400 ? `${sum.slice(0, 399)}…` : sum;
  }
  return null;
}

const HONESTY =
  'This context is a selected workspace reference. Henry knows the path and any lightweight index hint below — not full file contents unless you paste them or they appear in chat history. Selected workspace context guides Henry without replaying entire files.';

export function buildWorkspaceContextPromptSection(
  ctx: ActiveWorkspaceContext,
  options?: { indexSummaryHint?: string | null }
): string {
  const hint = options?.indexSummaryHint?.trim();
  const lines: string[] = [
    '## Active workspace selection (user-chosen)',
    `- Path (workspace-relative): \`${ctx.path}\``,
    `- Type: **${ctx.kind}**`,
    `- Label: ${ctx.label}`,
    `- ${HONESTY}`,
  ];
  if (hint) {
    lines.push(`- Workspace index hint (may be partial or stale): ${hint}`);
  } else {
    lines.push('- No matching workspace index summary for this path in the current memory query — treat as path-only.');
  }
  return lines.join('\n');
}

export function buildWorkspaceContextSummaryPlain(
  ctx: ActiveWorkspaceContext,
  indexHint?: string | null
): string {
  const hintLine = indexHint?.trim()
    ? `Index hint (lightweight): ${indexHint.trim()}`
    : 'Index hint: none for this path in current query.';
  return [
    `Workspace context: ${ctx.kind} — ${ctx.label}`,
    `Path: ${ctx.path}`,
    '',
    HONESTY,
    '',
    hintLine,
    '',
    'Selected workspace context guides Henry without replaying entire files.',
  ].join('\n');
}

export function buildUseWorkspaceContextComposerSeed(ctx: ActiveWorkspaceContext): string {
  return `Using the selected workspace ${ctx.kind} context \`${ctx.path}\` (${ctx.label}) — help me with: `;
}
