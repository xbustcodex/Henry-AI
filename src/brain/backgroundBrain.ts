/**
 * Henry AI — Background Brain
 * Runs silently. Maintains awareness, priority, and connection state so the
 * front brain is always pre-loaded and ready — never computing from scratch.
 *
 * Trigger model:
 * - Event-driven: fires immediately on captures, storage changes, workspace events
 * - Light poll: every 5 minutes as a catch-all
 * - Never visible to the user
 * - Never blocking the UI thread (all async, microtask-scheduled)
 */

import { useSharedBrainState } from './sharedState';
import { runPriorityEngine, getPriorityMode } from '../henry/priority/priorityEngine';
import { invalidatePriorityCache } from '../henry/priority/prioritySelectors';
import { runCoordinator } from './coordinator';
import { runReflectiveMind } from './reflectiveMind';

const POLL_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes — light background sweep
const DEBOUNCE_MS = 800;                   // avoid thrashing on rapid events

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _listeners: Array<[string, EventListener]> = [];
let _running = false;

// ── Jobs ───────────────────────────────────────────────────────────────────

/** Pre-compute the priority snapshot into shared state. */
async function jobRefreshPriority(): Promise<void> {
  try {
    invalidatePriorityCache();
    const snap = runPriorityEngine(getPriorityMode());
    useSharedBrainState.getState()._setPrioritySnapshot(snap);
  } catch { /* silently ignore — background job */ }
}

/** Pre-compute the awareness snapshot into shared state. */
async function jobRefreshAwareness(): Promise<void> {
  try {
    // Import lazily to avoid circular deps at module load
    const { buildSnapshot } = await import('./awarenessAdapter');
    const snap = buildSnapshot();
    useSharedBrainState.getState()._setAwarenessSnapshot(snap);
  } catch { /* silently ignore */ }
}

/** Derive and save continuity threads from projects, tasks, and working memory. */
async function jobRefreshThreads(): Promise<void> {
  try {
    const { deriveAndSaveThreads } = await import('../henry/threads/threadEngine');
    deriveAndSaveThreads();
  } catch { /* silently ignore */ }
}

/** Check connection health across all connected services. */
async function jobCheckConnectionHealth(): Promise<void> {
  try {
    const raw = localStorage.getItem('henry:connections');
    if (!raw) return;
    const connections: Record<string, any> = JSON.parse(raw);
    const health = Object.entries(connections).map(([service, v]) => {
      const status =
        v?.status === 'connected' ? 'healthy' as const
        : v?.status === 'expired' ? 'expiring' as const
        : 'disconnected' as const;
      return { service, status };
    });
    useSharedBrainState.getState()._setConnectionHealth(health);
  } catch { /* ignore */ }
}

/**
 * Run the reflective mind pass and write its output into shared state.
 * Must run after data jobs have completed so it reads fresh priority + thread state.
 */
function jobRunReflection(): void {
  try {
    const output = runReflectiveMind();
    useSharedBrainState.getState()._setReflectiveOutput({
      suggestedNextMove: output.suggestedNextMove,
      rhythmPhase: output.rhythmPhase,
      rhythmLabel: output.rhythmLabel,
      driftWarnings: output.driftWarnings,
      neglectedItems: output.neglectedItems,
      reflectiveNotes: output.reflectiveNotes,
    });
  } catch { /* silently ignore — must not break the background cycle */ }
}

/** Run all background jobs and update coordinator output. */
async function runAllJobs(): Promise<void> {
  const state = useSharedBrainState.getState();
  if (state.backgroundRunning) return; // guard against overlap

  state._setBackgroundRunning(true);
  try {
    // Data jobs run in parallel — each refreshes one slice of shared state
    await Promise.allSettled([
      jobRefreshPriority(),
      jobRefreshAwareness(),
      jobCheckConnectionHealth(),
      jobRefreshThreads(),
    ]);
    // Reflective mind runs after data jobs — reads the freshly updated state
    jobRunReflection();
    // Coordinator runs last — reads everything and decides what to surface
    runCoordinator();
    state._markBackgroundRun();
  } finally {
    useSharedBrainState.getState()._setBackgroundRunning(false);
  }
}

// ── Debounced trigger ──────────────────────────────────────────────────────

function triggerDebounced(): void {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    void runAllJobs();
  }, DEBOUNCE_MS);
}

// ── Event-driven triggers ──────────────────────────────────────────────────

function onAmbientNote(): void {
  triggerDebounced();
}

function onStorageChange(e: StorageEvent): void {
  // Only care about Henry-related keys
  const triggerKeys = [
    'henry:tasks',
    'henry:reminders',
    'henry:rich_memory:projects',
    'henry:captures_v1',
    'henry:connections',
    'henry:computer_snapshot',
    'henry:initiative_mode',
    'henry:priority_mode',
    'henry:commitments:v1',
    'henry:relationships:v1',
    'henry:values:v1',
    'henry:continuity_threads:v1',
  ];
  if (e.key && triggerKeys.some((k) => e.key?.startsWith(k))) {
    triggerDebounced();
  }
}

function onWorkspaceChange(): void {
  triggerDebounced();
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Start the background brain. Call once at app startup. */
export function startBackgroundBrain(): () => void {
  if (_running) return stopBackgroundBrain;
  _running = true;

  // Register event listeners
  const listeners: Array<[string, EventListener]> = [
    ['henry_ambient_note', onAmbientNote as EventListener],
    ['henry-workspace-context-changed', onWorkspaceChange as EventListener],
    ['henry-writer-context-changed', onWorkspaceChange as EventListener],
  ];
  for (const [event, handler] of listeners) {
    window.addEventListener(event, handler);
  }
  _listeners = listeners;

  // Storage listener (cross-key monitoring)
  window.addEventListener('storage', onStorageChange);

  // Light polling — catch any changes not caught by events
  _pollTimer = setInterval(() => void runAllJobs(), POLL_INTERVAL_MS);

  // Run immediately on startup (after a tiny delay to not block render)
  setTimeout(() => void runAllJobs(), 1500);

  return stopBackgroundBrain;
}

/** Stop the background brain and clean up. */
export function stopBackgroundBrain(): void {
  _running = false;
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  for (const [event, handler] of _listeners) {
    window.removeEventListener(event, handler);
  }
  _listeners = [];
  window.removeEventListener('storage', onStorageChange);
}

/** Force an immediate background refresh (e.g. user just routed a capture). */
export function triggerBackgroundRefresh(): void {
  triggerDebounced();
}
