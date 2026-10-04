/**
 * Henry AI — Instinct Engine
 *
 * Decides HOW Henry should respond to any given situation:
 *   act      — take initiative internally (safe, obvious, non-destructive)
 *   ask      — request permission before proceeding (external, sensitive, uncertain)
 *   quiet    — suppress; user is in flow or suggestion is weak
 *   escalate — speak up because something important is blocked or urgent
 *
 * Based on real signals — no fabricated state.
 */

import type { ExecutionMode } from './executionModeStore';
import type { InitiativeMode } from './initiativeStore';

export type InstinctDecision = 'act' | 'ask' | 'quiet' | 'escalate';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type PhraseStyle = 'directive' | 'suggestion' | 'question';

export interface InstinctSignals {
  stuck: boolean;           // repeated failures on same issue
  drifting: boolean;        // user is switching context repeatedly
  urgencyLevel: 'high' | 'medium' | 'low';
  inFlow: boolean;          // momentum is strong — protect it
  isExternalAction: boolean; // would affect data outside Henry
  isDestructive: boolean;   // would change or delete something
  executionMode: ExecutionMode;
  initiativeMode: InitiativeMode;
  suggestionStrength: 'strong' | 'moderate' | 'weak';
}

export interface InstinctResult {
  decision: InstinctDecision;
  confidence: ConfidenceLevel;
  phraseStyle: PhraseStyle;
  reason: string;
}

export function computeInstinct(signals: InstinctSignals): InstinctResult {
  const {
    stuck,
    drifting,
    urgencyLevel,
    inFlow,
    isExternalAction,
    isDestructive,
    executionMode,
    initiativeMode,
    suggestionStrength,
  } = signals;

  // ── Rule 1: Always ask for destructive or external writes ──────────────────
  if (isDestructive || (isExternalAction && urgencyLevel !== 'high')) {
    return {
      decision: 'ask',
      confidence: 'medium',
      phraseStyle: 'question',
      reason: isDestructive
        ? 'Action is destructive — must confirm before proceeding.'
        : 'External write action — permission required.',
    };
  }

  // ── Rule 2: Escalate — urgent + blocked/stuck ──────────────────────────────
  if (urgencyLevel === 'high' && stuck) {
    return {
      decision: 'escalate',
      confidence: 'high',
      phraseStyle: 'directive',
      reason: 'Urgent issue is stalling — this warrants interrupting.',
    };
  }

  // ── Rule 3: Escalate — high urgency in operator/recovery mode ─────────────
  if (urgencyLevel === 'high' && (executionMode === 'operator' || executionMode === 'recovery')) {
    return {
      decision: 'escalate',
      confidence: 'high',
      phraseStyle: 'directive',
      reason: `High urgency in ${executionMode} mode — surface the issue.`,
    };
  }

  // ── Rule 4: Stay quiet during focus mode (unless escalation applies) ───────
  if (executionMode === 'focus') {
    return {
      decision: 'quiet',
      confidence: 'high',
      phraseStyle: 'directive',
      reason: 'Focus mode active — suppress all but urgent blockers.',
    };
  }

  // ── Rule 5: Stay quiet if in flow and suggestion is weak ──────────────────
  if (inFlow && suggestionStrength !== 'strong') {
    return {
      decision: 'quiet',
      confidence: 'medium',
      phraseStyle: 'directive',
      reason: 'User is in flow — protecting momentum.',
    };
  }

  // ── Rule 6: Stay quiet if initiative is quiet ─────────────────────────────
  if (initiativeMode === 'quiet' && !stuck && urgencyLevel === 'low') {
    return {
      decision: 'quiet',
      confidence: 'high',
      phraseStyle: 'directive',
      reason: 'Initiative set to quiet — hold back.',
    };
  }

  // ── Rule 7: Act if internal, obvious, strong suggestion ───────────────────
  if (!isExternalAction && suggestionStrength === 'strong') {
    return {
      decision: 'act',
      confidence: 'high',
      phraseStyle: 'directive',
      reason: 'Internal action, strong signal — take initiative.',
    };
  }

  // ── Rule 8: Nudge if drifting and initiative allows ───────────────────────
  if (drifting && initiativeMode !== 'quiet') {
    return {
      decision: 'act',
      confidence: 'medium',
      phraseStyle: 'suggestion',
      reason: 'Drift detected — surface a refocus suggestion.',
    };
  }

  // ── Rule 9: Stuck but not urgent — suggest ─────────────────────────────────
  if (stuck && urgencyLevel === 'medium') {
    return {
      decision: 'act',
      confidence: 'medium',
      phraseStyle: 'suggestion',
      reason: 'Stuck on same issue — offer a concrete next step.',
    };
  }

  // ── Default: ask if uncertain about anything external ─────────────────────
  if (isExternalAction || suggestionStrength === 'weak') {
    return {
      decision: 'ask',
      confidence: 'low',
      phraseStyle: 'question',
      reason: 'Uncertain — check in before acting.',
    };
  }

  return {
    decision: 'quiet',
    confidence: 'low',
    phraseStyle: 'directive',
    reason: 'No strong signal to act on.',
  };
}

/**
 * Maps confidence level to phrase style template.
 * High = direct instruction, Medium = suggestion, Low = question.
 */
export function phraseStyleLabel(style: PhraseStyle): string {
  switch (style) {
    case 'directive': return 'Do this next';
    case 'suggestion': return 'You may want to try this';
    case 'question': return 'Want me to look into this?';
  }
}

/**
 * Build a simple instinct from current live state.
 * Reads localStorage to produce signals — no fake data.
 */
export function computeInstinctFromState(
  executionMode: ExecutionMode,
  initiativeMode: InitiativeMode,
): InstinctResult {
  function safeJSON<T>(key: string, fallback: T): T {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  }

  const tasks = safeJSON<any[]>('henry:tasks', []);
  const failed = tasks.filter((t) => t.status === 'failed');
  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'queued');
  const connections = safeJSON<Record<string, any>>('henry:connections', {});
  const expired = Object.entries(connections).filter(([, v]) => v?.status === 'expired');
  const reminders = safeJSON<any[]>('henry:reminders', []);
  const overdue = reminders.filter((r) => !r.done && r.dueAt && new Date(r.dueAt).getTime() < Date.now());

  const stuck = failed.length > 1;
  const urgencyLevel: 'high' | 'medium' | 'low' =
    overdue.length > 2 || expired.length > 0 ? 'high' :
    pending.length > 5 ? 'medium' : 'low';
  const suggestionStrength: 'strong' | 'moderate' | 'weak' =
    stuck ? 'strong' : urgencyLevel === 'high' ? 'strong' : urgencyLevel === 'medium' ? 'moderate' : 'weak';

  return computeInstinct({
    stuck,
    drifting: false, // would need navigation tracking
    urgencyLevel,
    inFlow: pending.length <= 2 && overdue.length === 0 && failed.length === 0,
    isExternalAction: false,
    isDestructive: false,
    executionMode,
    initiativeMode,
    suggestionStrength,
  });
}
