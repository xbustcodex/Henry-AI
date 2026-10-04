/**
 * Henry AI — Reflective Mind
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                   THREE-MIND ARCHITECTURE                           │
 * │                                                                     │
 * │  Foreground Mind  charter.ts + coordinator.ts                       │
 * │    Runs per-message. Builds the system prompt. What Henry says.     │
 * │    Reads:  SharedBrainState (coordinator output + reflective output)│
 * │    Writes: nothing — pure read + format                             │
 * │                                                                     │
 * │  Background Mind  backgroundBrain.ts                                │
 * │    Runs every 5 min + events. Refreshes what Henry knows.           │
 * │    Reads:  localStorage (tasks, projects, threads, connections)      │
 * │    Writes: SharedBrainState (priority, awareness, threads, health)  │
 * │                                                                     │
 * │  Reflective Mind  this file ← you are here                         │
 * │    Runs after background brain. Synthesizes what it means.          │
 * │    Reads:  SharedBrainState + localStorage (threads, commitments)   │
 * │    Writes: ReflectiveOutput (caller writes to SharedBrainState)     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Responsibilities:
 *   - Detect drift: threads that were important but have not moved
 *   - Detect neglect: commitments past their natural check-in time
 *   - Detect change: what shifted since the last reflective pass
 *   - Infer daily rhythm phase: orient behavior to time of day
 *   - Produce suggested next move: the single most actionable step now
 *   - Produce reflective notes: brief hints the coordinator uses in the system prompt
 *
 * Design constraints:
 *   - Synchronous only. No async, no AI calls, no network.
 *   - Must complete in < 10ms.
 *   - Does NOT write to SharedBrainState directly — caller does that.
 *   - Does NOT import from backgroundBrain.ts (no circular dep).
 */

import { getSharedBrainState } from './sharedState';
import { loadActiveThreads } from '../henry/threads/threadStore';
import { inferRhythmPhase } from '../henry/dailyRhythm';
import { getInitiativeMode } from '../henry/initiativeStore';

// ── Public output type ────────────────────────────────────────────────────────

export interface ReflectiveOutput {
  /** The single most actionable next move. Null when initiative mode is quiet. */
  suggestedNextMove: string | null;
  /** Human-readable daily rhythm phase label, e.g. "Focus block". */
  rhythmLabel: string;
  /** Rhythm phase identifier, e.g. "focus_block". */
  rhythmPhase: string;
  /** Active threads with weight ≥ 50 that have not moved in ≥ 3 days. */
  driftWarnings: string[];
  /** Commitments that are overdue or have been open for ≥ 6 days with no due date. */
  neglectedItems: string[];
  /** Brief context hints for the foreground mind — rhythm, change signals, load notes. */
  reflectiveNotes: string[];
}

// ── Internal checkpoint (change detection between passes) ─────────────────────

interface ReflectionCheckpoint {
  lastRunAt: number;
  previousTopFocusId: string | null;
  previousUnresolvedCount: number;
  previousThreadIds: string[];
}

const CHECKPOINT_KEY = 'henry:reflection_checkpoint_v1';
const DRIFT_THRESHOLD_MS   = 3 * 24 * 60 * 60 * 1000; // 3 days idle
const NEGLECT_THRESHOLD_MS = 6 * 24 * 60 * 60 * 1000; // 6 days open with no due date

function loadCheckpoint(): ReflectionCheckpoint {
  try {
    if (typeof localStorage === 'undefined') return emptyCheckpoint();
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (raw) return JSON.parse(raw) as ReflectionCheckpoint;
  } catch { /* ignore */ }
  return emptyCheckpoint();
}

function emptyCheckpoint(): ReflectionCheckpoint {
  return { lastRunAt: 0, previousTopFocusId: null, previousUnresolvedCount: 0, previousThreadIds: [] };
}

function saveCheckpoint(c: ReflectionCheckpoint): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(c));
    }
  } catch { /* storage full — non-fatal */ }
}

// ── Rhythm labels and hints ───────────────────────────────────────────────────

const RHYTHM_LABELS: Record<string, string> = {
  morning_setup:  'Morning setup',
  focus_block:    'Focus block',
  admin_window:   'Admin window',
  evening_review: 'Evening review',
  weekly_reset:   'Weekly reset',
  meeting_prep:   'Meeting prep',
};

const RHYTHM_HINTS: Record<string, string> = {
  morning_setup:  'Orient, choose first focus, review what changed overnight.',
  focus_block:    'Deep work time — minimize context switches, execute.',
  admin_window:   'Inbox, scheduling, logistics, follow-ups.',
  evening_review: 'Close open loops, save context, reflect on progress.',
  weekly_reset:   'Reorient across all threads, reweight priorities.',
  meeting_prep:   'Prepare for what is coming — context, questions, agenda.',
};

// ── Core computation ──────────────────────────────────────────────────────────

/**
 * Run the reflective mind.
 *
 * Pure heuristic — reads SharedBrainState and localStorage only.
 * Returns a ReflectiveOutput. The caller (Step 3: background brain) is
 * responsible for writing the output into SharedBrainState via _setReflectiveOutput().
 */
export function runReflectiveMind(): ReflectiveOutput {
  const state = getSharedBrainState();
  const checkpoint = loadCheckpoint();
  const now = Date.now();

  const rhythmPhase = inferRhythmPhase(new Date());
  const rhythmLabel = RHYTHM_LABELS[rhythmPhase] ?? 'Work session';
  const initiativeMode = getInitiativeMode();

  const driftWarnings: string[] = [];
  const neglectedItems: string[] = [];
  const reflectiveNotes: string[] = [];
  let suggestedNextMove: string | null = null;

  const snapshot = state.prioritySnapshot;
  const unresolvedCount = state.unresolvedCount;
  const activeThreads = loadActiveThreads();

  // ── Rhythm context ───────────────────────────────────────────────────────

  const rhythmHint = RHYTHM_HINTS[rhythmPhase];
  if (rhythmHint) {
    reflectiveNotes.push(`${rhythmLabel}: ${rhythmHint}`);
  }

  // ── Change detection (compare to last checkpoint) ────────────────────────

  if (
    checkpoint.previousUnresolvedCount > 0 &&
    unresolvedCount > checkpoint.previousUnresolvedCount + 2
  ) {
    const delta = unresolvedCount - checkpoint.previousUnresolvedCount;
    reflectiveNotes.push(
      `${delta} new unresolved item${delta !== 1 ? 's' : ''} appeared since the last pass.`
    );
  }

  if (
    snapshot?.topFocus &&
    checkpoint.previousTopFocusId &&
    snapshot.topFocus.id !== checkpoint.previousTopFocusId
  ) {
    reflectiveNotes.push('The top priority has shifted since the last pass.');
  }

  const prevIds = new Set(checkpoint.previousThreadIds);
  const newThreads = activeThreads.filter((t) => !prevIds.has(t.id));
  if (newThreads.length > 0) {
    reflectiveNotes.push(
      `${newThreads.length} new thread${newThreads.length !== 1 ? 's' : ''} opened: ${newThreads.slice(0, 2).map((t) => `"${t.title}"`).join(', ')}.`
    );
  }

  // ── Drift detection ──────────────────────────────────────────────────────

  for (const thread of activeThreads.slice(0, 8)) {
    if (thread.weight < 50) continue;
    const idleMs = now - new Date(thread.lastTouched).getTime();
    if (idleMs > DRIFT_THRESHOLD_MS) {
      const days = Math.round(idleMs / (24 * 60 * 60 * 1000));
      driftWarnings.push(`"${thread.title}" has not moved in ${days} day${days !== 1 ? 's' : ''}.`);
    }
    if (driftWarnings.length >= 3) break;
  }

  // ── Neglect detection ────────────────────────────────────────────────────

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('henry:commitments:v1');
      if (raw) {
        const commitments: any[] = JSON.parse(raw);
        for (const c of commitments) {
          if (c.resolved || c.dismissed) continue;
          const label = (c.title || c.text || '(unnamed)').toString().slice(0, 60);
          if (c.dueAt && new Date(c.dueAt).getTime() < now) {
            neglectedItems.push(`Overdue: "${label}"`);
          } else if (!c.dueAt && c.createdAt) {
            const age = now - new Date(c.createdAt).getTime();
            if (age > NEGLECT_THRESHOLD_MS) {
              neglectedItems.push(`Long-open commitment: "${label}"`);
            }
          }
          if (neglectedItems.length >= 3) break;
        }
      }
    }
  } catch { /* ignore */ }

  // ── Unresolved load ──────────────────────────────────────────────────────

  if (unresolvedCount > 12) {
    reflectiveNotes.push(`${unresolvedCount} items unresolved — consider a triage pass.`);
  }

  // ── Suggested next move ──────────────────────────────────────────────────
  // Skipped entirely when initiative mode is quiet.

  if (initiativeMode !== 'quiet' && snapshot) {
    if (snapshot.urgentNow.length > 0) {
      const u = snapshot.urgentNow[0];
      const label = u.title.replace(/^(Project|Captured|Note|Active app|Computer):\s*/i, '').slice(0, 80);
      suggestedNextMove = `Address urgently: "${label}"${u.signals.isOverdue ? ' — overdue' : ''}`;
    } else if (activeThreads.length > 0 && activeThreads[0].suggestedNextStep) {
      suggestedNextMove = activeThreads[0].suggestedNextStep;
    } else if (snapshot.topFocus) {
      const label = snapshot.topFocus.title
        .replace(/^(Project|Captured|Note|Active app|Computer):\s*/i, '')
        .slice(0, 80);
      suggestedNextMove = `Continue: "${label}"`;
    } else if (neglectedItems.length > 0) {
      suggestedNextMove = `Revisit ${neglectedItems[0]}`;
    } else if (driftWarnings.length > 0) {
      suggestedNextMove = `Check in on stalled thread: ${driftWarnings[0]}`;
    }
  }

  // ── Save checkpoint ──────────────────────────────────────────────────────

  saveCheckpoint({
    lastRunAt: now,
    previousTopFocusId: snapshot?.topFocus?.id ?? null,
    previousUnresolvedCount: unresolvedCount,
    previousThreadIds: activeThreads.slice(0, 8).map((t) => t.id),
  });

  return {
    suggestedNextMove,
    rhythmPhase,
    rhythmLabel,
    driftWarnings: driftWarnings.slice(0, 3),
    neglectedItems: neglectedItems.slice(0, 3),
    reflectiveNotes: reflectiveNotes.slice(0, 4),
  };
}

// ── System prompt block ───────────────────────────────────────────────────────

/**
 * Build the reflective mind's system prompt contribution from a ReflectiveOutput.
 * Called by the coordinator (Step 4+) to inject into the foreground mind's prompt.
 * Returns empty string when there is nothing substantive to add.
 */
export function buildReflectiveMindBlock(output: ReflectiveOutput): string {
  const hasContent =
    output.suggestedNextMove ||
    output.reflectiveNotes.length > 0 ||
    output.driftWarnings.length > 0 ||
    output.neglectedItems.length > 0;

  if (!hasContent) return '';

  const lines: string[] = [`## Reflective mind (${output.rhythmLabel})`];

  if (output.suggestedNextMove) {
    lines.push(`Suggested next move: ${output.suggestedNextMove}`);
  }

  if (output.reflectiveNotes.length > 0) {
    lines.push(`Context: ${output.reflectiveNotes.join(' ')}`);
  }

  if (output.driftWarnings.length > 0) {
    lines.push(`Drift: ${output.driftWarnings.join('; ')}`);
  }

  if (output.neglectedItems.length > 0) {
    lines.push(`Neglected: ${output.neglectedItems.join('; ')}`);
  }

  lines.push('Use this to inform your posture — surface only when it adds real value.');

  return lines.join('\n');
}
