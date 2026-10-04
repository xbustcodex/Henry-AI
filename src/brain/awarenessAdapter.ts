/**
 * Lightweight adapter so backgroundBrain.ts can call buildSnapshot()
 * without a circular import through awarenessStore.ts → charter.ts.
 * Re-exports only the snapshot builder, not the Zustand store.
 */

import type { AwarenessSnapshot } from '../henry/awarenessStore';

function safeJSON<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}

export function buildSnapshot(): AwarenessSnapshot {
  const now = Date.now();
  const nowDate = new Date();

  const tasks = safeJSON<any[]>('henry:tasks', []);
  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'queued');
  const topTasks = pending.slice(0, 3).map((t) => t.title || t.content || '(task)');

  const reminders = safeJSON<any[]>('henry:reminders', []);
  const activeReminders = reminders.filter((r) => !r.done && !r.dismissed);
  const next24h = now + 24 * 60 * 60 * 1000;
  const upcomingReminders = activeReminders
    .filter((r) => { const t = r.dueAt ? new Date(r.dueAt).getTime() : 0; return t > now && t <= next24h; })
    .slice(0, 3)
    .map((r) => ({ title: r.title || r.content || '(reminder)', due: r.dueAt ? new Date(r.dueAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '' }));
  const overdueReminders = activeReminders
    .filter((r) => r.dueAt && new Date(r.dueAt).getTime() < now)
    .slice(0, 2)
    .map((r) => ({ title: r.title || r.content || '(reminder)', due: r.dueAt ? new Date(r.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '' }));

  const projects = safeJSON<any[]>('henry:rich_memory:projects', []);
  const activeProjects = projects.filter((p) => p.status === 'active').slice(0, 3).map((p) => ({ name: p.name || '(project)', status: p.status || 'active' }));
  const recentProjects = projects.filter((p) => p.updatedAt).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 2).map((p) => ({ name: p.name || '(project)', updatedAt: new Date(p.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }));

  const capturesRaw = safeJSON<any[]>('henry:captures_v1', []);
  const unrouted = capturesRaw.filter((c) => c.status === 'pending' || !c.status);
  const recentCaptures = unrouted.slice(0, 3).map((c) => ({ text: (c.text || '').slice(0, 80), category: c.category || 'general' }));

  const AMBIENT_BUCKETS = ['henry:ambient:memory', 'henry:ambient:workspace', 'henry:ambient:project', 'henry:ambient:tasks', 'henry:ambient:saved'] as const;
  const recentAmbientNotes: { text: string; dest: string }[] = [];
  for (const key of AMBIENT_BUCKETS) {
    const items = safeJSON<any[]>(key, []);
    if (items.length) {
      recentAmbientNotes.push({ text: (items[0].text || '').slice(0, 80), dest: key.replace('henry:ambient:', '') });
      if (recentAmbientNotes.length >= 3) break;
    }
  }

  let connectedServices: string[] = [];
  try {
    const cs = safeJSON<Record<string, any>>('henry:connections', {});
    connectedServices = Object.entries(cs).filter(([, v]) => v?.status === 'connected').map(([k]) => k);
  } catch { /* ignore */ }

  const todayKey = `henry:journal:${nowDate.toISOString().slice(0, 10)}`;
  const journalTodayExists = !!(typeof localStorage !== 'undefined' && localStorage.getItem(todayKey));

  const lists = safeJSON<any[]>('henry:lists', []);
  const pendingListCount = lists.filter((l) => !l.completed).length;

  return {
    takenAt: now,
    pendingTaskCount: pending.length,
    topTasks,
    upcomingReminders,
    overdueReminders,
    activeProjects,
    recentProjects,
    unroutedCaptureCount: unrouted.length,
    recentCaptures,
    connectedServices,
    recentAmbientNotes,
    journalTodayExists,
    pendingListCount,
  };
}
