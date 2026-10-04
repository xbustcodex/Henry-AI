export type ReminderCategory = 'personal' | 'work' | 'household' | 'health' | 'maker';
export type ReminderRepeat = 'none' | 'daily' | 'weekly' | 'monthly';

export interface Reminder {
  id: string;
  title: string;
  notes?: string;
  dueAt: string;
  repeat: ReminderRepeat;
  category: ReminderCategory;
  done: boolean;
  createdAt: string;
  notifiedAt?: string;
}

const KEY = 'henry:reminders';

export function loadReminders(): Reminder[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

// Sync from SQLite to localStorage (call on startup)
export async function syncFromDb(): Promise<void> {
  const api = (window as any).henryAPI;
  if (!api?.remindersList) return;
  try {
    const rows = await api.remindersList() as Array<{id:string;title:string;notes:string;due_at:string;repeat:string;done:number;notified_at:string}>;
    const reminders = rows.map(r => ({
      id: r.id, title: r.title, notes: (r.notes || undefined) as string | undefined,
      dueAt: r.due_at, repeat: (r.repeat || 'none') as 'none'|'daily'|'weekly'|'monthly',
      done: r.done === 1, notifiedAt: (r.notified_at || undefined) as string | undefined,
    })) as Reminder[];
    localStorage.setItem(KEY, JSON.stringify(reminders));
  } catch { /* ignore */ }
}

// Save to SQLite + localStorage
export async function saveReminderToDb(r: Reminder): Promise<void> {
  const api = (window as any).henryAPI;
  if (!api?.remindersSave) return;
  try { await api.remindersSave(r); } catch { /* ignore */ }
}

export async function deleteReminderFromDb(id: string): Promise<void> {
  const api = (window as any).henryAPI;
  if (!api?.remindersDelete) return;
  try { await api.remindersDelete(id); } catch { /* ignore */ }
}

function save(items: Reminder[]) {
  localStorage.setItem(KEY, JSON.stringify(items));
}

export function saveReminder(r: Reminder) {
  const all = loadReminders();
  const idx = all.findIndex((x) => x.id === r.id);
  if (idx >= 0) all[idx] = r; else all.unshift(r);
  save(all);
}

export function deleteReminder(id: string) {
  save(loadReminders().filter((r) => r.id !== id));
}

export function newReminder(): Reminder {
  const now = new Date();
  now.setHours(now.getHours() + 1, 0, 0, 0);
  return {
    id: `rem_${Date.now()}`,
    title: '',
    dueAt: now.toISOString().slice(0, 16),
    repeat: 'none',
    category: 'personal',
    done: false,
    createdAt: new Date().toISOString(),
  };
}

export function toggleDone(id: string) {
  const all = loadReminders();
  const r = all.find((x) => x.id === id);
  if (!r) return;

  if (!r.done && r.repeat !== 'none') {
    // Repeating reminder: checking it off advances to the next occurrence
    // instead of killing it. The reminder stays active and unread.
    const next = new Date(r.dueAt);
    if (r.repeat === 'daily') next.setDate(next.getDate() + 1);
    else if (r.repeat === 'weekly') next.setDate(next.getDate() + 7);
    else if (r.repeat === 'monthly') next.setMonth(next.getMonth() + 1);
    r.dueAt = next.toISOString().slice(0, 16);
    r.notifiedAt = undefined;
    // Leave r.done = false — repeat reminders never "die"
  } else {
    r.done = !r.done;
  }
  save(all);
}

/** Check for due reminders and fire browser notifications. Returns fired count. */
export function checkAndNotify(): number {
  if (!('Notification' in window)) return 0;
  const now = Date.now();
  const all = loadReminders();
  let fired = 0;
  let changed = false;
  for (const r of all) {
    if (r.done || r.notifiedAt) continue;
    const due = new Date(r.dueAt).getTime();
    if (now >= due) {
      // Try native Electron notification first (works in background), fallback to browser
      if ((window as any).henryAPI?.showNotification) {
        (window as any).henryAPI.showNotification({
          title: `Henry: ${r.title}`,
          body: r.notes || 'Reminder due',
        }).catch(() => {});
      } else if (Notification.permission === 'granted') {
        new Notification(`Henry: ${r.title}`, {
          body: r.notes || 'Reminder due',
          icon: '/favicon.ico',
          tag: r.id,
        });
      }
      r.notifiedAt = new Date().toISOString();
      if (r.repeat !== 'none') {
        const next = new Date(r.dueAt);
        if (r.repeat === 'daily') next.setDate(next.getDate() + 1);
        else if (r.repeat === 'weekly') next.setDate(next.getDate() + 7);
        else if (r.repeat === 'monthly') next.setMonth(next.getMonth() + 1);
        r.dueAt = next.toISOString().slice(0, 16);
        r.notifiedAt = undefined;
      }
      fired++;
      changed = true;
    }
  }
  if (changed) save(all);
  return fired;
}

export function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

export const CATEGORY_META: Record<ReminderCategory, { emoji: string; label: string }> = {
  personal: { emoji: '👤', label: 'Personal' },
  work: { emoji: '💼', label: 'Work' },
  household: { emoji: '🏠', label: 'Household' },
  health: { emoji: '💪', label: 'Health' },
  maker: { emoji: '🔧', label: 'Maker' },
};
