/**
 * Henry Health — daily habits, logs, streaks, AI reflection.
 * Tracks: water, exercise, sleep, prayer, meds, custom habits.
 * Daily log: meals, symptoms, mood, weight, notes.
 */
import { useState, useEffect, useCallback } from 'react';
import { sendToHenry } from '../../actions/store/chatBridgeStore';
import { useStore } from '../../store';

const getApi = () => (window as any).henryAPI as any;

interface Habit { id: string; name: string; icon: string; color: string; target_per_day: number; }
interface HabitLog { habit_id: string; date: string; count: number; }
interface HealthLog { id: string; date: string; category: string; label?: string; value?: number; unit?: string; note?: string; }

const today = () => new Date().toISOString().slice(0, 10);
const last7 = () => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); };

const LOG_CATEGORIES = [
  { id: 'water',    icon: '💧', label: 'Water',    unit: 'oz',  placeholder: '16' },
  { id: 'exercise', icon: '🏃', label: 'Exercise', unit: 'min', placeholder: '30' },
  { id: 'sleep',    icon: '😴', label: 'Sleep',    unit: 'hrs', placeholder: '8' },
  { id: 'weight',   icon: '⚖',  label: 'Weight',   unit: 'lbs', placeholder: '170' },
  { id: 'mood',     icon: '😊', label: 'Mood',     unit: '/10', placeholder: '7' },
  { id: 'calories', icon: '🍽', label: 'Calories', unit: 'cal', placeholder: '500' },
  { id: 'steps',    icon: '👟', label: 'Steps',    unit: 'steps', placeholder: '3000' },
  { id: 'note',     icon: '📝', label: 'Note',     unit: '',    placeholder: 'How are you feeling?' },
];

const DEFAULT_HABITS = [
  { name: 'Water (8 cups)',   icon: '💧', color: '#3b82f6', target_per_day: 8 },
  { name: 'Exercise',         icon: '🏃', color: '#16a34a', target_per_day: 1 },
  { name: 'Prayer / Devotion',icon: '🙏', color: '#7c3aed', target_per_day: 1 },
  { name: 'Read',             icon: '📖', color: '#d97706', target_per_day: 1 },
  { name: 'Sleep 8hrs',       icon: '😴', color: '#0ea5e9', target_per_day: 1 },
];

export default function HealthPanel() {
  const { setCurrentView } = useStore();
  const [habits, setHabits] = useState<Habit[]>([]);
  const [habitLogs, setHabitLogs] = useState<HabitLog[]>([]);
  const [logs, setLogs] = useState<HealthLog[]>([]);
  const [weekLogs, setWeekLogs] = useState<HabitLog[]>([]);
  const [tab, setTab] = useState<'today'|'log'|'habits'|'trends'>('today');
  const [newHabit, setNewHabit] = useState({ name: '', icon: '✓', color: '#7c3aed', target: '1' });
  const [logEntry, setLogEntry] = useState({ category: 'water', value: '', note: '' });
  const [adding, setAdding] = useState(false);
  const [addingLog, setAddingLog] = useState(false);

  const load = useCallback(async () => {
    const [h, hl, dl, wl] = await Promise.all([
      getApi()?.healthHabitList().catch(() => []),
      getApi()?.healthHabitLogsForDate(today()).catch(() => []),
      getApi()?.healthLogsForDate(today()).catch(() => []),
      getApi()?.healthHabitLogsRange(last7(), today()).catch(() => []),
    ]);
    setHabits(h); setHabitLogs(hl); setLogs(dl); setWeekLogs(wl);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function setupDefaults() {
    for (const h of DEFAULT_HABITS) {
      await getApi()?.healthHabitSave(h).catch(() => {});
    }
    await load();
  }

  async function toggleHabit(habit: Habit) {
    const logged = habitLogs.find(l => l.habit_id === habit.id);
    if (logged && logged.count >= habit.target_per_day) {
      await getApi()?.healthHabitUnlog({ habit_id: habit.id, date: today() });
    } else {
      await getApi()?.healthHabitLog({ habit_id: habit.id, date: today() });
    }
    await load();
  }

  async function addHabit() {
    if (!newHabit.name.trim()) return;
    await getApi()?.healthHabitSave({ name: newHabit.name, icon: newHabit.icon, color: newHabit.color, target_per_day: parseInt(newHabit.target) || 1 });
    setNewHabit({ name: '', icon: '✓', color: '#7c3aed', target: '1' });
    setAdding(false);
    await load();
  }

  async function addLog() {
    if (!logEntry.value && logEntry.category !== 'note') return;
    if (logEntry.category === 'note' && !logEntry.note) return;
    const cat = LOG_CATEGORIES.find(c => c.id === logEntry.category)!;
    await getApi()?.healthLogSave({
      date: today(),
      category: logEntry.category,
      label: cat.label,
      value: logEntry.category !== 'note' ? parseFloat(logEntry.value) : undefined,
      unit: cat.unit || undefined,
      note: logEntry.note || undefined,
    });
    setLogEntry({ category: logEntry.category, value: '', note: '' });
    setAddingLog(false);
    await load();
  }

  async function deleteLog(id: string) {
    await getApi()?.healthLogDelete(id);
    await load();
  }

  function askHenry() {
    const completed = habits.filter(h => {
      const l = habitLogs.find(hl => hl.habit_id === h.id);
      return l && l.count >= h.target_per_day;
    }).map(h => h.name);
    const logSummary = logs.map(l => `${l.label || l.category}: ${l.value !== undefined ? l.value + (l.unit ? ' ' + l.unit : '') : l.note}`).join(', ');
    sendToHenry(`My health check-in for today (${today()}):
Habits completed: ${completed.join(', ') || 'none yet'}
Logged: ${logSummary || 'nothing yet'}
Habits remaining: ${habits.filter(h => !habitLogs.find(l => l.habit_id === h.id)).map(h => h.name).join(', ') || 'all done'}

Give me a brief health reflection and any suggestions.`);
    setCurrentView('chat');
  }

  // Streak calculation
  function getStreak(habitId: string): number {
    let streak = 0;
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const found = weekLogs.find(l => l.habit_id === habitId && l.date === dateStr);
      if (found) streak++;
      else if (i > 0) break;
    }
    return streak;
  }

  const completedToday = habits.filter(h => {
    const l = habitLogs.find(hl => hl.habit_id === h.id);
    return l && l.count >= h.target_per_day;
  }).length;

  const tabCls = (t: string) => `px-3 py-1.5 text-xs font-medium rounded-lg transition-all ` +
    (tab === t ? 'bg-henry-accent text-white' : 'text-henry-text-muted hover:text-henry-text hover:bg-henry-surface/60');

  const inp = "w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all";

  return (
    <div className="flex flex-col h-full bg-henry-bg overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-3 border-b border-henry-border/20 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-bold text-henry-text">Health</h1>
            <p className="text-xs text-henry-text-muted">
              {habits.length > 0
                ? `${completedToday}/${habits.length} habits done today`
                : new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={askHenry}
              className="text-xs px-3 py-1.5 rounded-xl bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-accent transition-all">
              Reflect with Henry
            </button>
          </div>
        </div>

        {/* Progress bar */}
        {habits.length > 0 && (
          <div className="w-full bg-henry-surface rounded-full h-1.5 mb-3">
            <div className="bg-henry-accent h-1.5 rounded-full transition-all"
              style={{ width: `${Math.round((completedToday / habits.length) * 100)}%` }} />
          </div>
        )}

        <div className="flex gap-1">
          {(['today', 'log', 'habits', 'trends'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={tabCls(t)}>
              {t === 'today' ? '✓ Habits' : t === 'log' ? '📋 Log' : t === 'habits' ? '⚙ Manage' : '📈 Week'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">

        {/* ── TODAY HABITS ── */}
        {tab === 'today' && (
          <>
            {habits.length === 0 ? (
              <div className="text-center py-10 space-y-3">
                <p className="text-4xl">🌱</p>
                <p className="text-henry-text-muted text-sm">No habits set up yet.</p>
                <button onClick={setupDefaults}
                  className="text-sm px-5 py-2.5 rounded-xl bg-henry-accent text-white font-semibold hover:bg-henry-accent/80 transition-all">
                  Start with defaults
                </button>
                <p className="text-xs text-henry-text-muted">Water · Exercise · Prayer · Read · Sleep</p>
              </div>
            ) : (
              habits.map(habit => {
                const log = habitLogs.find(l => l.habit_id === habit.id);
                const done = (log?.count || 0) >= habit.target_per_day;
                const pct = Math.min(1, (log?.count || 0) / habit.target_per_day);
                const streak = getStreak(habit.id);
                return (
                  <button key={habit.id} onClick={() => void toggleHabit(habit)}
                    className={`w-full text-left rounded-2xl border p-4 transition-all ${
                      done ? 'border-green-400/30 bg-green-400/5' : 'border-henry-border/20 bg-henry-surface/40 hover:border-henry-accent/30'
                    }`}>
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0 border-2 transition-all ${
                        done ? 'border-green-400/60 bg-green-400/10' : 'border-henry-border/40'
                      }`} style={{ borderColor: done ? undefined : habit.color + '40' }}>
                        {done ? '✓' : habit.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-semibold ${done ? 'text-green-400' : 'text-henry-text'}`}>{habit.name}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex-1 bg-henry-surface rounded-full h-1">
                            <div className="h-1 rounded-full transition-all"
                              style={{ width: `${pct * 100}%`, backgroundColor: done ? '#4ade80' : habit.color }} />
                          </div>
                          <span className="text-[10px] text-henry-text-muted flex-shrink-0">
                            {log?.count || 0}/{habit.target_per_day}
                          </span>
                        </div>
                      </div>
                      {streak > 1 && (
                        <div className="text-right flex-shrink-0">
                          <p className="text-xs font-bold text-henry-accent">🔥 {streak}</p>
                          <p className="text-[9px] text-henry-text-muted">day streak</p>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </>
        )}

        {/* ── LOG ── */}
        {tab === 'log' && (
          <>
            <button onClick={() => setAddingLog(a => !a)}
              className="w-full py-2.5 rounded-xl bg-henry-accent text-white font-semibold text-sm hover:bg-henry-accent/80 transition-all">
              + Add Entry
            </button>

            {addingLog && (
              <div className="bg-henry-surface rounded-xl border border-henry-border/20 p-4 space-y-3">
                <div className="grid grid-cols-3 gap-1.5">
                  {LOG_CATEGORIES.map(cat => (
                    <button key={cat.id} onClick={() => setLogEntry(l => ({ ...l, category: cat.id, value: '' }))}
                      className={`py-2 rounded-xl text-xs font-medium border transition-all ${
                        logEntry.category === cat.id ? 'bg-henry-accent text-white border-transparent' : 'border-henry-border/30 text-henry-text-muted hover:text-henry-text'
                      }`}>
                      {cat.icon} {cat.label}
                    </button>
                  ))}
                </div>
                {logEntry.category !== 'note' ? (
                  <div className="flex gap-2 items-center">
                    <input type="number" value={logEntry.value} onChange={e => setLogEntry(l => ({ ...l, value: e.target.value }))}
                      placeholder={LOG_CATEGORIES.find(c => c.id === logEntry.category)?.placeholder}
                      className={inp + ' flex-1'} autoFocus />
                    <span className="text-sm text-henry-text-muted">
                      {LOG_CATEGORIES.find(c => c.id === logEntry.category)?.unit}
                    </span>
                  </div>
                ) : (
                  <textarea value={logEntry.note} onChange={e => setLogEntry(l => ({ ...l, note: e.target.value }))}
                    placeholder="How are you feeling today?" rows={3} className={inp + ' resize-none'} autoFocus />
                )}
                <input value={logEntry.note} onChange={e => setLogEntry(l => ({ ...l, note: e.target.value }))}
                  placeholder={logEntry.category !== 'note' ? 'Note (optional)' : ''}
                  className={logEntry.category === 'note' ? 'hidden' : inp} />
                <div className="flex gap-2">
                  <button onClick={addLog}
                    className="flex-1 py-2 rounded-xl bg-henry-accent text-white text-sm font-semibold hover:bg-henry-accent/80 transition-all">
                    Save
                  </button>
                  <button onClick={() => setAddingLog(false)}
                    className="px-4 py-2 rounded-xl border border-henry-border/30 text-henry-text-muted text-sm">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {logs.length === 0 && !addingLog && (
              <p className="text-center text-henry-text-muted text-sm py-8">Nothing logged today yet.</p>
            )}
            {logs.map(log => (
              <div key={log.id} className="flex items-center justify-between p-3 rounded-xl bg-henry-surface/40 border border-henry-border/10 group">
                <div className="flex items-center gap-3">
                  <span className="text-lg">{LOG_CATEGORIES.find(c => c.id === log.category)?.icon || '📋'}</span>
                  <div>
                    <p className="text-sm font-medium text-henry-text">{log.label || log.category}</p>
                    <p className="text-xs text-henry-text-muted">
                      {log.value !== undefined ? `${log.value}${log.unit ? ' ' + log.unit : ''}` : ''}{log.note ? (log.value !== undefined ? ' · ' : '') + log.note : ''}
                    </p>
                  </div>
                </div>
                <button onClick={() => void deleteLog(log.id)}
                  className="text-henry-text-muted/0 group-hover:text-henry-text-muted hover:text-red-400 transition-all text-xs">✕</button>
              </div>
            ))}
          </>
        )}

        {/* ── MANAGE HABITS ── */}
        {tab === 'habits' && (
          <>
            <button onClick={() => setAdding(a => !a)}
              className="w-full py-2.5 rounded-xl bg-henry-accent text-white font-semibold text-sm hover:bg-henry-accent/80 transition-all">
              + New Habit
            </button>

            {adding && (
              <div className="bg-henry-surface rounded-xl border border-henry-border/20 p-4 space-y-3">
                <div className="flex gap-2">
                  <input value={newHabit.icon} onChange={e => setNewHabit(h => ({ ...h, icon: e.target.value }))}
                    className={inp + ' w-16 text-center text-xl'} maxLength={2} placeholder="✓" />
                  <input value={newHabit.name} onChange={e => setNewHabit(h => ({ ...h, name: e.target.value }))}
                    placeholder="Habit name" className={inp + ' flex-1'} autoFocus />
                </div>
                <div className="flex gap-2 items-center">
                  <label className="text-xs text-henry-text-muted">Daily target:</label>
                  <input type="number" value={newHabit.target} onChange={e => setNewHabit(h => ({ ...h, target: e.target.value }))}
                    className={inp + ' w-20'} min="1" max="20" />
                  <label className="text-xs text-henry-text-muted">Color:</label>
                  <input type="color" value={newHabit.color} onChange={e => setNewHabit(h => ({ ...h, color: e.target.value }))}
                    className="h-8 w-12 rounded-lg cursor-pointer bg-transparent border-0" />
                </div>
                <div className="flex gap-2">
                  <button onClick={addHabit} className="flex-1 py-2 rounded-xl bg-henry-accent text-white text-sm font-semibold">Add</button>
                  <button onClick={() => setAdding(false)} className="px-4 py-2 rounded-xl border border-henry-border/30 text-henry-text-muted text-sm">Cancel</button>
                </div>
              </div>
            )}

            {habits.map(h => (
              <div key={h.id} className="flex items-center justify-between p-3 rounded-xl bg-henry-surface/40 border border-henry-border/10">
                <div className="flex items-center gap-3">
                  <span className="text-xl">{h.icon}</span>
                  <div>
                    <p className="text-sm font-medium text-henry-text">{h.name}</p>
                    <p className="text-xs text-henry-text-muted">Target: {h.target_per_day}x per day</p>
                  </div>
                </div>
                <button onClick={async () => { await getApi()?.healthHabitDelete(h.id); await load(); }}
                  className="text-henry-text-muted hover:text-red-400 transition-all text-xs px-2">Remove</button>
              </div>
            ))}

            {habits.length === 0 && !adding && (
              <button onClick={setupDefaults}
                className="w-full py-3 rounded-xl border border-henry-border/30 text-henry-text-muted text-sm hover:border-henry-accent/40 hover:text-henry-accent transition-all">
                Load default habits (Water, Exercise, Prayer, Read, Sleep)
              </button>
            )}
          </>
        )}

        {/* ── WEEK TRENDS ── */}
        {tab === 'trends' && (
          <div className="space-y-4">
            {/* Weight trend if logged */}
            {/* Weight / mood mini sparkline from health logs */}
            {logs.filter(l => l.category === 'weight' && l.value).length >= 2 && (() => {
              const pts = logs.filter(l => l.category === 'weight' && l.value).slice(0, 7).reverse();
              const vals = pts.map(p => p.value!);
              const min = Math.min(...vals) - 1;
              const max = Math.max(...vals) + 1;
              const W = 280, H = 60;
              const x = (i: number) => (i / (pts.length - 1)) * W;
              const y = (v: number) => H - ((v - min) / (max - min)) * H;
              const pathD = pts.map((p, i) => `${i===0?'M':'L'}${x(i)},${y(p.value!)}`).join(' ');
              return (
                <div className="p-4 rounded-xl bg-henry-surface/40 border border-henry-border/10">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2"><span>⚖</span><span className="text-sm font-medium text-henry-text">Weight trend</span></div>
                    <span className="text-sm font-bold text-henry-accent">{vals[vals.length-1]} lbs</span>
                  </div>
                  <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
                    <polyline points={pts.map((p,i) => `${x(i)},${y(p.value!)}`).join(' ')} fill="none" stroke="var(--color-accent,#7c3aed)" strokeWidth="2" strokeLinejoin="round" />
                    {pts.map((p,i) => <circle key={i} cx={x(i)} cy={y(p.value!)} r="3" fill="var(--color-accent,#7c3aed)" />)}
                  </svg>
                  <div className="flex justify-between mt-1">
                    {pts.map((p,i) => <span key={i} className="text-[9px] text-henry-text-muted">{p.date?.slice(5)}</span>)}
                  </div>
                </div>
              );
            })()}
            <p className="text-xs text-henry-text-muted">Last 7 days completion</p>
            {habits.map(habit => {
              const days = Array.from({ length: 7 }, (_, i) => {
                const d = new Date();
                d.setDate(d.getDate() - (6 - i));
                const dateStr = d.toISOString().slice(0, 10);
                const log = weekLogs.find(l => l.habit_id === habit.id && l.date === dateStr);
                return { date: dateStr, done: log ? log.count >= habit.target_per_day : false, day: d.toLocaleDateString('en-US', { weekday: 'narrow' }) };
              });
              const streak = getStreak(habit.id);
              const rate = days.filter(d => d.done).length;
              return (
                <div key={habit.id} className="p-4 rounded-xl bg-henry-surface/40 border border-henry-border/10">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span>{habit.icon}</span>
                      <span className="text-sm font-medium text-henry-text">{habit.name}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-henry-text-muted">{rate}/7 days</span>
                      {streak > 1 && <span className="text-henry-accent font-bold">🔥 {streak}</span>}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    {days.map(d => (
                      <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                        <div className={`w-full h-6 rounded-md transition-all ${d.done ? 'bg-green-400/70' : 'bg-henry-surface border border-henry-border/20'}`} />
                        <span className="text-[9px] text-henry-text-muted">{d.day}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
