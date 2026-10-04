import { useEffect, useState, useCallback } from 'react';
import {
  loadReminders, saveReminder, deleteReminder, toggleDone, newReminder, checkAndNotify, requestNotificationPermission, saveReminderToDb, deleteReminderFromDb,
  CATEGORY_META, type Reminder, type ReminderCategory, type ReminderRepeat,
} from '../../henry/reminders';
import { useStore } from '../../store';
import { PANEL_QUICK_ASK } from '../../henry/henryQuickAsk';

const REPEAT_OPTS: { value: ReminderRepeat; label: string }[] = [
  { value: 'none', label: 'Once' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

function formatDue(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const todayStr = now.toDateString();
  const dStr = d.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (dStr === todayStr) return `Today at ${time}`;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (dStr === tomorrow.toDateString()) return `Tomorrow at ${time}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (dStr === yesterday.toDateString()) return `Yesterday at ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` at ${time}`;
}

function isOverdue(r: Reminder): boolean {
  return !r.done && new Date(r.dueAt) < new Date();
}

export default function RemindersPanel() {
  const { setCurrentView } = useStore();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'done'>('pending');
  const [notifPermission, setNotifPermission] = useState<string>('default');

  const reload = useCallback(() => setReminders(loadReminders()), []);

  useEffect(() => {
    reload();
    if ('Notification' in window) setNotifPermission(Notification.permission);
    const interval = setInterval(() => { checkAndNotify(); reload(); }, 30_000);
    return () => clearInterval(interval);
  }, [reload]);

  function handleToggle(id: string) {
    toggleDone(id);
    const updatedAll = loadReminders();
    const updated = updatedAll.find(r => r.id === id);
    if (updated) void saveReminderToDb(updated).catch(() => {});
    reload();
  }

  function handleDelete(id: string) {
    deleteReminder(id);
    void deleteReminderFromDb(id).catch(() => {});
    if (editing?.id === id) setEditing(null);
    reload();
  }

  function handleSave() {
    if (!editing || !editing.title.trim()) return;
    saveReminder(editing);
    void saveReminderToDb(editing).catch(() => {});
    setEditing(null);
    reload();
  }

  function handleNew() {
    setEditing(newReminder());
  }

  function askPermission() {
    requestNotificationPermission();
    setTimeout(() => {
      if ('Notification' in window) setNotifPermission(Notification.permission);
    }, 500);
  }

  const filtered = reminders.filter((r) => {
    if (filter === 'pending') return !r.done;
    if (filter === 'done') return r.done;
    return true;
  });

  const overdue = filtered.filter(isOverdue);
  const upcoming = filtered.filter((r) => !isOverdue(r));

  return (
    <div className="flex h-full bg-henry-bg">
      {/* Main list */}
      <div className={`flex flex-col flex-1 min-h-0 ${editing ? 'hidden md:flex' : 'flex'}`}>
        {/* Header */}
        <div className="p-6 border-b border-henry-border/30">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-semibold text-henry-text">Reminders</h1>
              <p className="text-xs text-henry-text-muted mt-0.5">
                {reminders.filter((r) => !r.done).length} pending
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => PANEL_QUICK_ASK.reminders()}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all"
              >🧠 Ask Henry</button>
              {notifPermission !== 'granted' && (
                <button
                  onClick={askPermission}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-lg hover:bg-amber-500/20 transition-colors"
                >
                  🔔 Enable Notifications
                </button>
              )}
              <button
                onClick={handleNew}
                className="flex items-center gap-2 px-4 py-2 bg-henry-accent text-henry-bg rounded-xl text-xs font-semibold hover:bg-henry-accent/90 transition-colors"
              >
                + New
              </button>
            </div>
          </div>
          {/* Filter tabs */}
          <div className="flex gap-1">
            {(['pending', 'all', 'done'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                  filter === f ? 'bg-henry-accent/15 text-henry-accent' : 'text-henry-text-muted hover:text-henry-text'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {overdue.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold text-henry-error uppercase tracking-wider">Overdue</span>
                <div className="flex-1 h-px bg-henry-error/20" />
              </div>
              <div className="space-y-2">
                {overdue.map((r) => <ReminderCard key={r.id} reminder={r} onToggle={handleToggle} onEdit={setEditing} onDelete={handleDelete}
                onSnooze={(updated: Reminder) => { saveReminderToDb(updated); reload(); }} />)}
              </div>
            </div>
          )}
          {upcoming.length > 0 && (
            <div>
              {overdue.length > 0 && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-semibold text-henry-text-muted uppercase tracking-wider">Upcoming</span>
                  <div className="flex-1 h-px bg-henry-border/30" />
                </div>
              )}
              <div className="space-y-2">
                {upcoming.map((r) => <ReminderCard key={r.id} reminder={r} onToggle={handleToggle} onEdit={setEditing} onDelete={handleDelete}
                onSnooze={(updated: Reminder) => { saveReminderToDb(updated); reload(); }} />)}
              </div>
            </div>
          )}
          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center h-40 text-henry-text-dim">
              <span className="text-3xl mb-2">🔔</span>
              <p className="text-sm">No {filter === 'done' ? 'completed' : 'pending'} reminders</p>
              {filter === 'pending' && (
                <button onClick={handleNew} className="mt-3 text-henry-accent text-xs hover:underline">Add one</button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Edit panel */}
      {editing && (
        <div className="w-full md:w-80 border-l border-henry-border/30 bg-henry-surface/50 flex flex-col">
          <div className="p-4 border-b border-henry-border/30 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-henry-text">{editing.id && reminders.some((r) => r.id === editing.id) ? 'Edit' : 'New'} Reminder</h2>
            <button onClick={() => setEditing(null)} className="text-henry-text-dim hover:text-henry-text transition-colors text-lg leading-none">×</button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="block text-xs text-henry-text-muted mb-1">Title *</label>
              <input
                autoFocus
                value={editing.title}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
                placeholder="What do you need to remember?"
                className="w-full bg-henry-bg border border-henry-border/50 rounded-lg px-3 py-2 text-sm text-henry-text placeholder-henry-text-dim focus:outline-none focus:border-henry-accent/50"
              />
            </div>
            <div>
              <label className="block text-xs text-henry-text-muted mb-1">Notes</label>
              <textarea
                value={editing.notes || ''}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                rows={3}
                placeholder="Any extra details..."
                className="w-full bg-henry-bg border border-henry-border/50 rounded-lg px-3 py-2 text-sm text-henry-text placeholder-henry-text-dim focus:outline-none focus:border-henry-accent/50 resize-none"
              />
            </div>
            <div>
              <label className="block text-xs text-henry-text-muted mb-1">Due</label>
              <input
                type="datetime-local"
                value={editing.dueAt}
                onChange={(e) => setEditing({ ...editing, dueAt: e.target.value })}
                className="w-full bg-henry-bg border border-henry-border/50 rounded-lg px-3 py-2 text-sm text-henry-text focus:outline-none focus:border-henry-accent/50"
              />
            </div>
            <div>
              <label className="block text-xs text-henry-text-muted mb-1">Category</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(Object.keys(CATEGORY_META) as ReminderCategory[]).map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setEditing({ ...editing, category: cat })}
                    className={`flex flex-col items-center gap-0.5 py-2 rounded-lg text-xs transition-colors border ${
                      editing.category === cat ? 'bg-henry-accent/15 border-henry-accent/40 text-henry-accent' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'
                    }`}
                  >
                    <span>{CATEGORY_META[cat].emoji}</span>
                    <span className="text-[10px]">{CATEGORY_META[cat].label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-henry-text-muted mb-1">Repeat</label>
              <div className="grid grid-cols-2 gap-1.5">
                {REPEAT_OPTS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => setEditing({ ...editing, repeat: o.value })}
                    className={`py-2 rounded-lg text-xs transition-colors border ${
                      editing.repeat === o.value ? 'bg-henry-accent/15 border-henry-accent/40 text-henry-accent' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="p-4 border-t border-henry-border/30 flex gap-2">
            <button onClick={handleSave} disabled={!editing.title.trim()} className="flex-1 py-2.5 bg-henry-accent text-henry-bg rounded-xl text-sm font-semibold hover:bg-henry-accent/90 transition-colors disabled:opacity-40">
              Save
            </button>
            {reminders.some((r) => r.id === editing.id) && (
              <button onClick={() => handleDelete(editing.id)} className="px-3 py-2.5 text-henry-error hover:bg-henry-error/10 rounded-xl transition-colors text-sm">
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReminderCard({ reminder: r, onToggle, onEdit, onDelete, onSnooze }: {
  reminder: Reminder;
  onToggle: (id: string) => void;
  onEdit: (r: Reminder) => void;
  onDelete: (id: string) => void;
  onSnooze?: (r: Reminder) => void;
}) {
  const overdue = isOverdue(r);
  const meta = CATEGORY_META[r.category];
  return (
    <div className={`group flex items-start gap-3 p-3 rounded-xl border transition-all ${
      r.done ? 'border-henry-border/20 bg-henry-surface/20 opacity-50' :
      overdue ? 'border-henry-error/30 bg-henry-error/5' : 'border-henry-border/30 bg-henry-surface/40 hover:border-henry-border/60'
    }`}>
      <button
        onClick={() => onToggle(r.id)}
        className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
          r.done ? 'border-henry-accent bg-henry-accent' : overdue ? 'border-henry-error hover:bg-henry-error/20' : 'border-henry-border hover:border-henry-accent'
        }`}
      >
        {r.done && <span className="text-henry-bg text-[10px] font-bold">✓</span>}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${r.done ? 'line-through text-henry-text-dim' : 'text-henry-text'}`}>{r.title}</p>
        {r.notes && <p className="text-xs text-henry-text-muted mt-0.5 truncate">{r.notes}</p>}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-henry-text-dim">{meta.emoji} {meta.label}</span>
          <span className={`text-[10px] ${overdue && !r.done ? 'text-henry-error font-medium' : 'text-henry-text-dim'}`}>{formatDue(r.dueAt)}</span>
          {r.repeat !== 'none' && <span className="text-[10px] text-henry-text-dim">↻ {r.repeat}</span>}
        </div>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={() => onEdit(r)} className="p-1 text-henry-text-dim hover:text-henry-text rounded">✏️</button>
        <button onClick={() => onDelete(r.id)} className="p-1 text-henry-text-dim hover:text-henry-error rounded">✕</button>
      </div>
    </div>
  );
}
