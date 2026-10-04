/**
 * Henry Working Memory Buffer — Layer 3 persistent memory.
 *
 * Tracks what Henry promised to do, unresolved questions, active focus items,
 * and pending next steps. This is the "short-term executive" layer — more
 * durable than conversation history, less permanent than long-term facts.
 *
 * Stored in localStorage. Auto-extracts commitments from Henry's responses.
 * Injected into every system prompt as a high-priority context block.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type WorkingItemType =
  | 'commitment'    // Henry said he'd do something
  | 'question'      // Unresolved user question or decision
  | 'next_step'     // User's explicit next action
  | 'focus'         // Active project/topic focus
  | 'concern'       // Something the user flagged as worrying
  | 'insight';      // An important realization worth carrying forward

export interface WorkingMemoryItem {
  id: string;
  type: WorkingItemType;
  content: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  priority: 'high' | 'normal';
  conversationId?: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const WM_KEY = 'henry:working_memory:v1';
const MAX_ITEMS = 40;

function load(): WorkingMemoryItem[] {
  try {
    const raw = localStorage.getItem(WM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Guard against a legacy/corrupt value that isn't an array — otherwise
    // callers' .filter/.map throw and break the whole chat send path.
    return Array.isArray(parsed) ? (parsed as WorkingMemoryItem[]) : [];
  } catch {
    // Backup corrupted data before discarding so it can be recovered manually
    try {
      const corrupted = localStorage.getItem(WM_KEY);
      if (corrupted) {
        const backupKey = `henry:working_memory:corrupted_backup:${Date.now()}`;
        localStorage.setItem(backupKey, corrupted);
        console.warn('[Henry] Working memory corrupted — backed up to', backupKey);
      }
    } catch { /* ignore backup failure */ }
    return [];
  }
}

function save(items: WorkingMemoryItem[]): void {
  try {
    localStorage.setItem(WM_KEY, JSON.stringify(items));
  } catch { /* storage full */ }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function loadWorkingMemory(): WorkingMemoryItem[] {
  return load().filter((i) => !i.resolved);
}

export function loadAllWorkingMemory(): WorkingMemoryItem[] {
  return load();
}

export function addWorkingItem(
  type: WorkingItemType,
  content: string,
  opts: { priority?: 'high' | 'normal'; conversationId?: string } = {},
): WorkingMemoryItem {
  const all = load();
  const now = new Date().toISOString();
  const item: WorkingMemoryItem = {
    id: crypto.randomUUID(),
    type,
    content: content.trim().slice(0, 400),
    createdAt: now,
    updatedAt: now,
    resolved: false,
    priority: opts.priority ?? 'normal',
    conversationId: opts.conversationId,
  };
  const trimmed = [item, ...all].slice(0, MAX_ITEMS);
  save(trimmed);
  return item;
}

export function resolveWorkingItem(id: string): void {
  const all = load();
  const idx = all.findIndex((i) => i.id === id);
  if (idx >= 0) {
    all[idx] = { ...all[idx], resolved: true, updatedAt: new Date().toISOString() };
    save(all);
  }
}

export function clearResolvedItems(): void {
  save(load().filter((i) => !i.resolved));
}

export function clearAllWorkingMemory(): void {
  save([]);
}

// ── Auto-extraction from Henry's responses ────────────────────────────────────

const COMMITMENT_PATTERNS = [
  /\bi'?ll\s+(do|check|find|look|search|research|create|build|draft|write|send|review|follow up|get|set|make|update|summarize|prepare|help)\b.{5,80}/gi,
  /\blet me\s+(do|check|find|look|search|try|get|help|show|pull|build|draft|review)\b.{5,80}/gi,
  /\bi will\s+(do|check|find|look|search|research|create|build|draft|write|help|follow)\b.{5,80}/gi,
  /\bI'?m going to\s+(?:try\s+(?:to\s+)?)?\w.{5,60}/gi,
  /\bI can\s+(do|handle|help|check|build|create|write|find|look into)\b.{5,60}/gi,
  /\bgoing to\s+(?:try\s+(?:to\s+)?)?(?:go ahead and\s+)?\w.{5,60}/gi,
];

const NEXT_STEP_PATTERNS = [
  /\bNext step[s]?[:—]\s*(.{10,120})/gi,
  /\bNext[:—]\s*(.{10,120})/gi,
  /\bYour next action[:—]\s*(.{10,120})/gi,
  /\bAction item[:—]\s*(.{10,120})/gi,
  /\bTo do[:—]\s*(.{10,120})/gi,
  /\b\d+\.\s+(you should|try|consider|start by|begin with|first|next).{10,100}/gi,
];

/**
 * Extract commitments and next steps from Henry's assistant response text.
 * Returns extracted items that can be saved to working memory.
 */
export function extractCommitmentsFromResponse(
  text: string,
  conversationId?: string,
): Array<{ type: WorkingItemType; content: string }> {
  const extracted: Array<{ type: WorkingItemType; content: string }> = [];
  const seen = new Set<string>();

  for (const pattern of COMMITMENT_PATTERNS) {
    const matches = [...text.matchAll(pattern)];
    for (const m of matches) {
      const raw = m[0].trim().replace(/[.,;:!?]+$/, '');
      const key = raw.toLowerCase().slice(0, 60);
      if (!seen.has(key) && raw.length > 10) {
        seen.add(key);
        extracted.push({ type: 'commitment', content: raw });
      }
      if (extracted.length >= 5) break;
    }
  }

  for (const pattern of NEXT_STEP_PATTERNS) {
    const matches = [...text.matchAll(pattern)];
    for (const m of matches) {
      const raw = (m[1] || m[0]).trim().replace(/[.,;!?]+$/, '');
      const key = raw.toLowerCase().slice(0, 60);
      if (!seen.has(key) && raw.length > 10) {
        seen.add(key);
        extracted.push({ type: 'next_step', content: raw });
      }
      if (extracted.length >= 8) break;
    }
  }

  return extracted;
}

/**
 * Auto-save commitments extracted from Henry's response.
 * Call this in onDone after the assistant message is saved.
 */
export function autoSaveCommitments(
  assistantText: string,
  conversationId?: string,
): WorkingMemoryItem[] {
  const extracted = extractCommitmentsFromResponse(assistantText, conversationId);
  const saved: WorkingMemoryItem[] = [];
  for (const e of extracted.slice(0, 4)) {
    saved.push(addWorkingItem(e.type, e.content, { conversationId }));
  }
  return saved;
}

// ── Context injection ─────────────────────────────────────────────────────────

const TYPE_LABEL: Record<WorkingItemType, string> = {
  commitment: 'I said I would',
  question: 'Unresolved',
  next_step: 'Next step',
  focus: 'Active focus',
  concern: 'Concern flagged',
  insight: 'Insight',
};

/**
 * Build the working memory system prompt block.
 * Injected as a high-priority section so Henry carries context forward naturally.
 */
export function buildWorkingMemoryBlock(): string {
  const active = loadWorkingMemory();
  if (active.length === 0) return '';

  // Sort: high priority first, then by recency
  const sorted = [...active].sort((a, b) => {
    if (a.priority === 'high' && b.priority !== 'high') return -1;
    if (b.priority === 'high' && a.priority !== 'high') return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const lines = sorted.slice(0, 15).map((item) => {
    const label = TYPE_LABEL[item.type];
    const age = getRelativeAge(item.createdAt);
    return `- [${label}${age ? ` · ${age}` : ''}] ${item.content}`;
  });

  return `## Active Working Memory\nThings in flight — carry these forward naturally without forcing them:\n${lines.join('\n')}`;
}

function getRelativeAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(ms / 86400000);
  if (mins < 60) return '';
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// ── Narrative memory ──────────────────────────────────────────────────────────

const NARRATIVE_KEY = 'henry:narrative_memory:v1';
const MAX_NARRATIVE_CHARS = 8_000;

export interface NarrativeEntry {
  id: string;
  summary: string;
  themes: string[];
  createdAt: string;
  weekLabel: string;  // e.g. "Week of Apr 7"
}

function getWeekLabel(date: Date): string {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay()); // Sunday
  return `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

export function loadNarrativeMemory(): NarrativeEntry[] {
  try {
    const raw = localStorage.getItem(NARRATIVE_KEY);
    return raw ? (JSON.parse(raw) as NarrativeEntry[]) : [];
  } catch {
    try {
      const corrupted = localStorage.getItem(NARRATIVE_KEY);
      if (corrupted) {
        localStorage.setItem(`henry:narrative_memory:corrupted_backup:${Date.now()}`, corrupted);
        console.warn('[Henry] Narrative memory corrupted — backed up');
      }
    } catch { /* ignore */ }
    return [];
  }
}

/**
 * Append a narrative summary entry. Called periodically or after significant conversations.
 */
export function appendNarrativeEntry(summary: string, themes: string[] = []): NarrativeEntry {
  const all = loadNarrativeMemory();
  const now = new Date();
  const entry: NarrativeEntry = {
    id: crypto.randomUUID(),
    summary: summary.trim().slice(0, 800),
    themes,
    createdAt: now.toISOString(),
    weekLabel: getWeekLabel(now),
  };
  const updated = [entry, ...all].slice(0, 20); // Keep last 20 entries
  try {
    localStorage.setItem(NARRATIVE_KEY, JSON.stringify(updated));
  } catch { /* storage full */ }
  return entry;
}

/**
 * Build a condensed narrative block for the system prompt.
 * Shows recent themes and the rolling story of what the user has been working on.
 */
export function buildNarrativeBlock(): string {
  const entries = loadNarrativeMemory();
  if (entries.length === 0) return '';

  // Group by week, take top 4 entries
  const recent = entries.slice(0, 4);
  const lines = recent.map((e) => {
    const themes = e.themes.length > 0 ? ` [${e.themes.slice(0, 5).join(', ')}]` : '';
    return `- ${e.weekLabel}${themes}: ${e.summary.slice(0, 400)}`;
  });

  const allChars = lines.join('\n').length;
  if (allChars > MAX_NARRATIVE_CHARS) {
    // Truncate older entries
    return `## Continuity — What We've Been Working On\n${lines.slice(0, 2).join('\n')}`;
  }

  return `## Continuity — What We've Been Working On\n${lines.join('\n')}`;
}

// ── Importance-ranked fact retrieval ─────────────────────────────────────────

/**
 * Score a memory fact by combined importance, recency, and strategic weight.
 * Higher = surface first in context.
 */
export function scoreMemoryFact(fact: {
  fact: string;
  category: string;
  importance?: number;
  created_at?: string;
}): number {
  let score = (fact.importance ?? 5) / 10; // 0–1 from importance field

  // Recency score — more recent = higher
  if (fact.created_at) {
    const ageDays = (Date.now() - new Date(fact.created_at).getTime()) / 86400000;
    const recencyScore = Math.max(0, 1 - ageDays / 90); // Decays over 90 days
    score += recencyScore * 0.4;
  }

  // Category boost
  const cat = (fact.category || '').toLowerCase();
  if (cat.includes('decision') || cat.includes('goal') || cat.includes('next')) score += 0.3;
  if (cat.includes('project') || cat.includes('task') || cat.includes('action')) score += 0.2;
  if (cat.includes('prefer') || cat.includes('style')) score += 0.1;

  return score;
}
