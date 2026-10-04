/**
 * Henry AI — Brain Selectors
 *
 * Named, typed accessors for the shared brain state.
 * These are the primary read API for UI components and the initiative engine.
 *
 * Rules:
 * - All reads go through getSharedBrainState() — no direct Zustand imports in consumers.
 * - These never write to state. Reads only.
 * - For priority-specific queries, use prioritySelectors.ts.
 * - For thread-specific queries, use threadSelectors.ts.
 */

import { getSharedBrainState } from './sharedState';
import type { PriorityItem } from '../henry/priority/priorityTypes';
import type { ContinuityThread } from '../henry/threads/threadStore';
import { getPrimaryThread, getSecondaryThreads } from '../henry/threads/threadSelectors';

// ── Priority ──────────────────────────────────────────────────────────────────

/** The single most important item right now, or null. */
export function selectTopItem(): PriorityItem | null {
  return getSharedBrainState().prioritySnapshot?.topFocus ?? null;
}

/** Top 3 priority items. */
export function selectTopThree(): PriorityItem[] {
  return getSharedBrainState().prioritySnapshot?.top3 ?? [];
}

/** Items ready to be proactively surfaced. */
export function selectSurfaceNow(): string[] {
  return getSharedBrainState().surfaceNow;
}

/**
 * Suggested surface item — the first item in surfaceNow, or null.
 * The coordinator has already filtered this by threshold + suppression.
 */
export function selectSuggestedSurfaceItem(): string | null {
  return getSharedBrainState().surfaceNow[0] ?? null;
}

/** Items to keep quiet about. */
export function selectKeepQuiet(): string[] {
  return getSharedBrainState().keepQuiet;
}

/**
 * Items that need attention now (urgent + important).
 * Reads from the priority snapshot if available.
 */
export function selectNeedsAttention(): PriorityItem[] {
  const snap = getSharedBrainState().prioritySnapshot;
  if (!snap) return [];
  return [...snap.urgentNow, ...snap.importantSoon];
}

/** Count of unresolved tracked items. */
export function selectUnresolvedCount(): number {
  return getSharedBrainState().unresolvedCount;
}

// ── Threads ───────────────────────────────────────────────────────────────────

/**
 * Primary active thread object (full ContinuityThread).
 * Reads from the thread store directly — always fresh.
 */
export function selectPrimaryThread(): ContinuityThread | null {
  return getPrimaryThread();
}

/** Secondary thread objects (up to 3). */
export function selectSecondaryThreads(): ContinuityThread[] {
  return getSecondaryThreads();
}

/** The active thread title from shared state (pre-computed by coordinator). */
export function selectActiveThreadTitle(): string | null {
  return getSharedBrainState().activeThread;
}

// ── Meta ──────────────────────────────────────────────────────────────────────

/** ISO string of last background brain run, or null. */
export function selectLastRefreshedAt(): number | null {
  return getSharedBrainState().lastBackgroundRun;
}

/** Whether the background brain is currently running. */
export function selectBackgroundRunning(): boolean {
  return getSharedBrainState().backgroundRunning;
}

/** Whether the priority snapshot is stale (older than 10 minutes). */
export function selectIsPriorityStale(): boolean {
  const at = getSharedBrainState().priorityReadyAt;
  if (!at) return true;
  return Date.now() - at > 10 * 60 * 1000;
}

/**
 * Services that need reconnection.
 */
export function selectReconnectNeeded(): string[] {
  return getSharedBrainState().reconnectNeeded;
}

// ── Derived summary ───────────────────────────────────────────────────────────

/**
 * A single plain-language summary of what needs attention.
 * Used by the initiative engine to decide whether there's anything worth surfacing.
 */
export function selectFocusSummary(): string {
  const top = selectTopItem();
  const thread = selectActiveThreadTitle();
  const surface = selectSuggestedSurfaceItem();
  const reconnect = selectReconnectNeeded();

  const parts: string[] = [];
  if (top) parts.push(`Top priority: "${top.title}" (score ${top.score})`);
  if (thread) parts.push(`Active thread: "${thread}"`);
  if (surface) parts.push(`Worth surfacing: "${surface}"`);
  if (reconnect.length) parts.push(`Reconnect needed: ${reconnect.join(', ')}`);
  return parts.join(' | ') || 'No focus items.';
}
