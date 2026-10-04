/**
 * Henry AI — Relationship System
 *
 * A central place for people who matter — not a CRM, not a contact list.
 * Henry tracks who someone is, what's open, and what relational context exists
 * so important people and obligations don't get lost in a generic task pile.
 *
 * Relationship types:
 *   family       — spouse, parent, sibling, extended family
 *   friend       — personal friendships
 *   work         — colleagues, professional contacts
 *   collaborator — creative or project partners
 *   client       — people or orgs you serve
 *   vendor       — people or services you depend on
 *   mentor       — advisors, coaches, spiritual direction
 *   faith        — church/community relationships
 *   recurring    — people who show up regularly in life or work
 */

import type { LifeArea } from './lifeAreas';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RelationshipType =
  | 'family'
  | 'friend'
  | 'work'
  | 'collaborator'
  | 'client'
  | 'vendor'
  | 'mentor'
  | 'faith'
  | 'recurring';

export interface Relationship {
  id: string;
  name: string;
  type: RelationshipType;
  notes?: string;
  importance: number;       // 1–10; shapes priority + charter surfacing
  lastInteraction?: string; // ISO date — last known contact or mention
  followUpNeeded: boolean;
  followUpNote?: string;    // what specifically needs follow-up
  openLoops?: string[];     // unresolved threads with this person
  lifeArea?: LifeArea;
  relatedCommitmentIds?: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const RELATIONSHIP_KEY = 'henry:relationships:v1';
const MAX_RELATIONSHIPS = 60;

function safeLoad(): Relationship[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(RELATIONSHIP_KEY);
    return raw ? (JSON.parse(raw) as Relationship[]) : [];
  } catch { return []; }
}

function safeSave(items: Relationship[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(RELATIONSHIP_KEY, JSON.stringify(items));
  } catch { /* storage full */ }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Load all relationships sorted by importance then recency. */
export function loadRelationships(): Relationship[] {
  return safeLoad().sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

/** Load relationships that have open follow-ups or recent interaction. */
export function loadActiveRelationships(): Relationship[] {
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  return loadRelationships().filter((r) => {
    const recentInteraction = r.lastInteraction
      ? new Date(r.lastInteraction).getTime() > sevenDaysAgo
      : false;
    return r.followUpNeeded || recentInteraction;
  });
}

export function addRelationship(
  name: string,
  type: RelationshipType,
  opts: Partial<Pick<Relationship, 'notes' | 'importance' | 'lifeArea' | 'followUpNeeded' | 'followUpNote'>> = {},
): Relationship {
  const all = safeLoad();
  const now = new Date().toISOString();
  const item: Relationship = {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 100),
    type,
    notes: opts.notes?.trim().slice(0, 300),
    importance: opts.importance ?? 5,
    lifeArea: opts.lifeArea,
    followUpNeeded: opts.followUpNeeded ?? false,
    followUpNote: opts.followUpNote?.trim(),
    openLoops: [],
    createdAt: now,
    updatedAt: now,
  };
  const trimmed = [item, ...all].slice(0, MAX_RELATIONSHIPS);
  safeSave(trimmed);
  return item;
}

export function updateRelationship(id: string, patch: Partial<Omit<Relationship, 'id' | 'createdAt'>>): void {
  const all = safeLoad();
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch, id: all[idx].id, createdAt: all[idx].createdAt, updatedAt: new Date().toISOString() };
  safeSave(all);
}

export function clearFollowUp(id: string): void {
  updateRelationship(id, { followUpNeeded: false, followUpNote: undefined });
}

export function markFollowUpNeeded(id: string, note?: string): void {
  updateRelationship(id, { followUpNeeded: true, followUpNote: note });
}

export function touchRelationship(id: string, interactionDate?: string): void {
  updateRelationship(id, { lastInteraction: interactionDate ?? new Date().toISOString() });
}

export function deleteRelationship(id: string): void {
  const all = safeLoad().filter((r) => r.id !== id);
  safeSave(all);
}

// ── Charter Block ─────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<RelationshipType, string> = {
  family: 'Family', friend: 'Friend', work: 'Work', collaborator: 'Collaborator',
  client: 'Client', vendor: 'Vendor', mentor: 'Mentor', faith: 'Faith', recurring: 'Recurring',
};

function daysSince(iso?: string): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
}

function daysLabel(n: number | null): string {
  if (n === null) return '';
  if (n === 0) return 'today';
  if (n === 1) return '1 day ago';
  return `${n} days ago`;
}

/**
 * Build the relationship context block for the system prompt.
 * Shows up to 4 active relationship threads — people needing follow-up
 * or recently interacted with. Only injects when there's something real to say.
 */
export function buildRelationshipBlock(): string {
  if (typeof localStorage === 'undefined') return '';

  const active = loadActiveRelationships().slice(0, 4);
  if (active.length === 0) return '';

  const lines = active.map((r) => {
    const type = TYPE_LABEL[r.type];
    const days = daysSince(r.lastInteraction);
    const contact = days !== null ? ` — last contact ${daysLabel(days)}` : '';
    const followUp = r.followUpNeeded
      ? ` — follow-up needed${r.followUpNote ? `: ${r.followUpNote}` : ''}`
      : '';
    const loops = r.openLoops?.length ? ` — ${r.openLoops.length} open loop${r.openLoops.length > 1 ? 's' : ''}` : '';
    return `- ${r.name} (${type})${followUp}${contact}${loops}`;
  });

  return `## Active Relationship Threads
People with open context, follow-ups, or recent interaction:\n${lines.join('\n')}`;
}
