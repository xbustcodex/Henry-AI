/**
 * Henry AI — Execution Mode Store
 *
 * SEPARATE from HenryOperatingMode (which is conversation topic).
 * Execution mode controls HOW Henry behaves during a work session:
 * - initiative frequency
 * - interruption tolerance
 * - what to emphasize or suppress
 *
 * Modes: builder | operator | recovery | focus | review
 */

import { create } from 'zustand';

export type ExecutionMode = 'builder' | 'operator' | 'recovery' | 'focus' | 'review';

export interface ExecutionModeConfig {
  id: ExecutionMode;
  label: string;
  description: string;
  initiativeMultiplier: number; // 0=quiet, 1=normal, 2=active
  suppressionLevel: 'low' | 'medium' | 'high'; // how aggressively to suppress interruptions
  emphasize: string[];
  suppress: string[];
  systemBlock: string;
}

export const EXECUTION_MODE_CONFIGS: Record<ExecutionMode, ExecutionModeConfig> = {
  builder: {
    id: 'builder',
    label: 'Builder',
    description: 'Deep work — architecture, systems, debugging. Suppresses admin noise.',
    initiativeMultiplier: 0.7,
    suppressionLevel: 'medium',
    emphasize: ['blockers', 'structure', 'momentum'],
    suppress: ['low-value reminders', 'admin nudges', 'unrelated captures'],
    systemBlock: `## Execution mode: Builder
Deep technical work is underway. Prioritize structure, blockers, and forward momentum. Suppress low-value interruptions. Surface only what directly affects current progress. Keep suggestions architectural and concrete.`,
  },
  operator: {
    id: 'operator',
    label: 'Operator',
    description: 'Execution — tasks, follow-through, integrations. Move work forward now.',
    initiativeMultiplier: 1.2,
    suppressionLevel: 'low',
    emphasize: ['next step', 'completion', 'action'],
    suppress: ['abstract discussion', 'strategy rabbit holes'],
    systemBlock: `## Execution mode: Operator
Focus on execution and follow-through. Prioritize the next concrete action, completion of open items, and integration health. Keep responses action-oriented and short.`,
  },
  recovery: {
    id: 'recovery',
    label: 'Recovery',
    description: 'Something broke — errors, reconnects, setup fixes. Prioritize clarity.',
    initiativeMultiplier: 1.5,
    suppressionLevel: 'low',
    emphasize: ['troubleshooting', 'fallback paths', 'clarity'],
    suppress: ['unrelated features', 'low-priority noise'],
    systemBlock: `## Execution mode: Recovery
Something is broken or blocked. Prioritize troubleshooting, clarity, and calm. Surface fallback paths. Keep tone steady. One problem at a time.`,
  },
  focus: {
    id: 'focus',
    label: 'Focus',
    description: 'Protect deep concentration. Suppress everything except urgent blockers.',
    initiativeMultiplier: 0.2,
    suppressionLevel: 'high',
    emphasize: ['urgent blockers only'],
    suppress: ['suggestions', 'reminders', 'captures', 'low-priority anything'],
    systemBlock: `## Execution mode: Focus
User is in deep focus. Surface ONLY: urgent blockers, connection failures that stop current work, one high-confidence next step. Suppress all else. Do not interrupt.`,
  },
  review: {
    id: 'review',
    label: 'Review',
    description: 'Reflection, weekly review, open loops, reweighting priorities.',
    initiativeMultiplier: 1.0,
    suppressionLevel: 'low',
    emphasize: ['open loops', 'priority balance', 'reflection'],
    suppress: ['new commitments', 'scope expansion'],
    systemBlock: `## Execution mode: Review
This is a reflection session. Help surface open loops, assess priority balance, identify what has stalled, and reweight what matters. Keep observations honest and brief.`,
  },
};

const EXECUTION_MODE_KEY = 'henry:execution_mode';

function safeRead(): ExecutionMode {
  try {
    const v = localStorage.getItem(EXECUTION_MODE_KEY);
    if (v && v in EXECUTION_MODE_CONFIGS) return v as ExecutionMode;
  } catch { /* ignore */ }
  return 'operator';
}

interface ExecutionModeState {
  mode: ExecutionMode;
  source: 'manual' | 'inferred';
  setMode: (mode: ExecutionMode, source?: 'manual' | 'inferred') => void;
  getConfig: () => ExecutionModeConfig;
  buildBlock: () => string;
}

export const useExecutionModeStore = create<ExecutionModeState>((set, get) => ({
  mode: safeRead(),
  source: 'manual',

  setMode: (mode, source = 'manual') => {
    try { localStorage.setItem(EXECUTION_MODE_KEY, mode); } catch { /* ignore */ }
    set({ mode, source });
  },

  getConfig: () => EXECUTION_MODE_CONFIGS[get().mode],

  buildBlock: () => EXECUTION_MODE_CONFIGS[get().mode].systemBlock,
}));

export function getExecutionMode(): ExecutionMode {
  return safeRead();
}

export function getExecutionModeConfig(): ExecutionModeConfig {
  return EXECUTION_MODE_CONFIGS[getExecutionMode()];
}

export function buildExecutionModeBlock(): string {
  return EXECUTION_MODE_CONFIGS[getExecutionMode()].systemBlock;
}

/**
 * Infer execution mode from current live state.
 * Returns a suggestion and the reason — does NOT auto-apply.
 * Caller decides whether to prompt the user.
 */
export function inferExecutionMode(): { mode: ExecutionMode; reason: string } | null {
  function safeJSON<T>(key: string, fallback: T): T {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  }

  const tasks = safeJSON<any[]>('henry:tasks', []);
  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'queued');
  const failed = tasks.filter((t) => t.status === 'failed');
  const connections = safeJSON<Record<string, any>>('henry:connections', {});
  const expired = Object.entries(connections).filter(([, v]) => v?.status === 'expired');
  const reminders = safeJSON<any[]>('henry:reminders', []);
  const overdue = reminders.filter((r) => !r.done && r.dueAt && new Date(r.dueAt).getTime() < Date.now());

  if (expired.length > 0 || failed.length > 1) {
    return { mode: 'recovery', reason: `${failed.length} failed tasks or ${expired.length} expired connections detected.` };
  }
  if (pending.length > 3) {
    return { mode: 'operator', reason: `${pending.length} tasks pending — execution mode recommended.` };
  }
  if (overdue.length > 2) {
    return { mode: 'operator', reason: `${overdue.length} overdue reminders need follow-through.` };
  }
  return null;
}
