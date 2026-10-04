/**
 * Henry AI — Standards / Values System
 *
 * The lens through which Henry weights priorities, advises, and reasons.
 * Not a rigid rule engine — a grounded reference for what matters to this user.
 *
 * Henry uses values to reason like:
 *   "This is urgent, but doesn't seem aligned with your deeper priorities."
 *   "You keep saying simplicity matters — I'm treating this complexity as a cost."
 *   "This lines up with your commitment to follow through."
 *
 * Values are user-created, not prescribed. Henry surfaces them gently.
 * Non-negotiables get flagged; everything else is a weight, not a rule.
 *
 * Categories:
 *   faith        — spiritual priorities, what God first means in practice
 *   family       — family and relationship values
 *   work_ethic   — craftsmanship, integrity in work, follow-through
 *   integrity    — honesty, consistency between words and actions
 *   stewardship  — money, time, resources — how they're held and spent
 *   health       — rest, sustainability, physical care
 *   creative     — creative standards and taste
 *   pace         — simplicity, calm, what slow can mean
 *   principle    — personal non-negotiables that don't fit elsewhere
 */

import type { LifeArea } from './lifeAreas';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ValueCategory =
  | 'faith'
  | 'family'
  | 'work_ethic'
  | 'integrity'
  | 'stewardship'
  | 'health'
  | 'creative'
  | 'pace'
  | 'principle';

export interface UserValue {
  id: string;
  title: string;
  description?: string;
  category: ValueCategory;
  importance: number;      // 1–10
  nonNegotiable: boolean;  // if true, Henry weights this heavily and flags conflicts
  lifeArea?: LifeArea;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const VALUES_KEY = 'henry:values:v1';
const MAX_VALUES = 30;

function safeLoad(): UserValue[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(VALUES_KEY);
    return raw ? (JSON.parse(raw) as UserValue[]) : [];
  } catch { return []; }
}

function safeSave(items: UserValue[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(VALUES_KEY, JSON.stringify(items));
  } catch { /* storage full */ }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Load active values sorted by non-negotiable flag then importance. */
export function loadValues(): UserValue[] {
  return safeLoad()
    .filter((v) => v.active)
    .sort((a, b) => {
      if (a.nonNegotiable !== b.nonNegotiable) return a.nonNegotiable ? -1 : 1;
      return b.importance - a.importance;
    });
}

/** Load all values including inactive (for settings panel). */
export function loadAllValues(): UserValue[] {
  return safeLoad().sort((a, b) => {
    if (a.nonNegotiable !== b.nonNegotiable) return a.nonNegotiable ? -1 : 1;
    return b.importance - a.importance;
  });
}

export function addValue(
  title: string,
  category: ValueCategory,
  opts: Partial<Pick<UserValue, 'description' | 'importance' | 'nonNegotiable' | 'lifeArea'>> = {},
): UserValue {
  const all = safeLoad();
  const now = new Date().toISOString();
  const item: UserValue = {
    id: crypto.randomUUID(),
    title: title.trim().slice(0, 150),
    description: opts.description?.trim().slice(0, 400),
    category,
    importance: opts.importance ?? 5,
    nonNegotiable: opts.nonNegotiable ?? false,
    lifeArea: opts.lifeArea,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  const trimmed = [item, ...all].slice(0, MAX_VALUES);
  safeSave(trimmed);
  return item;
}

export function updateValue(id: string, patch: Partial<Omit<UserValue, 'id' | 'createdAt'>>): void {
  const all = safeLoad();
  const idx = all.findIndex((v) => v.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch, id: all[idx].id, createdAt: all[idx].createdAt, updatedAt: new Date().toISOString() };
  safeSave(all);
}

export function deactivateValue(id: string): void {
  updateValue(id, { active: false });
}

export function toggleNonNegotiable(id: string): void {
  const all = safeLoad();
  const item = all.find((v) => v.id === id);
  if (!item) return;
  updateValue(id, { nonNegotiable: !item.nonNegotiable });
}

// ── Charter Block ─────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<ValueCategory, string> = {
  faith: 'Faith', family: 'Family', work_ethic: 'Work ethic', integrity: 'Integrity',
  stewardship: 'Stewardship', health: 'Health', creative: 'Creative', pace: 'Pace',
  principle: 'Principle',
};

/**
 * Build the values system prompt block.
 * Injects up to 5 active values — non-negotiables first — as a reference lens
 * Henry uses when weighting decisions, priorities, and suggestions.
 * Only fires when the user has set at least one value.
 */
export function buildValuesBlock(): string {
  if (typeof localStorage === 'undefined') return '';

  const values = loadValues().slice(0, 5);
  if (values.length === 0) return '';

  const lines = values.map((v) => {
    const cat = CATEGORY_LABEL[v.category];
    const flag = v.nonNegotiable ? ' — non-negotiable' : v.importance >= 8 ? ' — high priority' : '';
    const desc = v.description ? `: ${v.description.slice(0, 80)}` : '';
    return `- [${cat}${flag}] ${v.title}${desc}`;
  });

  return `## Your Values & Standards
Use these as a lens when weighting priorities, suggestions, and alignment:\n${lines.join('\n')}`;
}
