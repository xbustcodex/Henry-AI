/**
 * Context Summary — builds a compact session summary from the current
 * conversation that gets injected back into Henry's memory block.
 * Fires automatically every N messages to keep context fresh.
 */

function safeGet<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}
function safeSet(key: string, val: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { }
}

export interface SessionSummary {
  conversationId: string;
  summary: string;
  messageCount: number;
  generatedAt: string;
}

const SUMMARY_KEY_PREFIX = 'henry:session_summary:';
const SUMMARY_EVERY_N = 8; // summarize every 8 assistant messages

export function getSessionSummary(conversationId: string): SessionSummary | null {
  return safeGet<SessionSummary | null>(SUMMARY_KEY_PREFIX + conversationId, null);
}

export function saveSessionSummary(s: SessionSummary): void {
  safeSet(SUMMARY_KEY_PREFIX + s.conversationId, s);
}

export function shouldSummarize(conversationId: string, messageCount: number): boolean {
  const existing = getSessionSummary(conversationId);
  if (!existing) return messageCount >= SUMMARY_EVERY_N;
  return messageCount - existing.messageCount >= SUMMARY_EVERY_N;
}

export function buildSummaryPrompt(recentMessages: Array<{role: string; content: string}>): string {
  const formatted = recentMessages
    .slice(-16)
    .map(m => `${m.role === 'user' ? 'User' : 'Henry'}: ${m.content.slice(0, 200)}`)
    .join('\n');
  return `Summarize this conversation segment in 3-5 sentences. Focus on: what was decided, what was asked for, what context matters for future messages. Be specific — include names, project names, key facts. No filler.

${formatted}`;
}
