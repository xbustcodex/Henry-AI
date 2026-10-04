/**
 * Henry AI — Initiative Engine
 *
 * Converts ranked priority data into initiative decisions:
 * "should I surface something, and if so, what exactly do I say?"
 *
 * This replaces guessing with reading. The initiative engine consumes:
 * - The shared brain state (coordinator output — pre-filtered, suppression-aware)
 * - Current session mode
 * - Current daily rhythm phase
 * - Initiative mode setting (quiet / balanced / proactive)
 *
 * It does NOT re-read priority sources or re-score items.
 * The background brain + coordinator have already done that work.
 * The initiative engine converts that output into a suggestion.
 */

import { getSharedBrainState } from '../../brain/sharedState';
import { getInitiativeMode } from '../../henry/initiativeStore';
import { inferRhythmPhase } from '../../henry/dailyRhythm';
import type { PriorityItem } from '../../henry/priority/priorityTypes';

// ── Types ─────────────────────────────────────────────────────────────────────

export type InitiativeSuggestionStrength =
  | 'silent'    // Don't surface anything
  | 'gentle'    // Mention briefly, don't push
  | 'clear'     // Surface plainly
  | 'direct';   // Needs attention, say it plainly

export interface InitiativeSuggestion {
  /** Whether to surface anything at all. */
  shouldSurface: boolean;
  /** Message Henry should use if surfacing. Null if shouldSurface=false. */
  message: string | null;
  /** How strongly to deliver the message. */
  strength: InitiativeSuggestionStrength;
  /** The underlying priority item driving this suggestion, if any. */
  sourceItem: PriorityItem | null;
  /** Plain-language reason this was chosen. */
  reason: string;
}

// ── Session mode helpers ───────────────────────────────────────────────────────

function getSessionMode(): string {
  try {
    return (typeof localStorage !== 'undefined' ? localStorage.getItem('henry:session_mode') : null) ?? 'auto';
  } catch { return 'auto'; }
}

/** Returns true when the current session mode allows proactive surfacing. */
function sessionAllowsSurfacing(): boolean {
  const mode = getSessionMode();
  // build = deep focus — stay quiet unless urgent; reflection = stepping back, stay gentle
  if (mode === 'build') return false;
  if (mode === 'reflection') return false;
  return true;
}

// ── Rhythm helpers ─────────────────────────────────────────────────────────────

/** Returns true when the rhythm phase allows surfacing. */
function rhythmAllowsSurfacing(): boolean {
  try {
    const phase = inferRhythmPhase();
    // Evening review: wind-down phase — stay gentle unless proactive mode
    if (phase === 'evening_review') {
      return getInitiativeMode() === 'proactive';
    }
    return true;
  } catch { return true; }
}

// ── Message builders ──────────────────────────────────────────────────────────

function buildUrgentMessage(item: PriorityItem): string {
  const title = item.title.replace(/^(Project|Captured|Note|Active app|Computer):\s*/i, '').slice(0, 80);
  if (item.signals.isOverdue) return `"${title}" is overdue — worth addressing.`;
  if (item.context) return `"${title}" needs attention — ${item.context}.`;
  return `"${title}" is the most pressing thing right now.`;
}

function buildFocusMessage(item: PriorityItem): string {
  const title = item.title.replace(/^(Project|Captured|Note|Active app|Computer):\s*/i, '').slice(0, 80);
  if (item.source === 'commitment') return `Open commitment: "${title}".`;
  if (item.source === 'relationship') return `${title}`;
  if (item.context) return `"${title}" — ${item.context}.`;
  return `"${title}" is worth your focus when ready.`;
}

function buildThreadMessage(thread: string): string {
  return `Still tracking "${thread}" — let me know when you're ready to pick it up.`;
}

function buildConnectionMessage(services: string[]): string {
  const list = services.slice(0, 2).join(' and ');
  return `${list} ${services.length > 1 ? 'need' : 'needs'} to be reconnected.`;
}

// ── Strength from score ────────────────────────────────────────────────────────

function strengthFromScore(score: number): InitiativeSuggestionStrength {
  if (score >= 80) return 'direct';
  if (score >= 60) return 'clear';
  if (score >= 40) return 'gentle';
  return 'silent';
}

// ── Main engine ───────────────────────────────────────────────────────────────

/**
 * Evaluate initiative and produce a suggestion.
 *
 * Call this from the chat view or background brain when deciding
 * whether Henry should proactively say something.
 */
export function evaluateInitiative(): InitiativeSuggestion {
  const silent: InitiativeSuggestion = {
    shouldSurface: false,
    message: null,
    strength: 'silent',
    sourceItem: null,
    reason: '',
  };

  const initiativeMode = getInitiativeMode();

  // Quiet mode: never surface proactively
  if (initiativeMode === 'quiet') {
    return { ...silent, reason: 'Initiative mode is quiet — not surfacing.' };
  }

  // Check session + rhythm gates
  if (!sessionAllowsSurfacing()) {
    return { ...silent, reason: `Session mode (${getSessionMode()}) suppresses proactive surfacing.` };
  }
  if (!rhythmAllowsSurfacing()) {
    return { ...silent, reason: 'Rhythm phase suppresses proactive surfacing.' };
  }

  const state = getSharedBrainState();
  const snap = state.prioritySnapshot;

  // Minimum score threshold by initiative mode
  const threshold = initiativeMode === 'proactive' ? 40 : 60;

  // ── 1. Connection alerts — high priority regardless of item scores ─────────
  const { reconnectNeeded } = state;
  if (reconnectNeeded.length > 0) {
    return {
      shouldSurface: true,
      message: buildConnectionMessage(reconnectNeeded),
      strength: 'clear',
      sourceItem: null,
      reason: `${reconnectNeeded.length} service(s) need reconnection.`,
    };
  }

  // ── 2. Coordinator-filtered surface items (pre-suppressed) ────────────────
  if (state.surfaceNow.length > 0) {
    // The coordinator has already done threshold + suppression filtering.
    // Map back to a priority item if we can, otherwise use the string.
    const surfaceLabel = state.surfaceNow[0];
    const matchedItem = snap?.surfaceNow.find(
      (i) => i.title.replace(/^(Project|Captured|Note|Active app|Computer):\s*/i, '').slice(0, 80) === surfaceLabel
    ) ?? null;

    const score = matchedItem?.score ?? threshold; // assume threshold if no match
    const strength = strengthFromScore(score);

    let message: string;
    if (matchedItem?.category === 'urgent_now') {
      message = buildUrgentMessage(matchedItem);
    } else if (matchedItem) {
      message = buildFocusMessage(matchedItem);
    } else {
      message = `Worth your attention: "${surfaceLabel}".`;
    }

    return {
      shouldSurface: true,
      message,
      strength,
      sourceItem: matchedItem,
      reason: `Coordinator surfaced: "${surfaceLabel}" (score ${score}).`,
    };
  }

  // ── 3. Proactive mode: pick the top focus item if it's strong enough ──────
  if (initiativeMode === 'proactive' && snap?.topFocus && snap.topFocus.score >= threshold) {
    const item = snap.topFocus;
    const message = item.category === 'urgent_now'
      ? buildUrgentMessage(item)
      : buildFocusMessage(item);

    return {
      shouldSurface: true,
      message,
      strength: strengthFromScore(item.score),
      sourceItem: item,
      reason: `Proactive mode — top focus item score ${item.score}.`,
    };
  }

  // ── 4. Active thread with unresolved items ────────────────────────────────
  if (initiativeMode === 'proactive' && state.activeThread) {
    return {
      shouldSurface: true,
      message: buildThreadMessage(state.activeThread),
      strength: 'gentle',
      sourceItem: null,
      reason: `Active thread still open: "${state.activeThread}".`,
    };
  }

  return { ...silent, reason: 'No high-enough signal to surface.' };
}

/**
 * Returns true if there is anything worth Henry mentioning unprompted.
 * Lightweight check — used to decide whether to run evaluateInitiative().
 */
export function hasAnythingToSurface(): boolean {
  const state = getSharedBrainState();
  const mode = getInitiativeMode();
  if (mode === 'quiet') return false;
  if (state.reconnectNeeded.length > 0) return true;
  if (state.surfaceNow.length > 0) return true;
  if (mode === 'proactive' && (state.topFocus || state.activeThread)) return true;
  return false;
}
