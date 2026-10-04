/**
 * Henry Session Lifecycle Manager — Layer 2 Memory
 *
 * Manages the full lifecycle of a conversation session:
 *   - Session start: initialize session_memory row
 *   - Session update: track active tasks, files, emotional pattern
 *   - Session end: compress into a session_end summary + where-we-left-off
 *
 * Also handles auto-sync of localStorage working memory → DB working_memory.
 */

import type { MemoryBandwidth } from './memoryRetrieval';

// ── Session tracking ──────────────────────────────────────────────────────────

const SESSION_STATE_KEY = 'henry:session_state:v1';

interface SessionState {
  conversationId: string;
  startedAt: string;
  messageCount: number;
  emotionalPattern: string | null;
  activeFiles: string[];
  activeTasks: string[];
}

function loadSessionState(): SessionState | null {
  try {
    const raw = localStorage.getItem(SESSION_STATE_KEY);
    return raw ? (JSON.parse(raw) as SessionState) : null;
  } catch { return null; }
}

function saveSessionState(state: SessionState): void {
  try { localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(state)); } catch {}
}

function clearSessionState(): void {
  try { localStorage.removeItem(SESSION_STATE_KEY); } catch {}
}

// ── Electron IPC availability guard ──────────────────────────────────────────

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.henryAPI;
}

// ── Session start ─────────────────────────────────────────────────────────────

/**
 * Called when a conversation starts or resumes.
 * Initializes (or loads) the session_memory row for this conversation.
 */
export async function sessionStart(conversationId: string): Promise<void> {
  const existing = loadSessionState();
  if (existing?.conversationId === conversationId) return; // Already tracking

  const state: SessionState = {
    conversationId,
    startedAt: new Date().toISOString(),
    messageCount: 0,
    emotionalPattern: null,
    activeFiles: [],
    activeTasks: [],
  };
  saveSessionState(state);

  if (!isElectron()) return;

  try {
    await window.henryAPI.saveSessionMemory({
      conversationId,
      activeGoals: [],
      activeTasks: [],
      activeFiles: [],
    });
  } catch { /* non-blocking */ }
}

// ── Session update ────────────────────────────────────────────────────────────

/**
 * Called after each message exchange to update session state.
 */
export function sessionTick(opts: {
  emotionalPattern?: string;
  addedFile?: string;
  addedTask?: string;
}): void {
  const state = loadSessionState();
  if (!state) return;

  state.messageCount++;
  if (opts.emotionalPattern) state.emotionalPattern = opts.emotionalPattern;
  if (opts.addedFile && !state.activeFiles.includes(opts.addedFile)) {
    state.activeFiles = [...state.activeFiles, opts.addedFile].slice(-10);
  }
  if (opts.addedTask) {
    state.activeTasks = [...state.activeTasks, opts.addedTask].slice(-10);
  }
  saveSessionState(state);

  // Async DB sync (fire-and-forget) every 5 messages
  if (state.messageCount % 5 === 0 && isElectron()) {
    window.henryAPI.saveSessionMemory({
      conversationId: state.conversationId,
      emotionalPattern: state.emotionalPattern || undefined,
      activeFiles: state.activeFiles,
      activeTasks: state.activeTasks,
    }).catch(() => {});
  }
}

// ── Session end ───────────────────────────────────────────────────────────────

/**
 * Called when a conversation ends or the user switches away.
 * Compresses session into a summary entry.
 *
 * @param summary — A short human-readable summary of what happened this session.
 *                  Can be AI-generated or auto-assembled from state.
 * @param unresolvedItems — Open threads that didn't get resolved.
 */
export async function sessionEnd(
  summary: string,
  unresolvedItems: string[] = [],
): Promise<void> {
  const state = loadSessionState();
  if (!state || !isElectron()) {
    clearSessionState();
    return;
  }

  try {
    await window.henryAPI.compressSession({
      conversationId: state.conversationId,
      summary,
      unresolvedItems,
      emotionalPattern: state.emotionalPattern || undefined,
    });

    // Save as where-we-left-off so it's available on next startup
    const wloSummary = buildWLOSummary(state, summary, unresolvedItems);
    await window.henryAPI.saveWhereWeLeftOff(wloSummary);
  } catch { /* non-blocking */ }

  clearSessionState();
}

function buildWLOSummary(
  state: SessionState,
  summary: string,
  unresolvedItems: string[],
): string {
  const parts: string[] = [summary];
  if (unresolvedItems.length > 0) {
    parts.push(`Open threads: ${unresolvedItems.slice(0, 3).join('; ')}`);
  }
  if (state.activeFiles.length > 0) {
    parts.push(`Files in context: ${state.activeFiles.slice(0, 3).join(', ')}`);
  }
  return parts.join('\n');
}

// ── Where-we-left-off on startup ─────────────────────────────────────────────

/**
 * Retrieve a recovery summary on app startup.
 * Returns a formatted string Henry can reference in the session resume greeting.
 */
export async function getStartupContext(): Promise<string | null> {
  if (!isElectron()) return null;
  try {
    const data = await window.henryAPI.getWhereWeLeftOff();
    if (!data) return null;

    const parts: string[] = [];
    if (data.lastWhereWeLeftOff) parts.push(data.lastWhereWeLeftOff as string);
    if (data.lastProject) parts.push(`Last active project: ${data.lastProject}`);
    if (Array.isArray(data.openCommitments) && data.openCommitments.length > 0) {
      parts.push(`Open commitments: ${(data.openCommitments as any[]).slice(0, 3).map((c: any) => c.description).join('; ')}`);
    }
    if (Array.isArray(data.activeGoals) && data.activeGoals.length > 0) {
      parts.push(`Active goals: ${(data.activeGoals as any[]).slice(0, 2).map((g: any) => g.title).join(', ')}`);
    }

    return parts.length > 0 ? parts.join('\n') : null;
  } catch { return null; }
}

// ── Working memory DB sync ────────────────────────────────────────────────────

/**
 * Sync the localStorage working memory (fast cache) to the DB.
 * Call this periodically or when the app goes to background.
 */
export async function syncWorkingMemoryToDB(opts: {
  pendingCommitments?: string[];
  activeContextSummary?: string;
}): Promise<void> {
  if (!isElectron()) return;
  try {
    await window.henryAPI.updateWorkingMemory({
      pendingCommitments: opts.pendingCommitments || [],
      activeContextSummary: opts.activeContextSummary || undefined,
    });
  } catch { /* non-blocking */ }
}

// ── Auto-extract and save personal memory ────────────────────────────────────

type PersonalMemoryIngestionRule = {
  pattern: RegExp;
  memoryType: string;
  extractKey: (match: RegExpMatchArray) => string;
  extractValue: (match: RegExpMatchArray, fullText: string) => string;
  strategicScore: number;
  emotionalScore: number;
};

const INGESTION_RULES: PersonalMemoryIngestionRule[] = [
  {
    pattern: /(?:my goal is|i want to|i'm working toward|i'm trying to)\s+([^.!?\n]{10,120})/gi,
    memoryType: 'goal',
    extractKey: () => 'goal',
    extractValue: (m) => m[1].trim(),
    strategicScore: 0.8,
    emotionalScore: 0.6,
  },
  {
    pattern: /(?:i prefer|i like|i always|i usually|i tend to)\s+([^.!?\n]{8,100})/gi,
    memoryType: 'preference',
    extractKey: () => 'preference',
    extractValue: (m) => m[1].trim(),
    strategicScore: 0.4,
    emotionalScore: 0.4,
  },
  {
    pattern: /(?:i value|what matters to me is|i care about|i believe in)\s+([^.!?\n]{8,100})/gi,
    memoryType: 'value',
    extractKey: () => 'value',
    extractValue: (m) => m[1].trim(),
    strategicScore: 0.7,
    emotionalScore: 0.8,
  },
  {
    pattern: /(?:my (?:main |big |top )?challenge is|i keep struggling with|i'm frustrated by)\s+([^.!?\n]{8,100})/gi,
    memoryType: 'frustration',
    extractKey: () => 'frustration',
    extractValue: (m) => m[1].trim(),
    strategicScore: 0.6,
    emotionalScore: 0.7,
  },
  {
    pattern: /(?:the project is called|i'm building|i'm working on|the app is)\s+([^.!?\n]{5,80})/gi,
    memoryType: 'project',
    extractKey: () => 'project_name',
    extractValue: (m) => m[1].trim(),
    strategicScore: 0.9,
    emotionalScore: 0.5,
  },
];

/**
 * Scan a user message for personal memory ingestion candidates.
 * Returns extracted items that can be saved to personal_memory.
 * Filters by minimum confidence (don't save garbage).
 */
export function extractPersonalMemoryFromMessage(text: string): Array<{
  memoryKey: string;
  memoryValue: string;
  memoryType: string;
  strategicSignificanceScore: number;
  emotionalSignificanceScore: number;
  confidenceScore: number;
}> {
  const results: ReturnType<typeof extractPersonalMemoryFromMessage> = [];
  const seen = new Set<string>();

  for (const rule of INGESTION_RULES) {
    for (const match of [...text.matchAll(rule.pattern)]) {
      const value = rule.extractValue(match, text).slice(0, 200);
      const key = `${rule.memoryType}:${value.toLowerCase().slice(0, 50)}`;
      if (seen.has(key) || value.length < 8) continue;
      seen.add(key);
      results.push({
        memoryKey: rule.extractKey(match),
        memoryValue: value,
        memoryType: rule.memoryType,
        strategicSignificanceScore: rule.strategicScore,
        emotionalSignificanceScore: rule.emotionalScore,
        confidenceScore: 0.7,
      });
      if (results.length >= 5) break;
    }
    if (results.length >= 5) break;
  }

  return results;
}

/**
 * Auto-ingest personal memory from a user message.
 * Fire-and-forget — call after user sends a message.
 */
export async function autoIngestPersonalMemory(
  userMessage: string,
): Promise<void> {
  if (!isElectron() || userMessage.length < 20) return;
  const candidates = extractPersonalMemoryFromMessage(userMessage);
  for (const c of candidates.slice(0, 3)) {
    try {
      await window.henryAPI.savePersonalMemory(c as Record<string, unknown>);
    } catch { /* non-blocking */ }
  }
}

// ── Bandwidth from settings ───────────────────────────────────────────────────

const BANDWIDTH_KEY = 'henry:memory_bandwidth:v1';

export function getActiveMemoryBandwidth(): MemoryBandwidth {
  try {
    const raw = localStorage.getItem(BANDWIDTH_KEY);
    if (raw === 'shallow' || raw === 'normal' || raw === 'deep' || raw === 'maximum') return raw;
  } catch {}
  return 'normal';
}
