/**
 * Henry AI — Momentum Engine
 *
 * Detects the user's current momentum state from real live mind data.
 * No tracking pixels, no fake signals — reads from the same localStorage
 * state every other Henry system uses.
 *
 * States:
 *   strong   — making clear progress; protect flow
 *   building — moving in the right direction; light encouragement ok
 *   stalling — friction is rising; one next step would help
 *   broken   — blocked; recovery path needed
 */

export type MomentumState = 'strong' | 'building' | 'stalling' | 'broken';

export interface MomentumSnapshot {
  state: MomentumState;
  reason: string;
  protect: boolean;         // if true: suppress low-value interruptions
  oneNextStep: string | null; // concrete next move, or null if state is strong
  signals: {
    pendingTasks: number;
    failedTasks: number;
    overdueReminders: number;
    expiredConnections: number;
    unroutedCaptures: number;
    activeProjects: number;
  };
}

function safeJSON<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}

const DISMISS_KEY = 'henry:momentum:broken_dismissed_until';

/**
 * Silence the 'broken' state for `hours` hours. The underlying signals
 * (failed tasks, expired connections) are still computed; the engine just
 * skips the broken-branch return until the dismissal expires. Useful when
 * the user has acknowledged the issue and doesn't want the panel nagging.
 */
export function dismissMomentumBroken(hours = 24): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + hours * 60 * 60 * 1000));
  } catch { /* localStorage may be unavailable in tests */ }
}

function isBrokenDismissed(now: number): boolean {
  try {
    const until = Number(localStorage.getItem(DISMISS_KEY) || '0');
    return until > now;
  } catch { return false; }
}

export function computeMomentum(): MomentumSnapshot {
  const now = Date.now();

  const tasks = safeJSON<any[]>('henry:tasks', []);
  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'queued');
  const failed = tasks.filter((t) => t.status === 'failed');
  const recentDone = tasks.filter((t) => {
    if (t.status !== 'done' && t.status !== 'complete') return false;
    const done = t.completedAt ? new Date(t.completedAt).getTime() : 0;
    return now - done < 2 * 60 * 60 * 1000; // completed in last 2h
  });

  const reminders = safeJSON<any[]>('henry:reminders', []);
  const overdue = reminders.filter((r) => !r.done && r.dueAt && new Date(r.dueAt).getTime() < now);

  const connections = safeJSON<Record<string, any>>('henry:connections', {});
  const expired = Object.entries(connections).filter(([, v]) => v?.status === 'expired');

  const captures = safeJSON<any[]>('henry:captures_v1', []);
  const unrouted = captures.filter((c) => c.status === 'pending' || !c.status);

  const projects = safeJSON<any[]>('henry:rich_memory:projects', []);
  const activeProjects = projects.filter((p) => p.status === 'active');

  const signals = {
    pendingTasks: pending.length,
    failedTasks: failed.length,
    overdueReminders: overdue.length,
    expiredConnections: expired.length,
    unroutedCaptures: unrouted.length,
    activeProjects: activeProjects.length,
  };

  // ── BROKEN: fundamental blockers ─────────────────────────────────────────
  // R3-Fix 5: skip broken-branch entirely while the user has dismissed it.
  // The dismissal expires after 24h (or whatever the dismiss call passed),
  // so chronic failures will resurface — but the panel won't nag every
  // session about the same set of stale failed tasks.
  if ((failed.length > 1 || expired.length > 1) && !isBrokenDismissed(now)) {
    const reason = failed.length > 1
      ? `${failed.length} tasks failed — something is blocking progress.`
      : `${expired.length} connections expired — integrations are not working.`;
    const service = expired[0]?.[0];
    return {
      state: 'broken',
      reason,
      protect: false,
      oneNextStep: failed.length > 1
        ? `Review the task queue — check what's failing and why.`
        : service ? `Reconnect ${service} to unblock Henry.` : 'Check the Integrations panel.',
      signals,
    };
  }

  // ── STALLING: friction is rising ─────────────────────────────────────────
  if (overdue.length > 1 || (pending.length > 5 && recentDone.length === 0)) {
    const topReminder = overdue[0];
    const topTask = pending[0];
    return {
      state: 'stalling',
      reason: overdue.length > 1
        ? `${overdue.length} reminders are overdue — commitments are slipping.`
        : `${pending.length} tasks queued with no recent completions — progress has stalled.`,
      protect: false,
      oneNextStep: topReminder
        ? `Address overdue reminder: "${topReminder.title || topReminder.content}"`
        : topTask
        ? `Move the top task forward: "${topTask.title || topTask.content}"`
        : 'Clear the oldest item in the queue first.',
      signals,
    };
  }

  // ── STRONG: recent wins, clear queue, moving ──────────────────────────────
  if (recentDone.length > 0 && pending.length <= 3 && overdue.length === 0) {
    const wins = recentDone.length;
    return {
      state: 'strong',
      reason: `${wins} task${wins > 1 ? 's' : ''} completed in the last 2 hours — momentum is good.`,
      protect: true,
      oneNextStep: pending[0]
        ? `Keep going: "${pending[0].title || pending[0].content}"`
        : null,
      signals,
    };
  }

  // ── BUILDING: work exists, moving in right direction ─────────────────────
  const topProject = activeProjects[0];
  const topTask = pending[0];
  return {
    state: 'building',
    reason: topTask
      ? `Active queue with ${pending.length} task${pending.length > 1 ? 's' : ''} — moving forward.`
      : topProject
      ? `Project "${topProject.name}" is active — push the next concrete step.`
      : 'Setup looks clean. Start on your first priority.',
    protect: pending.length <= 3,
    oneNextStep: topTask
      ? `Next: "${topTask.title || topTask.content}"`
      : topProject
      ? `Break "${topProject.name}" into a concrete task.`
      : null,
    signals,
  };
}
