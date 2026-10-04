/**
 * Henry AI — Conflict Detector
 *
 * Reads live system state at charter-build time and detects which operating
 * principles from the Constitution are actively relevant right now.
 *
 * This is not abstract philosophy — it produces concrete signals:
 *   "P3 is active because a build session is running; suppress noise."
 *   "P1 is active because a weight-9 commitment is competing with urgent tasks."
 *
 * Signals are used in two places:
 *   1. The charter block — tells Henry which principles matter right now and why
 *   2. The priority engine — adjusts scores/surface thresholds based on active signals
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConflictSignal {
  principleId: string;
  principleTitle: string;
  rank: number;
  /** Human-readable: why this principle is firing right now. */
  reason: string;
  /**
   * active — clearly applies; affects behavior
   * watch  — mild signal; worth noting but not strongly enforced
   */
  severity: 'active' | 'watch';
}

export interface ConflictSnapshot {
  takenAt: number;
  signals: ConflictSignal[];
  /** Highest-rank (lowest number) active signal, if any. */
  dominant: ConflictSignal | null;
  /** Whether P3 (Calm Over Chaos) is active — used by priority engine. */
  calmActive: boolean;
  /** Whether P1 (What Matters Most) is active — boosts meaningful items. */
  mattersMostActive: boolean;
  /** Whether P7 (Do Not Waste) is active — protects high-weight items. */
  doNotWasteActive: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeJSON<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ── Individual signal detectors ───────────────────────────────────────────────

/**
 * P1 — What Matters Most
 * Fires when high-weight commitments are competing with urgent noise.
 */
function detectMattersMost(): ConflictSignal | null {
  const commitments = safeJSON<any[]>('henry:commitments:v1', []);
  const openHighWeight = commitments.filter(
    (c) => c.weight >= 8 && c.status !== 'done' && c.status !== 'dropped'
  );
  if (openHighWeight.length === 0) return null;

  const reminders = safeJSON<any[]>('henry:reminders', []);
  const urgentReminders = reminders.filter((r) => !r.done && !r.dismissed && r.priority === 'urgent');
  const tasks = safeJSON<any[]>('henry:tasks', []);
  const urgentTasks = tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'completed' && (t.priority === 'urgent' || t.urgent === true)
  );

  const urgentCount = urgentReminders.length + urgentTasks.length;
  const topCommitment = openHighWeight.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];

  if (urgentCount > 0) {
    return {
      principleId: 'what_matters_most',
      principleTitle: 'What Matters Most',
      rank: 1,
      reason: `"${topCommitment.title}" (weight ${topCommitment.weight}) is competing with ${urgentCount} urgent item${urgentCount > 1 ? 's' : ''}. Meaningful > loud.`,
      severity: 'active',
    };
  }

  // Commitments exist but no competing urgency — softer watch signal
  return {
    principleId: 'what_matters_most',
    principleTitle: 'What Matters Most',
    rank: 1,
    reason: `${openHighWeight.length} high-weight commitment${openHighWeight.length > 1 ? 's' : ''} open. Keep these weighted above transient noise.`,
    severity: 'watch',
  };
}

/**
 * P2 — Continuity Over Reset
 * Fires when active/open threads exist in the continuity store.
 */
function detectContinuity(): ConflictSignal | null {
  const threads = safeJSON<any[]>('henry:continuity_threads:v1', []);
  const open = threads.filter((t) => t.status === 'open' || t.status === 'active');
  if (open.length === 0) return null;

  const titles = open.slice(0, 2).map((t) => `"${t.title}"`).join(', ');
  return {
    principleId: 'continuity_over_reset',
    principleTitle: 'Continuity Over Reset',
    rank: 2,
    reason: `${open.length} open thread${open.length > 1 ? 's' : ''} (${titles}). Carry these forward before shifting context.`,
    severity: 'active',
  };
}

/**
 * P3 — Calm Over Chaos
 * Fires when: build/reflection session, quiet initiative, evening hours, or many items competing.
 */
function detectCalmOverChaos(): ConflictSignal | null {
  const session = safeGet('henry:session_mode') ?? 'auto';
  const initiative = safeGet('henry:initiative_mode') ?? 'balanced';
  const hour = new Date().getHours();
  const isEvening = hour >= 20 || hour < 6;
  const isFocusSession = session === 'build' || session === 'reflection';

  // Count total non-done items as a chaos proxy
  const reminders = safeJSON<any[]>('henry:reminders', []).filter((r) => !r.done && !r.dismissed).length;
  const tasks = safeJSON<any[]>('henry:tasks', []).filter(
    (t) => t.status !== 'done' && t.status !== 'completed'
  ).length;
  const captures = safeJSON<any[]>('henry:captures_v1', []).filter(
    (c) => c.status !== 'routed' && c.status !== 'archived'
  ).length;
  const totalCompeting = reminders + tasks + captures;
  const highLoad = totalCompeting > 10;

  const reasons: string[] = [];
  let severity: 'active' | 'watch' = 'watch';

  if (isFocusSession) {
    reasons.push(`${session} session active`);
    severity = 'active';
  }
  if (initiative === 'quiet') {
    reasons.push('initiative set to quiet');
    severity = 'active';
  }
  if (isEvening) {
    reasons.push('evening hours');
    if (severity === 'watch') severity = 'active';
  }
  if (highLoad) {
    reasons.push(`${totalCompeting} items competing for attention`);
    severity = 'active';
  }

  if (reasons.length === 0) return null;

  return {
    principleId: 'calm_over_chaos',
    principleTitle: 'Calm Over Chaos',
    rank: 3,
    reason: `${reasons.join('; ')}. Surface only what earns its place — suppress low-weight items.`,
    severity,
  };
}

/**
 * P4 — Action With Intention
 * Fires when initiative is quiet or there are many unrouted captures piling up.
 */
function detectActionWithIntention(): ConflictSignal | null {
  const initiative = safeGet('henry:initiative_mode') ?? 'balanced';
  const captures = safeJSON<any[]>('henry:captures_v1', []).filter(
    (c) => c.status !== 'routed' && c.status !== 'archived'
  ).length;

  const reasons: string[] = [];

  if (initiative === 'quiet') reasons.push('initiative set to quiet — act only when explicitly helpful');
  if (captures > 4) reasons.push(`${captures} unrouted captures — route intentionally, not automatically`);

  if (reasons.length === 0) return null;

  return {
    principleId: 'action_with_intention',
    principleTitle: 'Action With Intention',
    rank: 4,
    reason: reasons.join('; '),
    severity: initiative === 'quiet' ? 'active' : 'watch',
  };
}

/**
 * P5 — Truth Over Appearance
 * Fires when connected services are in a degraded/missing state.
 * (This principle is always implicitly active; only emit a signal when
 * there's a real gap to flag — e.g. a service is disconnected.)
 */
function detectTruthOverAppearance(): ConflictSignal | null {
  const connections = safeJSON<Record<string, any>>('henry:connections', {});
  const degraded = Object.entries(connections)
    .filter(([, v]) => v?.status === 'disconnected' || v?.status === 'error')
    .map(([k]) => k);

  if (degraded.length === 0) return null;

  return {
    principleId: 'truth_over_appearance',
    principleTitle: 'Truth Over Appearance',
    rank: 5,
    reason: `${degraded.join(', ')} ${degraded.length === 1 ? 'is' : 'are'} disconnected. Name any capability gaps plainly — do not imply access you don't have.`,
    severity: 'active',
  };
}

/**
 * P6 — Respect the User's Values
 * Fires when the user has set any active non-negotiable values.
 */
function detectRespectValues(): ConflictSignal | null {
  const values = safeJSON<any[]>('henry:values:v1', []);
  const nonNeg = values.filter((v) => v.active !== false && v.nonNegotiable === true);
  if (nonNeg.length === 0) return null;

  const titles = nonNeg.slice(0, 3).map((v) => `"${v.title}"`).join(', ');
  return {
    principleId: 'respect_values',
    principleTitle: "Respect the User's Values",
    rank: 6,
    reason: `${nonNeg.length} non-negotiable value${nonNeg.length > 1 ? 's' : ''} set (${titles}). Use as an alignment lens — don't optimize against them.`,
    severity: 'active',
  };
}

/**
 * P7 — Do Not Waste
 * Fires when unrouted captures exist or high-weight commitments are going stale.
 */
function detectDoNotWaste(): ConflictSignal | null {
  const captures = safeJSON<any[]>('henry:captures_v1', []).filter(
    (c) => c.status !== 'routed' && c.status !== 'archived'
  );

  const commitments = safeJSON<any[]>('henry:commitments:v1', []);
  const now = Date.now();
  const staleCommitments = commitments.filter(
    (c) =>
      c.weight >= 7 &&
      c.status !== 'done' &&
      c.status !== 'dropped' &&
      c.lastTouchedAt &&
      now - new Date(c.lastTouchedAt).getTime() > 3 * DAY
  );

  const parts: string[] = [];
  if (captures.length > 0) parts.push(`${captures.length} unrouted capture${captures.length > 1 ? 's' : ''}`);
  if (staleCommitments.length > 0) parts.push(`${staleCommitments.length} high-weight commitment${staleCommitments.length > 1 ? 's' : ''} untouched for 3+ days`);

  if (parts.length === 0) return null;

  return {
    principleId: 'do_not_waste',
    principleTitle: 'Do Not Waste',
    rank: 7,
    reason: `${parts.join('; ')}. Keep these weighted — don't let important things quietly disappear.`,
    severity: captures.length > 3 || staleCommitments.length > 0 ? 'active' : 'watch',
  };
}

// ── Main detector ─────────────────────────────────────────────────────────────

/**
 * Detect all active principle signals from current system state.
 * Returns a snapshot with all signals sorted by rank (ascending).
 */
export function detectActiveConflicts(): ConflictSnapshot {
  const raw = [
    detectMattersMost(),
    detectContinuity(),
    detectCalmOverChaos(),
    detectActionWithIntention(),
    detectTruthOverAppearance(),
    detectRespectValues(),
    detectDoNotWaste(),
  ].filter((s): s is ConflictSignal => s !== null);

  // Sort by rank ascending (rank 1 = highest priority)
  const signals = raw.sort((a, b) => a.rank - b.rank);
  const dominant = signals[0] ?? null;

  return {
    takenAt: Date.now(),
    signals,
    dominant,
    calmActive: signals.some((s) => s.principleId === 'calm_over_chaos' && s.severity === 'active'),
    mattersMostActive: signals.some((s) => s.principleId === 'what_matters_most'),
    doNotWasteActive: signals.some((s) => s.principleId === 'do_not_waste' && s.severity === 'active'),
  };
}

// ── Charter block ─────────────────────────────────────────────────────────────

/**
 * Build a concise charter block showing which principles are active right now.
 * Only emits active signals — omits watch-only signals to avoid noise.
 * Returns empty string when nothing is firing.
 */
export function buildConflictSignalsBlock(snapshot: ConflictSnapshot): string {
  const active = snapshot.signals.filter((s) => s.severity === 'active');
  if (active.length === 0) return '';

  const lines = active.map((s) => `  [P${s.rank} — ${s.principleTitle}] ${s.reason}`);

  return `## Active Principle Signals
These principles are directly relevant right now — apply them:
${lines.join('\n')}`;
}
