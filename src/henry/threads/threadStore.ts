/**
 * Henry AI — Continuity Thread Store
 *
 * Maintains a structured list of active threads — the narrative arcs Henry
 * is tracking across conversations, projects, tasks, and work in progress.
 *
 * Threads sit ABOVE working memory items: they are the named context arcs that
 * working memory items and projects belong to. The thread engine derives them
 * automatically from existing data.
 *
 * Storage: localStorage (local-first, user-controlled).
 * Max: 20 threads (older resolved ones pruned automatically).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ThreadType =
  | 'project'       // Named project with defined scope
  | 'task'          // Orphaned high-priority task arc
  | 'conversation'  // A topic or question thread emerging from conversation
  | 'debugging'     // A specific issue / bug being tracked
  | 'planning'      // A planning or decision thread
  | 'personal'      // Personal or reflective thread
  | 'logistics';    // Admin, scheduling, logistics

export type ThreadStatus =
  | 'active'        // Actively in progress
  | 'paused'        // Intentionally paused (user action or inactivity)
  | 'background'    // Low priority — tracked but not surfaced
  | 'done';         // Resolved / complete

export interface ContinuityThread {
  id: string;
  title: string;
  type: ThreadType;
  status: ThreadStatus;
  weight: number;             // 0–100 scored priority weight
  lastTouched: string;        // ISO date — most recent signal
  suggestedNextStep?: string; // pulled from project.nextStep or inferred
  unresolvedItems: string[];  // short labels of open sub-items
  relatedProjectId?: string;  // links back to HenryProject.id
  source: 'derived' | 'user'; // 'derived' = auto-maintained; 'user' = explicit
  createdAt: string;
  updatedAt: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const THREAD_KEY = 'henry:continuity_threads:v1';
const MAX_THREADS = 20;

function safeLoad(): ContinuityThread[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(THREAD_KEY);
    return raw ? (JSON.parse(raw) as ContinuityThread[]) : [];
  } catch { return []; }
}

function safeSave(threads: ContinuityThread[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(THREAD_KEY, JSON.stringify(threads));
  } catch { /* storage full */ }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Load all non-done threads, sorted by weight descending. */
export function loadActiveThreads(): ContinuityThread[] {
  return safeLoad()
    .filter((t) => t.status !== 'done')
    .sort((a, b) => b.weight - a.weight);
}

/** Load all threads including done (for management UI). */
export function loadAllThreads(): ContinuityThread[] {
  return safeLoad().sort((a, b) => b.weight - a.weight);
}

/**
 * Upsert a derived thread by id.
 * If the thread already exists as 'user' status, preserve user-controlled
 * status/title changes but update weight, lastTouched, unresolvedItems.
 */
export function upsertDerivedThread(thread: ContinuityThread): void {
  const all = safeLoad();
  const idx = all.findIndex((t) => t.id === thread.id);

  if (idx >= 0) {
    const existing = all[idx];
    // Preserve user-controlled fields if source is user
    all[idx] = {
      ...thread,
      status: existing.source === 'user' ? existing.status : thread.status,
      title: existing.source === 'user' ? existing.title : thread.title,
      source: existing.source,
      updatedAt: new Date().toISOString(),
    };
  } else {
    all.unshift(thread);
  }

  // Prune old done threads, keep max
  const pruned = all
    .filter((t) => t.status !== 'done' || t.source === 'user')
    .slice(0, MAX_THREADS);

  safeSave(pruned);
}

/** User marks a thread as paused. Preserved against future derived updates. */
export function pauseThread(id: string): void {
  const all = safeLoad();
  const idx = all.findIndex((t) => t.id === id);
  if (idx >= 0) {
    all[idx] = { ...all[idx], status: 'paused', source: 'user', updatedAt: new Date().toISOString() };
    safeSave(all);
  }
}

/** User marks a thread as done. */
export function resolveThread(id: string): void {
  const all = safeLoad();
  const idx = all.findIndex((t) => t.id === id);
  if (idx >= 0) {
    all[idx] = { ...all[idx], status: 'done', source: 'user', updatedAt: new Date().toISOString() };
    safeSave(all);
  }
}

/** User sets a thread as active (un-pause or resume). */
export function activateThread(id: string): void {
  const all = safeLoad();
  const idx = all.findIndex((t) => t.id === id);
  if (idx >= 0) {
    all[idx] = { ...all[idx], status: 'active', source: 'user', updatedAt: new Date().toISOString() };
    safeSave(all);
  }
}

/** Clear all derived threads (user-controlled threads preserved). */
export function clearDerivedThreads(): void {
  safeSave(safeLoad().filter((t) => t.source === 'user'));
}

// ── System Prompt Block ────────────────────────────────────────────────────────

const TYPE_LABEL: Record<ThreadType, string> = {
  project:      'Project',
  task:         'Task',
  conversation: 'Conversation',
  debugging:    'Debugging',
  planning:     'Planning',
  personal:     'Personal',
  logistics:    'Logistics',
};

/**
 * Build the continuity thread system prompt block.
 * Shows the primary active thread in detail + top secondary threads briefly.
 * Designed to replace the plain `Active thread: "X"` line in the coordinator block.
 */
export function buildContinuityThreadBlock(): string {
  if (typeof localStorage === 'undefined') return '';

  const active = loadActiveThreads().filter((t) => t.status === 'active' || t.status === 'background');
  if (active.length === 0) return '';

  const primary = active[0];
  const secondary = active.slice(1, 3);

  const lines: string[] = ['## Continuity Threads'];

  // Primary — detailed view
  const typeLabel = TYPE_LABEL[primary.type];
  lines.push(`Primary [${typeLabel}]: "${primary.title}"`);
  if (primary.suggestedNextStep) {
    lines.push(`  → Next: ${primary.suggestedNextStep.slice(0, 120)}`);
  }
  if (primary.unresolvedItems.length) {
    const items = primary.unresolvedItems.slice(0, 3).join('; ');
    lines.push(`  → Open: ${items}`);
  }

  // Secondary — brief
  if (secondary.length) {
    const secondaryLabels = secondary.map((t) => `"${t.title}" (${TYPE_LABEL[t.type]})`).join(', ');
    lines.push(`Also tracking: ${secondaryLabels}`);
  }

  lines.push(`Resume naturally — don't announce these threads, don't recite them verbatim.`);

  return lines.join('\n');
}
