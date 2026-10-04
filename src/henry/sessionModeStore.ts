/**
 * Henry AI — Session Mode System
 *
 * Henry adjusts his tone, initiative, and focus based on what kind of
 * session the user is in. Five modes + auto-inference.
 *
 * build      — deep project work, architecture, problem-solving
 * admin      — logistics, inbox, tasks, scheduling, cleanup
 * reflection — thinking, journaling, spiritual clarity, stepping back
 * capture    — fast note intake, ideas, quick thoughts
 * execution  — shipping, deciding, finishing, moving now
 * auto       — Henry infers from context (thread type + rhythm + signals)
 */

import { create } from 'zustand';
import type { RhythmPhase } from './dailyRhythm';

export type SessionMode = 'auto' | 'build' | 'admin' | 'reflection' | 'capture' | 'execution';

const SESSION_KEY = 'henry:session_mode';

function safeRead(): SessionMode {
  try {
    const v = localStorage.getItem(SESSION_KEY);
    if (v === 'auto' || v === 'build' || v === 'admin' || v === 'reflection' || v === 'capture' || v === 'execution') return v;
  } catch { /* ignore */ }
  return 'auto';
}

interface SessionModeState {
  mode: SessionMode;
  setMode: (mode: SessionMode) => void;
}

export const useSessionModeStore = create<SessionModeState>((set) => ({
  mode: safeRead(),
  setMode: (mode) => {
    try { localStorage.setItem(SESSION_KEY, mode); } catch { /* ignore */ }
    set({ mode });
  },
}));

export function getSessionMode(): SessionMode {
  return safeRead();
}

// ── Inference ────────────────────────────────────────────────────────────────

/**
 * Infer the active session mode from context when mode is 'auto'.
 * Uses: primary thread type, daily rhythm phase, capture signal.
 */
export function inferSessionMode(rhythmPhase?: RhythmPhase): Exclude<SessionMode, 'auto'> {
  try {
    // Check captures — many unrouted captures → capture mode
    const capturesRaw = localStorage.getItem('henry:captures_v1');
    if (capturesRaw) {
      const captures = JSON.parse(capturesRaw) as Array<{ routed?: boolean; createdAt?: string }>;
      const unrouted = captures.filter((c) => !c.routed);
      if (unrouted.length >= 5) return 'capture';
    }

    // Check primary thread type from thread store
    const threadsRaw = localStorage.getItem('henry:continuity_threads:v1');
    if (threadsRaw) {
      const threads = JSON.parse(threadsRaw) as Array<{ type: string; status: string; weight: number }>;
      const active = threads.filter((t) => t.status === 'active').sort((a, b) => b.weight - a.weight);
      if (active.length > 0) {
        const primaryType = active[0].type;
        if (primaryType === 'project' || primaryType === 'debugging') return 'build';
        if (primaryType === 'planning') return 'reflection';
        if (primaryType === 'logistics') return 'admin';
      }
    }

    // Fall back on rhythm
    if (rhythmPhase === 'morning_setup' || rhythmPhase === 'weekly_reset') return 'admin';
    if (rhythmPhase === 'evening_review') return 'reflection';
    if (rhythmPhase === 'admin_window') return 'admin';
    if (rhythmPhase === 'focus_block' || rhythmPhase === 'meeting_prep') return 'execution';

  } catch { /* ignore */ }

  return 'build'; // default
}

// ── System Prompt Block ───────────────────────────────────────────────────────

const MODE_BLOCKS: Record<Exclude<SessionMode, 'auto'>, string> = {
  build: `## Session Mode: Build
This is a deep work session — architecture, implementation, problem-solving.
- Keep the active project thread front and center
- Emphasize structure and momentum; surface blockers and dependencies
- Help break complex work into concrete steps
- Suppress low-value tangents and logistical noise
- Be decisive and clear, not exploratory`,

  admin: `## Session Mode: Admin
This is a logistics and cleanup session — inbox, tasks, scheduling, maintenance.
- Emphasize quick wins and backlog clearing
- Surface reminders, overdue tasks, calendar items, and inbox signals
- Be concise and practical; no unnecessary depth
- Suggest the fastest path to clearing things`,

  reflection: `## Session Mode: Reflection
This is a quieter, reflective moment — thinking, journaling, processing, stepping back.
- Be slower, calmer, more spacious in tone
- Surface personal patterns, journal memory, and meaning connections
- Reduce aggressive action suggestions; avoid urgency language
- Ask gentle questions over giving solutions`,

  capture: `## Session Mode: Capture
This is a fast intake session — notes, ideas, voice, quick thoughts.
- Prioritize speed and clean routing of incoming material
- Minimize interruptions and tangents
- Offer light classification only when clearly helpful
- Capture first, structure later; be brief and confirmatory`,

  execution: `## Session Mode: Execution
This is a get-it-done push — finishing, shipping, deciding, moving now.
- Surface the top priority and hold focus there
- Reduce ambiguity; give clear answers and clear next steps
- Push toward completion, not exploration
- Be efficient and confirmatory; briefly note any tangents and move on`,
};

/**
 * Build the session mode system prompt block.
 * If mode is 'auto', infers from context signals.
 */
export function buildSessionModeBlock(rhythmPhase?: RhythmPhase): string {
  if (typeof localStorage === 'undefined') return '';

  const raw = getSessionMode();
  const effective: Exclude<SessionMode, 'auto'> = raw === 'auto' ? inferSessionMode(rhythmPhase) : raw;
  const block = MODE_BLOCKS[effective];
  if (!block) return '';

  // Append auto-inference note if inferred
  if (raw === 'auto') {
    return `${block}\n(Auto-inferred from context — adjusts as work pattern shifts.)`;
  }
  return block;
}
