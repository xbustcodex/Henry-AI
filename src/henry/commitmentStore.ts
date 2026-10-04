/**
 * Henry AI — Commitment System
 *
 * Tracks durable obligations that matter and should not quietly disappear.
 * This is distinct from working memory (auto-extracted, session-scoped, ephemeral).
 * Commitments are intentionally held — they survive across weeks.
 *
 * Types:
 *   personal   — personal life pledges ("I'm going to call Dad this week")
 *   project    — work/project obligations ("Launch the integration before launch")
 *   relational — follow-ups and promises to people ("I owe the client a proposal")
 *   recurring  — things that repeat or need ongoing attention
 *   henry      — things Henry specifically agreed to help hold or research
 *
 * Status lifecycle:
 *   open → active → waiting / blocked → resolved
 *                                     → dropped (consciously released)
 */

import type { LifeArea } from './lifeAreas';
import { inferLifeArea } from './lifeAreas';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CommitmentType =
  | 'personal'
  | 'project'
  | 'relational'
  | 'recurring'
  | 'henry';

export type CommitmentStatus =
  | 'open'      // active and unresolved
  | 'active'    // currently in progress
  | 'waiting'   // waiting on someone or something external
  | 'blocked'   // can't move forward — has an explicit blocker
  | 'resolved'  // completed / done
  | 'dropped';  // consciously released

export interface Commitment {
  id: string;
  title: string;
  description?: string;
  type: CommitmentType;
  status: CommitmentStatus;
  lifeArea?: LifeArea;
  relatedThreadId?: string;
  dueAt?: string;          // ISO date — optional target date
  weight: number;          // 1–10 importance; higher = surfaces more readily
  blockedReason?: string;  // only used when status = 'blocked'
  createdAt: string;
  lastTouchedAt: string;
  resolvedAt?: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const COMMITMENT_KEY = 'henry:commitments:v1';
const MAX_COMMITMENTS = 50;

function safeLoad(): Commitment[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(COMMITMENT_KEY);
    return raw ? (JSON.parse(raw) as Commitment[]) : [];
  } catch { return []; }
}

function safeSave(items: Commitment[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(COMMITMENT_KEY, JSON.stringify(items));
  } catch { /* storage full */ }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Load all commitments that are not resolved or dropped, sorted by weight + recency. */
export function loadOpenCommitments(): Commitment[] {
  return safeLoad()
    .filter((c) => c.status !== 'resolved' && c.status !== 'dropped')
    .sort((a, b) => {
      // Weight first, then recency
      if (b.weight !== a.weight) return b.weight - a.weight;
      return new Date(b.lastTouchedAt).getTime() - new Date(a.lastTouchedAt).getTime();
    });
}

/** Load all commitments including resolved/dropped (for management UI). */
export function loadAllCommitments(): Commitment[] {
  return safeLoad().sort((a, b) =>
    new Date(b.lastTouchedAt).getTime() - new Date(a.lastTouchedAt).getTime(),
  );
}

export function addCommitment(
  title: string,
  type: CommitmentType,
  opts: Partial<Pick<Commitment, 'description' | 'lifeArea' | 'dueAt' | 'weight' | 'relatedThreadId'>> = {},
): Commitment {
  const all = safeLoad();
  const now = new Date().toISOString();
  const item: Commitment = {
    id: crypto.randomUUID(),
    title: title.trim().slice(0, 200),
    description: opts.description?.trim().slice(0, 500),
    type,
    status: 'open',
    lifeArea: opts.lifeArea ?? inferLifeArea(title) ?? undefined,
    relatedThreadId: opts.relatedThreadId,
    dueAt: opts.dueAt,
    weight: opts.weight ?? 5,
    createdAt: now,
    lastTouchedAt: now,
  };
  const trimmed = [item, ...all].slice(0, MAX_COMMITMENTS);
  safeSave(trimmed);
  return item;
}

export function updateCommitmentStatus(id: string, status: CommitmentStatus, blockedReason?: string): void {
  const all = safeLoad();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const now = new Date().toISOString();
  all[idx] = {
    ...all[idx],
    status,
    blockedReason: (status === 'blocked' || status === 'waiting') ? blockedReason : undefined,
    lastTouchedAt: now,
    resolvedAt: status === 'resolved' ? now : all[idx].resolvedAt,
  };
  safeSave(all);
}

export function resolveCommitment(id: string): void {
  updateCommitmentStatus(id, 'resolved');
}

export function dropCommitment(id: string): void {
  updateCommitmentStatus(id, 'dropped');
}

export function touchCommitment(id: string): void {
  const all = safeLoad();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], lastTouchedAt: new Date().toISOString() };
  safeSave(all);
}

/** Update any field on a commitment. */
export function updateCommitment(id: string, patch: Partial<Omit<Commitment, 'id' | 'createdAt'>>): void {
  const all = safeLoad();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch, id: all[idx].id, createdAt: all[idx].createdAt, lastTouchedAt: new Date().toISOString() };
  safeSave(all);
}

// ── System Prompt Block ───────────────────────────────────────────────────────

const TYPE_LABEL: Record<CommitmentType, string> = {
  personal:   'Personal',
  project:    'Project',
  relational: 'Relational',
  recurring:  'Recurring',
  henry:      'Henry agreed',
};

const STATUS_SUFFIX: Partial<Record<CommitmentStatus, string>> = {
  waiting: ' — waiting',
  blocked: ' — blocked',
  active:  ' — in progress',
};

function isOverdue(dueAt?: string): boolean {
  return !!dueAt && new Date(dueAt).getTime() < Date.now();
}

/**
 * Build the commitments system prompt block.
 * Henry uses this to hold open obligations naturally without nagging.
 * Max 5 items. Resolves silently — never guilt-heavy.
 */
export function buildCommitmentsBlock(): string {
  if (typeof localStorage === 'undefined') return '';

  const open = loadOpenCommitments().slice(0, 5);
  if (open.length === 0) return '';

  const lines = open.map((c) => {
    const type = TYPE_LABEL[c.type];
    const suffix = STATUS_SUFFIX[c.status] ?? '';
    const overdue = isOverdue(c.dueAt) ? ' — overdue' : '';
    return `- [${type}${overdue || suffix}] ${c.title}`;
  });

  return `## Open Commitments
Things still held open — carry these honestly without force:\n${lines.join('\n')}`;
}
