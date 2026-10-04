/**
 * Henry AI — Thread Selectors
 *
 * Named helpers for accessing continuity thread state.
 * Used by the initiative engine, runtime context, and workspace.
 * These are the primary API for "what thread is in focus right now?"
 */

import { loadActiveThreads, type ContinuityThread } from './threadStore';

/**
 * The single primary thread — highest-weight active thread.
 * Returns null when no active threads exist.
 */
export function getPrimaryThread(): ContinuityThread | null {
  const threads = loadActiveThreads();
  return threads.find((t) => t.status === 'active') ?? threads[0] ?? null;
}

/**
 * Secondary threads — up to 3, excluding the primary.
 * These are being tracked but are not the current foreground focus.
 */
export function getSecondaryThreads(): ContinuityThread[] {
  const threads = loadActiveThreads();
  const primary = getPrimaryThread();
  return threads
    .filter((t) => t.id !== primary?.id)
    .slice(0, 3);
}

/**
 * Candidates for focus — threads worth surfacing as a focus suggestion.
 * Criteria: active status, weight ≥ 40, has unresolved items.
 * Sorted by weight descending.
 */
export function getThreadFocusCandidates(): ContinuityThread[] {
  return loadActiveThreads()
    .filter((t) => t.status === 'active' && t.weight >= 40 && t.unresolvedItems.length > 0)
    .sort((a, b) => b.weight - a.weight);
}

/**
 * All threads with unresolved items — background awareness.
 */
export function getUnresolvedThreads(): ContinuityThread[] {
  return loadActiveThreads().filter((t) => t.unresolvedItems.length > 0);
}

/**
 * Total count of open (non-done) threads.
 */
export function getOpenThreadCount(): number {
  return loadActiveThreads().length;
}
