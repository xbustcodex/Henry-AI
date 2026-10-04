/**
 * Henry AI — getFocusNow()
 *
 * Returns the single most important thing Henry knows is happening right now.
 * Grounded entirely in real live mind state: tasks, reminders, projects,
 * captures, and connection health. Never generates generic advice from scratch.
 *
 * Returns null if there is genuinely nothing notable to surface.
 */

function safeJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface FocusSignal {
  now: string;
  why: string;
  next: string;
  watch?: string;
}

export function getFocusNow(): FocusSignal | null {
  const now = Date.now();

  // ── Read live state ──────────────────────────────────────────────────────

  const tasks = safeJSON<any[]>('henry:tasks', []);
  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'queued');
  const topTask = pending[0] ?? null;
  const secondTask = pending[1] ?? null;

  const reminders = safeJSON<any[]>('henry:reminders', []);
  const activeReminders = reminders.filter((r) => !r.done && !r.dismissed);
  const overdueReminders = activeReminders.filter(
    (r) => r.dueAt && new Date(r.dueAt).getTime() < now,
  );
  const soonReminders = activeReminders.filter((r) => {
    if (!r.dueAt) return false;
    const t = new Date(r.dueAt).getTime();
    return t > now && t <= now + 2 * 60 * 60 * 1000; // within 2 hours
  });

  const projects = safeJSON<any[]>('henry:rich_memory:projects', []);
  const activeProjects = projects.filter((p) => p.status === 'active');
  const topProject = activeProjects[0] ?? null;

  const captures = safeJSON<any[]>('henry:captures_v1', []);
  const unrouted = captures.filter((c) => c.status === 'pending' || !c.status);

  const connections = safeJSON<Record<string, any>>('henry:connections', {});
  const expiredServices = Object.entries(connections)
    .filter(([, v]) => v?.status === 'expired')
    .map(([k]) => k);
  const missingKeyServices = Object.entries(connections)
    .filter(([, v]) => v?.status === 'disconnected' || !v?.status)
    .map(([k]) => k);

  // ── Priority order: overdue → soon → top task → project → captures ───────

  // 1. Overdue reminders — most urgent
  if (overdueReminders.length > 0) {
    const r = overdueReminders[0];
    const label = r.title || r.content || 'a reminder';
    const due = r.dueAt ? new Date(r.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    return {
      now: `Clear overdue: "${label}"`,
      why: due ? `Was due ${due} — still in the queue.` : 'This slipped past its due date.',
      next: secondTask
        ? `After that, move to "${secondTask.title || secondTask.content || 'next task'}"`
        : topTask
        ? `Then pick up "${topTask.title || topTask.content || 'next task'}"`
        : 'Clear the rest of the queue once this is done.',
      watch:
        overdueReminders.length > 1
          ? `${overdueReminders.length - 1} more overdue item${overdueReminders.length > 2 ? 's' : ''}.`
          : undefined,
    };
  }

  // 2. Reminders due within 2 hours
  if (soonReminders.length > 0) {
    const r = soonReminders[0];
    const label = r.title || r.content || 'a reminder';
    const due = r.dueAt
      ? new Date(r.dueAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : 'soon';
    return {
      now: `Reminder coming up: "${label}"`,
      why: `Due at ${due} — worth preparing now.`,
      next: topTask
        ? `Start "${topTask.title || topTask.content || 'next task'}" after.`
        : 'Handle this, then check the task queue.',
    };
  }

  // 3. Top pending task
  if (topTask) {
    const label = topTask.title || topTask.content || 'next task';
    const projectHint = topTask.project
      ? ` — part of "${topTask.project}"`
      : topProject
      ? ` — related to "${topProject.name}"`
      : '';
    return {
      now: label,
      why: `Next up in the task queue${projectHint}.`,
      next: secondTask
        ? `Follow with "${secondTask.title || secondTask.content || 'next task'}"`
        : topProject && topProject.name !== label
        ? `Keep pushing on "${topProject.name}" after.`
        : pending.length > 1
        ? `${pending.length - 1} more task${pending.length > 2 ? 's' : ''} in the queue.`
        : 'Nothing else queued — good time to capture what comes next.',
      watch:
        unrouted.length > 3
          ? `${unrouted.length} captured notes still waiting to be routed.`
          : expiredServices.length > 0
          ? `${expiredServices.join(', ')} connection${expiredServices.length > 1 ? 's' : ''} expired — reconnect when you get a moment.`
          : undefined,
    };
  }

  // 4. Active project with no tasks
  if (topProject) {
    return {
      now: `Push on "${topProject.name}"`,
      why: 'Active project with no tasks queued yet.',
      next: 'Break the next step into a concrete task so it gets done.',
      watch:
        expiredServices.length > 0
          ? `${expiredServices.join(', ')} connection${expiredServices.length > 1 ? 's' : ''} expired.`
          : unrouted.length > 0
          ? `${unrouted.length} captured note${unrouted.length > 1 ? 's' : ''} not yet routed.`
          : undefined,
    };
  }

  // 5. Unrouted captures
  if (unrouted.length > 0) {
    return {
      now: `Route ${unrouted.length} captured note${unrouted.length > 1 ? 's' : ''}`,
      why: 'Captures are sitting unprocessed — move them before they get stale.',
      next: 'Go to Captures, scan each one, and route or dismiss.',
      watch:
        expiredServices.length > 0
          ? `${expiredServices.join(', ')} connection expired — reconnect when you get a moment.`
          : undefined,
    };
  }

  // 6. Expired connections — soft nudge
  if (expiredServices.length > 0) {
    return {
      now: `Reconnect ${expiredServices.join(', ')}`,
      why: `Connection${expiredServices.length > 1 ? 's' : ''} expired — Henry can't read ${expiredServices.join(' or ')} right now.`,
      next: "Open the panel, hit Reconnect, and you're back.",
    };
  }

  // 7. Nothing notable
  // Return null — let the UI stay clean
  void missingKeyServices; // available for future use
  return null;
}
