/**
 * Henry Insight Generator — produces quick 1-2 sentence insights
 * from live data state without making an AI call.
 * Used for proactive UI hints and PresenceBar tips.
 */

function safeGet<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}

export interface HenryInsight {
  text: string;
  type: 'warning' | 'suggestion' | 'info' | 'celebration';
  icon: string;
  action?: { label: string; view: string };
}

export function getQuickInsight(): HenryInsight | null {
  const now = Date.now();
  const ownerName = localStorage.getItem('henry:owner_name')?.trim() || null;

  // 1. Overdue reminders — highest urgency
  const reminders = safeGet<any[]>('henry:reminders', []);
  const overdue = reminders.filter(r =>
    !r.done && r.dueAt && new Date(r.dueAt).getTime() < now
  );
  if (overdue.length > 0) {
    const label = overdue[0].title || overdue[0].text || 'a reminder';
    return {
      text: `"${label}" is overdue${overdue.length > 1 ? ` (+${overdue.length - 1} more)` : ''}.`,
      type: 'warning',
      icon: '⏰',
      action: { label: 'View', view: 'reminders' },
    };
  }

  // 2. Pending tasks
  const tasks = safeGet<any[]>('henry:tasks', []);
  const pending = tasks.filter(t => t.status === 'pending' || t.status === 'queued');
  if (pending.length >= 3) {
    return {
      text: `${pending.length} tasks waiting in the queue.`,
      type: 'info',
      icon: '⚙️',
      action: { label: 'View queue', view: 'tasks' },
    };
  }

  // 3. Unrouted captures
  const captures = safeGet<any[]>('henry:captures_v1', []);
  const unrouted = captures.filter((c: any) => c.status === 'pending' || !c.routed);
  if (unrouted.length >= 2) {
    return {
      text: `${unrouted.length} captures need routing.`,
      type: 'suggestion',
      icon: '🎙',
      action: { label: 'Review', view: 'captures' },
    };
  }

  // 4. Daily intention set — positive reinforcement
  const intention = localStorage.getItem('henry:daily_intention');
  const intentionDate = localStorage.getItem('henry:daily_intention_date');
  const todayStr = new Date().toISOString().slice(0, 10);
  if (intention && intentionDate === todayStr) {
    const hour = new Date().getHours();
    if (hour >= 14 && hour <= 17) {
      return {
        text: `Midday check: "${intention}"`,
        type: 'info',
        icon: '🎯',
      };
    }
  }

  // 5. Active project count
  const projects = safeGet<any[]>('henry:rich_memory:projects', []);
  const activeProjects = projects.filter(p => p.status === 'active');
  if (activeProjects.length > 0) {
    const top = activeProjects[0];
    return {
      text: `${activeProjects.length} active project${activeProjects.length > 1 ? 's' : ''}. "${top.name || 'Untitled'}" is current.`,
      type: 'info',
      icon: '🚀',
      action: { label: 'Weekly review', view: 'weekly' },
    };
  }

  return null;
}
