/**
 * Henry AI — Priority Selectors + System Prompt Block
 * High-level accessors and the system prompt context block injected into charter.ts.
 */

import type { PriorityItem, PrioritySnapshot } from './priorityTypes';
import { runPriorityEngine, getPriorityMode } from './priorityEngine';

// ── Utility ────────────────────────────────────────────────────────────────

function shortTitle(item: PriorityItem): string {
  return item.title.replace(/^(Project|Captured|Active app|Note|Computer):\s*/i, '').slice(0, 80);
}

function categoryLabel(item: PriorityItem): string {
  switch (item.category) {
    case 'urgent_now': return 'urgent now';
    case 'important_soon': return 'important soon';
    case 'active_focus': return 'in active focus';
    case 'background': return 'background context';
    case 'parked': return 'parked / later';
    case 'resolved': return 'resolved';
    default: return 'background';
  }
}

// ── Snapshot (cached per run) ──────────────────────────────────────────────

let _lastSnapshot: PrioritySnapshot | null = null;
let _lastSnapshotAt = 0;
const SNAPSHOT_TTL = 30 * 1000; // 30s cache — fresh enough without hammering reads

export function getPrioritySnapshot(force = false): PrioritySnapshot {
  const now = Date.now();
  if (!force && _lastSnapshot && now - _lastSnapshotAt < SNAPSHOT_TTL) {
    return _lastSnapshot;
  }
  _lastSnapshot = runPriorityEngine(getPriorityMode());
  _lastSnapshotAt = now;
  return _lastSnapshot;
}

export function invalidatePriorityCache(): void {
  _lastSnapshot = null;
  _lastSnapshotAt = 0;
}

// ── Named selectors ────────────────────────────────────────────────────────

/** The single most important thing right now. */
export function getTopFocus(): PriorityItem | null {
  return getPrioritySnapshot().topFocus;
}

/** Top 3 items currently in focus. */
export function getTop3(): PriorityItem[] {
  return getPrioritySnapshot().top3;
}

/** Items that should be proactively surfaced in conversation. */
export function getSurfaceNow(): PriorityItem[] {
  return getPrioritySnapshot().surfaceNow;
}

/** Items to actively keep quiet about unless asked. */
export function getKeepQuiet(): PriorityItem[] {
  return getPrioritySnapshot().keepQuiet;
}

/** Full ranked list. */
export function getRankedItems(): PriorityItem[] {
  return getPrioritySnapshot().items;
}

// ── System prompt block ────────────────────────────────────────────────────

/**
 * Generates the priority context block for Henry's system prompt.
 * Injected into charter.ts — informs Henry's initiative and conversation focus.
 * Kept compact and human-readable so it doesn't bloat the prompt.
 */
export function buildPriorityBlock(): string {
  // Gracefully skip if localStorage isn't available (Node/main process)
  if (typeof localStorage === 'undefined') return '';

  let snapshot: PrioritySnapshot;
  try {
    snapshot = getPrioritySnapshot();
  } catch {
    return '';
  }

  const mode = snapshot.mode;
  const modeNote = mode === 'calm'
    ? 'Priority mode: Calm focus — steady, no pressure.'
    : mode === 'urgency'
    ? 'Priority mode: Urgency first — surface time-critical things first.'
    : 'Priority mode: Balanced.';

  const lines: string[] = [`## Henry's current priority picture (${modeNote})`];

  // Top focus
  if (snapshot.topFocus) {
    lines.push(`Top focus right now: "${shortTitle(snapshot.topFocus)}" (${categoryLabel(snapshot.topFocus)}, score ${snapshot.topFocus.score}/100)${snapshot.topFocus.context ? ` — ${snapshot.topFocus.context}` : ''}.`);
  }

  // Urgent now
  if (snapshot.urgentNow.length) {
    const urgentList = snapshot.urgentNow.slice(0, 3).map((i) => `"${shortTitle(i)}"${i.context ? ` (${i.context})` : ''}`).join(', ');
    lines.push(`Urgent now: ${urgentList}.`);
  }

  // Important soon
  if (snapshot.importantSoon.length) {
    const soonList = snapshot.importantSoon.slice(0, 3).map((i) => `"${shortTitle(i)}"`).join(', ');
    lines.push(`Important soon: ${soonList}.`);
  }

  // Active focus (not already in urgent/important)
  const focusOnly = snapshot.activeFocus.filter(
    (i) => !snapshot.urgentNow.includes(i) && !snapshot.importantSoon.includes(i)
  ).slice(0, 3);
  if (focusOnly.length) {
    lines.push(`Active focus: ${focusOnly.map((i) => `"${shortTitle(i)}"`).join(', ')}.`);
  }

  // What to surface now vs. keep quiet
  if (snapshot.surfaceNow.length) {
    lines.push(`Surface proactively if relevant: ${snapshot.surfaceNow.map((i) => `"${shortTitle(i)}"`).join(', ')}.`);
  }

  const quietCount = snapshot.keepQuiet.length;
  if (quietCount > 0) {
    lines.push(`${quietCount} item${quietCount !== 1 ? 's' : ''} in background / deferred — don't volunteer these unless asked.`);
  }

  if (lines.length <= 1) return ''; // Only header, nothing to say

  lines.push('');
  lines.push('Use this picture to decide what to mention first, what to connect, and what to leave quiet. Do not recite the list. Use it as internal awareness.');

  return lines.join('\n');
}

// ── Plain-language helpers for conversation ────────────────────────────────

/** Returns a calm, plain-language summary Henry can speak or use internally. */
export function getPrioritySummary(): string {
  const snap = getPrioritySnapshot();
  const parts: string[] = [];

  if (snap.topFocus) {
    parts.push(`The most important thing right now is "${shortTitle(snap.topFocus)}"`);
  }

  if (snap.urgentNow.length > 1) {
    const rest = snap.urgentNow.slice(1, 3).map((i) => `"${shortTitle(i)}"`).join(' and ');
    parts.push(`${rest} also need attention soon`);
  }

  if (snap.deferred.length > 0) {
    parts.push(`${snap.deferred.length} thing${snap.deferred.length !== 1 ? 's' : ''} parked for later`);
  }

  if (!parts.length) return 'Nothing urgent right now.';
  return parts.join('. ') + '.';
}
