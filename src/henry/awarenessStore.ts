/**
 * Henry AI — Awareness System
 * Central awareness snapshot: what's going on in the user's world right now.
 * Reads from tasks, reminders, projects, captures, connected services, and notes.
 * Builds a context block injected into every Companion system prompt.
 */

import { create } from 'zustand';

export interface AwarenessSnapshot {
  takenAt: number;
  pendingTaskCount: number;
  topTasks: string[];
  upcomingReminders: { title: string; due: string }[];
  overdueReminders: { title: string; due: string }[];
  activeProjects: { name: string; status: string }[];
  recentProjects: { name: string; updatedAt: string }[];
  unroutedCaptureCount: number;
  recentCaptures: { text: string; category: string }[];
  connectedServices: string[];
  recentAmbientNotes: { text: string; dest: string }[];
  journalTodayExists: boolean;
  pendingListCount: number;
}

interface AwarenessState {
  snapshot: AwarenessSnapshot | null;
  refresh: () => void;
}

function safeJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function buildSnapshot(): AwarenessSnapshot {
  const now = Date.now();
  const nowDate = new Date();

  // --- Tasks ---
  const tasks = safeJSON<any[]>('henry:tasks', []);
  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'queued');
  const topTasks = pending.slice(0, 3).map((t) => t.title || t.content || '(task)');

  // --- Reminders ---
  const reminders = safeJSON<any[]>('henry:reminders', []);
  const activeReminders = reminders.filter((r) => !r.done && !r.dismissed);
  const next24h = nowDate.getTime() + 24 * 60 * 60 * 1000;
  const upcomingReminders = activeReminders
    .filter((r) => {
      const t = r.dueAt ? new Date(r.dueAt).getTime() : 0;
      return t > now && t <= next24h;
    })
    .slice(0, 3)
    .map((r) => ({
      title: r.title || r.content || '(reminder)',
      due: r.dueAt ? new Date(r.dueAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '',
    }));
  const overdueReminders = activeReminders
    .filter((r) => r.dueAt && new Date(r.dueAt).getTime() < now)
    .slice(0, 2)
    .map((r) => ({
      title: r.title || r.content || '(reminder)',
      due: r.dueAt ? new Date(r.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
    }));

  // --- Projects ---
  const projects = safeJSON<any[]>('henry:rich_memory:projects', []);
  const activeProjects = projects
    .filter((p) => p.status === 'active')
    .slice(0, 3)
    .map((p) => ({ name: p.name || '(project)', status: p.status || 'active' }));
  const recentProjects = projects
    .filter((p) => p.updatedAt)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 2)
    .map((p) => ({
      name: p.name || '(project)',
      updatedAt: new Date(p.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    }));

  // --- Captures ---
  const capturesRaw = safeJSON<any[]>('henry:captures_v1', []);
  const unrouted = capturesRaw.filter((c) => c.status === 'pending' || !c.status);
  const recentCaptures = unrouted.slice(0, 3).map((c) => ({
    text: (c.text || '').slice(0, 80),
    category: c.category || 'general',
  }));

  // --- Ambient notes (routed buckets) ---
  const AMBIENT_BUCKETS = ['henry:ambient:memory', 'henry:ambient:workspace', 'henry:ambient:project', 'henry:ambient:tasks', 'henry:ambient:saved'] as const;
  const recentAmbientNotes: { text: string; dest: string }[] = [];
  for (const key of AMBIENT_BUCKETS) {
    const items = safeJSON<any[]>(key, []);
    if (items.length) {
      const label = key.replace('henry:ambient:', '');
      recentAmbientNotes.push({ text: (items[0].text || '').slice(0, 80), dest: label });
      if (recentAmbientNotes.length >= 3) break;
    }
  }

  // --- Connected services ---
  let connectedServices: string[] = [];
  try {
    const cs = safeJSON<Record<string, any>>('henry:connections', {});
    connectedServices = Object.entries(cs)
      .filter(([, v]) => v?.status === 'connected')
      .map(([k]) => k);
  } catch { /* ignore */ }

  // --- Journal ---
  const todayKey = `henry:journal:${nowDate.toISOString().slice(0, 10)}`;
  const journalTodayExists = !!localStorage.getItem(todayKey);

  // --- Lists ---
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

export const useAwarenessStore = create<AwarenessState>((set) => ({
  snapshot: null,
  refresh: () => set({ snapshot: buildSnapshot() }),
}));

/** Called during system prompt construction — always reads fresh. */
export function buildAwarenessBlock(): string {
  const s = buildSnapshot();
  const lines: string[] = [];

  if (s.overdueReminders.length) {
    lines.push(`Overdue reminders: ${s.overdueReminders.map((r) => `"${r.title}" (was due ${r.due})`).join(', ')}.`);
  }
  if (s.upcomingReminders.length) {
    lines.push(`Coming up today: ${s.upcomingReminders.map((r) => `"${r.title}"${r.due ? ` at ${r.due}` : ''}`).join(', ')}.`);
  }
  if (s.pendingTaskCount > 0) {
    const taskList = s.topTasks.length ? ` (${s.topTasks.map((t) => `"${t}"`).join(', ')}${s.pendingTaskCount > s.topTasks.length ? `, +${s.pendingTaskCount - s.topTasks.length} more` : ''})` : '';
    lines.push(`Task queue: ${s.pendingTaskCount} pending${taskList}.`);
  }
  if (s.activeProjects.length) {
    lines.push(`Active projects: ${s.activeProjects.map((p) => `"${p.name}"`).join(', ')}.`);
  }
  if (s.unroutedCaptureCount > 0) {
    const notePreview = s.recentCaptures.length ? ` — most recent: "${s.recentCaptures[0].text}"` : '';
    lines.push(`${s.unroutedCaptureCount} captured note${s.unroutedCaptureCount !== 1 ? 's' : ''} waiting to be routed${notePreview}.`);
  }
  if (s.recentAmbientNotes.length) {
    lines.push(`Recent ambient notes: ${s.recentAmbientNotes.map((n) => `"${n.text}" (→ ${n.dest})`).join('; ')}.`);
  }
  if (s.connectedServices.length) {
    lines.push(`Connected: ${s.connectedServices.join(', ')}.`);
  }
  if (!s.journalTodayExists) {
    const hour = new Date().getHours();
    if (hour >= 19) lines.push(`No journal entry today — might be worth capturing something before the day ends.`);
  }

  if (!lines.length) return '';

  return `## What's going on right now
${lines.join('\n')}

Use this awareness naturally — don't recite it. When something connects to what they're asking, draw on it. When it doesn't, ignore it.`;
}
