/**
 * Henry AI — Shared Brain State
 *
 * The single source of truth that bridges all three operating layers:
 *   Foreground Mind  → reads this; produces conversation responses
 *   Background Mind  → writes priority, awareness, connection health, threads
 *   Reflective Mind  → writes suggestedNextMove, drift, neglect, rhythm
 *
 * Never write to this directly from UI components.
 * Only background brain, reflective mind, and coordinator update it.
 */

import { create } from 'zustand';
import type { PrioritySnapshot } from '../henry/priority/priorityTypes';
import type { AwarenessSnapshot } from '../henry/awarenessStore';

export type ConnectionStatus = 'healthy' | 'expiring' | 'disconnected' | 'unknown';

export interface BrainConnectionHealth {
  service: string;
  status: ConnectionStatus;
  note?: string;
}

export interface BrainSuggestedAction {
  id: string;
  label: string;
  reason: string;
  priority: number;
}

export interface SharedBrainState {
  // ── Priority (background brain) ──────────────────────────────────────────
  prioritySnapshot: PrioritySnapshot | null;
  priorityReadyAt: number | null;

  // ── Awareness (background brain) ─────────────────────────────────────────
  awarenessSnapshot: AwarenessSnapshot | null;
  awarenessReadyAt: number | null;

  // ── Connection health (background brain) ─────────────────────────────────
  connectionHealth: BrainConnectionHealth[];
  reconnectNeeded: string[];

  // ── Coordinator output (foreground brain reads these) ─────────────────────
  surfaceNow: string[];
  topFocus: string | null;
  keepQuiet: string[];
  connectionAlerts: string[];

  // ── Continuity (background brain + coordinator) ───────────────────────────
  activeThread: string | null;
  secondaryThreads: string[];
  unresolvedCount: number;

  // ── Reflective Mind output ────────────────────────────────────────────────
  /** The single most actionable next move right now. */
  suggestedNextMove: string | null;
  /** Current daily rhythm phase identifier (e.g. "focus_block"). */
  rhythmPhase: string | null;
  /** Human-readable rhythm label (e.g. "Focus block"). */
  rhythmLabel: string | null;
  /** Active threads that have stalled without resolution. */
  driftWarnings: string[];
  /** Commitments or threads past their natural check-in time. */
  neglectedItems: string[];
  /** Brief reasoning notes from the reflective mind — for coordinator to use. */
  reflectiveNotes: string[];
  /** When the reflective mind last ran (epoch ms). */
  lastReflectiveRun: number | null;

  // ── Background brain meta ─────────────────────────────────────────────────
  lastBackgroundRun: number | null;
  backgroundRunning: boolean;
  runCount: number;

  // ── Mutations ─────────────────────────────────────────────────────────────
  _setPrioritySnapshot: (s: PrioritySnapshot) => void;
  _setAwarenessSnapshot: (s: AwarenessSnapshot) => void;
  _setConnectionHealth: (h: BrainConnectionHealth[]) => void;
  _setCoordinatorOutput: (output: {
    surfaceNow: string[];
    topFocus: string | null;
    keepQuiet: string[];
    connectionAlerts: string[];
    activeThread: string | null;
    secondaryThreads: string[];
    unresolvedCount: number;
  }) => void;
  _setReflectiveOutput: (output: {
    suggestedNextMove: string | null;
    rhythmPhase: string;
    rhythmLabel: string;
    driftWarnings: string[];
    neglectedItems: string[];
    reflectiveNotes: string[];
  }) => void;
  _setBackgroundRunning: (running: boolean) => void;
  _markBackgroundRun: () => void;
}

export const useSharedBrainState = create<SharedBrainState>((set) => ({
  prioritySnapshot: null,
  priorityReadyAt: null,
  awarenessSnapshot: null,
  awarenessReadyAt: null,
  connectionHealth: [],
  reconnectNeeded: [],
  surfaceNow: [],
  topFocus: null,
  keepQuiet: [],
  connectionAlerts: [],
  activeThread: null,
  secondaryThreads: [],
  unresolvedCount: 0,

  // Reflective mind
  suggestedNextMove: null,
  rhythmPhase: null,
  rhythmLabel: null,
  driftWarnings: [],
  neglectedItems: [],
  reflectiveNotes: [],
  lastReflectiveRun: null,

  // Meta
  lastBackgroundRun: null,
  backgroundRunning: false,
  runCount: 0,

  _setPrioritySnapshot: (s) => set({ prioritySnapshot: s, priorityReadyAt: Date.now() }),
  _setAwarenessSnapshot: (s) => set({ awarenessSnapshot: s, awarenessReadyAt: Date.now() }),
  _setConnectionHealth: (h) => set({
    connectionHealth: h,
    reconnectNeeded: h.filter((x) => x.status === 'disconnected' || x.status === 'expiring').map((x) => x.service),
  }),
  _setCoordinatorOutput: (output) => set(output),
  _setReflectiveOutput: (output) => set({ ...output, lastReflectiveRun: Date.now() }),
  _setBackgroundRunning: (running) => set({ backgroundRunning: running }),
  _markBackgroundRun: () => set((s) => ({ lastBackgroundRun: Date.now(), runCount: s.runCount + 1 })),
}));

/** Read-only snapshot of shared state for charter.ts (no React hook required). */
export function getSharedBrainState() {
  return useSharedBrainState.getState();
}
