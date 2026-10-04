/**
 * Henry AI — Runtime Context
 *
 * A single structured object that represents "what is active right now."
 * This is the unified center of gravity for:
 * - Chat view (via charter.ts)
 * - Workspace header / focus area
 * - Initiative engine decisions
 *
 * Built from shared brain state — always reads pre-computed, coordinator-filtered data.
 * Never re-scores items. Never writes state. Pure read + shape.
 */

import { getSharedBrainState } from '../../brain/sharedState';
import { getPrimaryThread, getSecondaryThreads } from '../../henry/threads/threadSelectors';
import { detectActiveConflicts } from '../../henry/conflictDetector';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RuntimeContext {
  /** Plain-language label for the top priority item. Null if nothing is ranked. */
  topPriority: string | null;
  /** Score of top priority (0–100). */
  topPriorityScore: number;
  /** Category of top priority. */
  topPriorityCategory: string | null;
  /** The primary active continuity thread. */
  activeThread: string | null;
  activeThreadType: string | null;
  activeThreadNextStep: string | null;
  /** Secondary threads (titles only). */
  secondaryThreads: string[];
  /** Up to 3 focus items that are important/urgent (plain labels). */
  focusItems: string[];
  /** Items with blocked or disconnected state. */
  blockedItems: string[];
  /** Suggested next move, in plain language. Null if nothing to suggest. */
  suggestedNextMove: string | null;
  /** Current session mode. */
  sessionMode: string;
  /** Current rhythm phase. */
  rhythmPhase: string;
  /** Active principle titles (P1–P7). Empty when nothing is firing. */
  activePrinciples: string[];
  /** Services needing reconnection. */
  reconnectNeeded: string[];
  /** Whether the background brain has run at least once. */
  isReady: boolean;
  /** Timestamp of last background refresh. */
  lastUpdated: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeGet(key: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
}

function getRhythmLabel(): string {
  try {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 9) return 'morning';
    if (hour >= 9 && hour < 12) return 'mid-morning';
    if (hour >= 12 && hour < 14) return 'midday';
    if (hour >= 14 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 20) return 'evening';
    return 'night';
  } catch { return 'unknown'; }
}

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build a fresh runtime context from all pre-computed sources.
 * Cheap to call — reads from already-computed shared state.
 */
export function buildRuntimeContext(): RuntimeContext {
  const state = getSharedBrainState();
  const snap = state.prioritySnapshot;

  // Top priority
  const topItem = snap?.topFocus ?? null;
  const topPriority = topItem
    ? topItem.title.replace(/^(Project|Captured|Note|Active app|Computer):\s*/i, '').slice(0, 80)
    : null;

  // Primary thread
  const primaryThread = getPrimaryThread();
  const secondaryThreadObjs = getSecondaryThreads();

  // Focus items (urgent + important, up to 3, plain labels)
  const focusItems = [
    ...(snap?.urgentNow ?? []),
    ...(snap?.importantSoon ?? []),
  ]
    .slice(0, 3)
    .map((i) => i.title.replace(/^(Project|Captured|Note|Active app|Computer):\s*/i, '').slice(0, 60));

  // Blocked items — items with blocked signal
  const blockedItems = (snap?.items ?? [])
    .filter((i) => i.signals.isBlockingOther || i.category === 'parked')
    .slice(0, 3)
    .map((i) => i.title.replace(/^(Project|Captured|Note):\s*/i, '').slice(0, 60));

  // Suggested next move — first item in coordinator surfaceNow, or active thread next step
  const suggestedNextMove =
    state.surfaceNow[0]
    ?? primaryThread?.suggestedNextStep?.slice(0, 120)
    ?? null;

  // Active conflict principles
  const conflicts = detectActiveConflicts();
  const activePrinciples = conflicts.signals
    .filter((s) => s.severity === 'active')
    .map((s) => s.principleTitle);

  return {
    topPriority,
    topPriorityScore: topItem?.score ?? 0,
    topPriorityCategory: topItem?.category ?? null,
    activeThread: primaryThread?.title ?? state.activeThread,
    activeThreadType: primaryThread?.type ?? null,
    activeThreadNextStep: primaryThread?.suggestedNextStep?.slice(0, 120) ?? null,
    secondaryThreads: secondaryThreadObjs.map((t) => t.title),
    focusItems,
    blockedItems,
    suggestedNextMove,
    sessionMode: safeGet('henry:session_mode') ?? 'auto',
    rhythmPhase: getRhythmLabel(),
    activePrinciples,
    reconnectNeeded: state.reconnectNeeded,
    isReady: state.priorityReadyAt !== null,
    lastUpdated: state.lastBackgroundRun,
  };
}

/**
 * A compact charter block built from runtime context.
 * Only emitted when there is real signal — no noise.
 *
 * Note: this supplements (not replaces) coordinatorBlock and priorityBlock.
 * It surfaces the things those blocks don't cover:
 * - The thread's next step
 * - Active principles in plain language
 * - Reconnect needs (if coordinator hasn't already caught them)
 */
export function buildRuntimeContextBlock(): string {
  const ctx = buildRuntimeContext();
  if (!ctx.isReady) return '';

  const lines: string[] = [];

  // Active thread next step — high-value, rarely in other blocks
  if (ctx.activeThreadNextStep) {
    lines.push(`Active thread next step: "${ctx.activeThreadNextStep}"`);
  }

  // Active principles — give Henry a concise "right now" lens
  if (ctx.activePrinciples.length > 0) {
    lines.push(`Governing this session: ${ctx.activePrinciples.slice(0, 3).join(', ')}.`);
  }

  // Reconnect — only if not already surfaced by coordinator
  if (ctx.reconnectNeeded.length > 0) {
    lines.push(`Reconnect needed: ${ctx.reconnectNeeded.join(', ')}.`);
  }

  if (lines.length === 0) return '';

  return `## Session context\n${lines.join('\n')}`;
}
