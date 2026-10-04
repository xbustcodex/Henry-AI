/**
 * Henry AI — Priority Engine
 * Scores and categorizes all priority items into a structured snapshot.
 *
 * Scoring model (0–100):
 * - Base: 20
 * - Overdue: +40
 * - Due within 1h: +30, 6h: +20, 24h: +12, this week: +6
 * - Explicit urgent: +25
 * - Blocking other work: +18
 * - Mention count: +5 per (max +20)
 * - Active project tie: +12
 * - Unresolved: +8
 * - Recent (1h): +10, 6h: +5
 * - Connected context: +6
 * - Computer context: +5
 * - Emotional weight: up to +10
 *
 * Mode multipliers applied after base scoring:
 * - urgency: time-pressure signals × 1.5
 * - calm: time-pressure signals × 0.6, urgency × 0.5
 * - balanced: no adjustment
 */

import type {
  PriorityItem,
  PriorityCategory,
  PriorityMode,
  PrioritySnapshot,
  PrioritySignals,
} from './priorityTypes';
import { PRIORITY_MODE_KEY } from './priorityTypes';
import { loadAllPrioritySources } from './prioritySources';
import { detectActiveConflicts, type ConflictSnapshot } from '../conflictDetector';

// ── Mode helpers ───────────────────────────────────────────────────────────

export function getPriorityMode(): PriorityMode {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(PRIORITY_MODE_KEY) : null;
    if (v === 'calm' || v === 'balanced' || v === 'urgency') return v;
  } catch { /* ignore */ }
  return 'balanced';
}

export function setPriorityMode(mode: PriorityMode): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PRIORITY_MODE_KEY, mode);
  } catch { /* ignore */ }
}

// ── Score calculation ──────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function scoreItem(item: PriorityItem, mode: PriorityMode): number {
  const s: PrioritySignals = item.signals;
  let score = 20; // base

  // Time pressure signals — affected by mode
  const timeMult = mode === 'urgency' ? 1.5 : mode === 'calm' ? 0.6 : 1;
  const urgMult = mode === 'urgency' ? 1.5 : mode === 'calm' ? 0.5 : 1;

  if (s.isOverdue) score += Math.round(40 * timeMult);
  if (s.dueWithinMs != null) {
    if (s.dueWithinMs <= HOUR) score += Math.round(30 * timeMult);
    else if (s.dueWithinMs <= 6 * HOUR) score += Math.round(20 * timeMult);
    else if (s.dueWithinMs <= DAY) score += Math.round(12 * timeMult);
    else if (s.dueWithinMs <= WEEK) score += Math.round(6 * timeMult);
  }
  if (s.isExplicitUrgent) score += Math.round(25 * urgMult);
  if (s.isBlockingOther) score += Math.round(18 * timeMult);

  // Relevance signals — not affected by mode
  if (s.mentionCount) score += Math.min(s.mentionCount * 5, 20);
  if (s.hasActiveProject) score += 12;
  if (s.isUnresolved) score += 8;
  if (s.emotionalWeight) score += Math.round(s.emotionalWeight * 10);
  if (s.hasConnectedContext) score += 6;
  if (s.hasComputerContext) score += 5;

  // Recency bonus (newer = slightly more relevant)
  if (s.recencyMs != null) {
    if (s.recencyMs <= HOUR) score += 10;
    else if (s.recencyMs <= 6 * HOUR) score += 5;
    else if (s.recencyMs <= DAY) score += 2;
  }

  return Math.min(Math.max(Math.round(score), 0), 100);
}

// ── Category assignment ────────────────────────────────────────────────────

function assignCategory(item: PriorityItem, mode: PriorityMode): PriorityCategory {
  const s = item.signals;
  const score = item.score;
  const timePressureThreshold = mode === 'urgency' ? 55 : mode === 'calm' ? 75 : 65;

  // Overdue or very high score and explicit urgency → urgent now
  if (s.isOverdue || (s.isExplicitUrgent && score >= timePressureThreshold)) return 'urgent_now';

  // Due soon (within 6h or today) with decent score → important soon
  if (s.dueWithinMs != null && s.dueWithinMs <= 6 * HOUR && score >= 45) return 'important_soon';
  if (s.dueWithinMs != null && s.dueWithinMs <= DAY && score >= 40) return 'important_soon';

  // High score tied to active project or blocking → active focus
  if (score >= 50 && (s.hasActiveProject || s.isBlockingOther)) return 'active_focus';

  // High score generally → active focus
  if (score >= 60) return 'active_focus';

  // Medium score → background but relevant
  if (score >= 30) return 'background';

  // Low score → parked
  return 'parked';
}

// ── Conflict adjustments ───────────────────────────────────────────────────

/**
 * Apply Constitution-driven score adjustments before categorization.
 *
 * P1 (What Matters Most) active:
 *   Boost commitment and relationship items by +15 so they float above noise.
 *
 * P3 (Calm Over Chaos) active:
 *   Reduce background/parked item scores by 15 so they don't earn surfacing.
 *
 * P7 (Do Not Waste) active:
 *   Floor high-weight commitment scores at 30 (background threshold) so they
 *   never silently fall to parked.
 */
function applyConflictAdjustments(
  items: PriorityItem[],
  conflicts: ConflictSnapshot
): PriorityItem[] {
  return items.map((item) => {
    let score = item.score;

    // P1 — lift meaningful items
    if (conflicts.mattersMostActive) {
      if (item.source === 'commitment' || item.source === 'relationship') {
        score = Math.min(score + 15, 100);
      }
    }

    // P3 — suppress low-weight noise (only background/parked candidates)
    if (conflicts.calmActive) {
      const isNoise =
        item.source !== 'commitment' &&
        item.source !== 'relationship' &&
        !item.signals.isOverdue &&
        !item.signals.isExplicitUrgent;
      if (isNoise && score < 50) {
        score = Math.max(score - 15, 0);
      }
    }

    // P7 — floor high-weight commitments at background threshold
    if (conflicts.doNotWasteActive) {
      if (item.source === 'commitment' && item.score < 30) {
        score = Math.max(score, 30);
      }
    }

    return score !== item.score ? { ...item, score } : item;
  });
}

// ── Main engine ────────────────────────────────────────────────────────────

export function runPriorityEngine(mode?: PriorityMode): PrioritySnapshot {
  const resolvedMode = mode ?? getPriorityMode();
  const rawItems = loadAllPrioritySources();

  // Detect active Constitution signals — used for score adjustments below
  const conflicts = detectActiveConflicts();

  // Score every item
  const scored: PriorityItem[] = rawItems.map((item) => {
    const score = scoreItem(item, resolvedMode);
    return { ...item, score };
  });

  // Apply conflict-aware adjustments (P1 / P3 / P7)
  const adjusted = applyConflictAdjustments(scored, conflicts);

  // Assign categories
  const categorized: PriorityItem[] = adjusted.map((item) => ({
    ...item,
    category: assignCategory(item, resolvedMode),
  }));

  // Sort by score descending
  const items = [...categorized].sort((a, b) => b.score - a.score);

  // Build buckets
  const urgentNow = items.filter((i) => i.category === 'urgent_now');
  const importantSoon = items.filter((i) => i.category === 'important_soon');
  const activeFocus = items.filter((i) => i.category === 'active_focus');
  const background = items.filter((i) => i.category === 'background');
  const deferred = items.filter((i) => i.category === 'parked' || i.category === 'resolved');

  // Top focus: prefer urgent > important > active
  const focusCandidates = [...urgentNow, ...importantSoon, ...activeFocus];
  const topFocus = focusCandidates[0] ?? null;
  const top3 = focusCandidates.slice(0, 3);

  // Surface now: P3 (Calm Over Chaos) active → max 2 items, tighter score gate
  // Otherwise: up to 3, active focus included if score ≥ 50
  const activeFocusThreshold = conflicts.calmActive ? 65 : 50;
  const surfaceLimit = conflicts.calmActive ? 2 : 3;

  const surfaceNow = [
    ...urgentNow.slice(0, 2),
    ...importantSoon.slice(0, 2),
    ...activeFocus.filter((i) => i.score >= activeFocusThreshold).slice(0, 1),
  ]
    .filter((v, i, a) => a.indexOf(v) === i) // dedupe
    .slice(0, surfaceLimit);

  // Keep quiet: background + deferred — not worth surfacing unprompted
  const keepQuiet = [...background, ...deferred];

  return {
    takenAt: Date.now(),
    mode: resolvedMode,
    items,
    topFocus,
    top3,
    urgentNow,
    importantSoon,
    activeFocus,
    background,
    deferred,
    surfaceNow,
    keepQuiet,
  };
}
