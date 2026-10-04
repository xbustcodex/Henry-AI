/**
 * Henry AI — Coordinator
 * Reads from shared brain state (priority snapshot, connection health, awareness)
 * and decides what the front brain should say, surface, or keep quiet.
 *
 * Suppression rules:
 * - Same item not surfaced again within 20 minutes
 * - Items below score threshold don't get surfaced unless initiative mode = proactive
 * - Connection alerts only surface once per session per service
 * - Maximum 2 items in surfaceNow regardless of how many are ready
 */

import { useSharedBrainState, getSharedBrainState } from './sharedState';
import { getInitiativeMode } from '../henry/initiativeStore';
import { loadActiveThreads, buildContinuityThreadBlock } from '../henry/threads/threadStore';
import { buildReflectiveMindBlock } from './reflectiveMind';
import type { ReflectiveOutput } from './reflectiveMind';

const SUPPRESSION_KEY = 'henry:coordinator_surfaced';
const SUPPRESSION_WINDOW_MS = 20 * 60 * 1000; // 20 minutes
const SESSION_ALERTS_KEY = 'henry:coordinator_session_alerts';

// ── Suppression ────────────────────────────────────────────────────────────

interface SurfacedRecord {
  id: string;
  surfacedAt: number;
}

function getSurfaced(): SurfacedRecord[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SUPPRESSION_KEY) : null;
    if (!raw) return [];
    const records: SurfacedRecord[] = JSON.parse(raw);
    // Prune stale records
    const cutoff = Date.now() - SUPPRESSION_WINDOW_MS;
    return records.filter((r) => r.surfacedAt > cutoff);
  } catch { return []; }
}

function markSurfaced(id: string): void {
  try {
    const records = getSurfaced();
    records.push({ id, surfacedAt: Date.now() });
    if (typeof localStorage !== 'undefined') localStorage.setItem(SUPPRESSION_KEY, JSON.stringify(records));
  } catch { /* ignore */ }
}

function wasSurfacedRecently(id: string): boolean {
  return getSurfaced().some((r) => r.id === id);
}

function getSessionAlerts(): string[] {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_ALERTS_KEY) : null;
    if (!raw) return [];
    return JSON.parse(raw);
  } catch { return []; }
}

function markAlertSeen(service: string): void {
  try {
    const seen = getSessionAlerts();
    if (!seen.includes(service)) seen.push(service);
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SESSION_ALERTS_KEY, JSON.stringify(seen));
  } catch { /* ignore */ }
}

// ── Score threshold by initiative mode ────────────────────────────────────

function getSurfaceThreshold(): number {
  const mode = getInitiativeMode();
  if (mode === 'proactive') return 40;  // surface more freely
  if (mode === 'quiet') return 99;      // essentially never surface proactively
  return 60;                            // balanced: only high-score items
}

// ── Main coordinator logic ─────────────────────────────────────────────────

export function runCoordinator(): void {
  const state = getSharedBrainState();
  const { prioritySnapshot, connectionHealth } = state;

  const threshold = getSurfaceThreshold();
  const surfaceNow: string[] = [];
  const keepQuiet: string[] = [];
  const connectionAlerts: string[] = [];
  let topFocus: string | null = null;
  let activeThread: string | null = null;
  const secondaryThreads: string[] = [];
  let unresolvedCount = 0;

  // ── Continuity threads ──────────────────────────────────────────────────
  const threads = loadActiveThreads();
  if (threads.length > 0) {
    activeThread = threads[0].title;
    for (const t of threads.slice(1, 3)) {
      secondaryThreads.push(t.title);
    }
  }

  // ── Priority items ─────────────────────────────────────────────────────
  if (prioritySnapshot) {
    const { items, topFocus: pTopFocus, surfaceNow: pSurface, keepQuiet: pKeep } = prioritySnapshot;

    // Top focus
    if (pTopFocus) {
      const label = pTopFocus.title.replace(/^(Project|Captured|Note|Active app|Computer):\s*/i, '').slice(0, 80);
      topFocus = `"${label}" (${pTopFocus.category.replace('_', ' ')})`;
    }

    // Surface now — filtered by threshold + suppression
    for (const item of pSurface) {
      if (surfaceNow.length >= 2) break; // max 2
      if (item.score < threshold) continue;
      const id = item.id;
      if (wasSurfacedRecently(id)) continue;
      const label = item.title.replace(/^(Project|Captured|Note|Active app|Computer):\s*/i, '').slice(0, 80);
      surfaceNow.push(label);
      markSurfaced(id);
    }

    // Keep quiet
    for (const item of pKeep.slice(0, 5)) {
      const label = item.title.replace(/^(Project|Captured|Note|Active app|Computer):\s*/i, '').slice(0, 60);
      keepQuiet.push(label);
    }

    // Unresolved count
    unresolvedCount = items.filter((i) => i.signals.isUnresolved && i.category !== 'resolved').length;
  }

  // ── Connection health alerts ───────────────────────────────────────────
  const sessionAlerts = getSessionAlerts();
  for (const { service, status } of connectionHealth) {
    if (sessionAlerts.includes(service)) continue; // already alerted this session
    if (status === 'expiring') {
      connectionAlerts.push(`${service} connection expiring soon — may need to reconnect`);
      markAlertSeen(service);
    } else if (status === 'disconnected') {
      connectionAlerts.push(`${service} is disconnected`);
      markAlertSeen(service);
    }
  }

  // ── Write coordinator output to shared state ───────────────────────────
  useSharedBrainState.getState()._setCoordinatorOutput({
    surfaceNow,
    topFocus,
    keepQuiet,
    connectionAlerts,
    activeThread,
    secondaryThreads,
    unresolvedCount,
  });
}

// ── System prompt block ────────────────────────────────────────────────────

/**
 * Aggregate the world model into a system prompt block for the foreground mind.
 *
 * Sources pulled together here:
 *   - Priority snapshot  → topFocus, surfaceNow, keepQuiet
 *   - Continuity threads → activeThread, thread block
 *   - Connection health  → connectionAlerts
 *   - Reflective mind   → suggestedNextMove, rhythm, drift, neglect, notes
 *
 * Pre-computed, noise-filtered, suppression-aware.
 * Falls back to empty string when background brain has not run yet.
 */
export function buildCoordinatorBlock(): string {
  if (typeof localStorage === 'undefined') return '';

  const state = getSharedBrainState();
  const {
    surfaceNow, topFocus, keepQuiet, connectionAlerts,
    unresolvedCount, priorityReadyAt,
    // Reflective mind output
    suggestedNextMove, rhythmPhase, rhythmLabel,
    driftWarnings, neglectedItems, reflectiveNotes,
  } = state;

  // If background brain hasn't run yet, nothing to say
  if (!priorityReadyAt) return '';

  const lines: string[] = [];
  const age = Math.round((Date.now() - priorityReadyAt) / 1000);
  const ageStr = age < 10 ? 'just now' : age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;

  lines.push(`## Live mind state (updated ${ageStr})`);

  // ── Priority + focus ──────────────────────────────────────────────────────
  if (topFocus) lines.push(`Current top focus: ${topFocus}.`);

  // ── Continuity threads ────────────────────────────────────────────────────
  const threadBlock = buildContinuityThreadBlock();
  if (threadBlock) lines.push(threadBlock);

  // ── Items to surface ──────────────────────────────────────────────────────
  if (surfaceNow.length) {
    lines.push(`Worth surfacing if relevant: ${surfaceNow.map((s) => `"${s}"`).join(', ')}.`);
  }

  // ── Connection alerts ─────────────────────────────────────────────────────
  if (connectionAlerts.length) {
    lines.push(`Connection alert: ${connectionAlerts.join('; ')}.`);
  }

  // ── Unresolved count ──────────────────────────────────────────────────────
  if (unresolvedCount > 0) {
    lines.push(`${unresolvedCount} unresolved item${unresolvedCount !== 1 ? 's' : ''} in background.`);
  }

  // ── Suppressed items ──────────────────────────────────────────────────────
  if (keepQuiet.length) {
    lines.push(`Keep quiet about: ${keepQuiet.slice(0, 3).map((s) => `"${s}"`).join(', ')} — don't volunteer unless asked.`);
  }

  // ── Reflective mind block ─────────────────────────────────────────────────
  // Only included when the reflective mind has run (rhythmPhase is set)
  if (rhythmPhase) {
    const reflective: ReflectiveOutput = {
      suggestedNextMove: suggestedNextMove ?? null,
      rhythmPhase,
      rhythmLabel: rhythmLabel ?? '',
      driftWarnings,
      neglectedItems,
      reflectiveNotes,
    };
    const reflectiveBlock = buildReflectiveMindBlock(reflective);
    if (reflectiveBlock) lines.push('', reflectiveBlock);
  }

  if (lines.length <= 1) return ''; // Only the header — nothing to say

  lines.push('');
  lines.push('This was prepared in the background. Use it naturally — don\'t announce it, don\'t recite it.');

  return lines.join('\n');
}
