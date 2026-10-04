/**
 * Maintenance Panel — service log for every machine.
 *
 * Tracks: inspections, calibrations, repairs, part replacements, cleanings.
 * Per-machine timeline so you can spot patterns ("this printer needed
 * a new hotend every 2 months").
 *
 * Backed by SQLite via maker:maintenance:* IPC. Each save updates the
 * machine's last_maintenance_at automatically.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { sendToHenry } from '../../actions/store/chatBridgeStore';
import { useStore } from '../../store';

type MaintenanceType =
  | 'inspection' | 'calibration' | 'cleaning' | 'lubrication'
  | 'part-replacement' | 'repair' | 'firmware-update' | 'other';

interface Machine {
  id: string;
  name: string;
  machine_type: string;
  status: string;
  last_maintenance_at?: string;
  next_maintenance_at?: string;
}

interface MaintenanceEntry {
  id: string;
  machine_id: string;
  type: MaintenanceType;
  description: string;
  cost: number;
  duration_minutes?: number;
  parts_used?: string;
  next_due_at?: string;
  created_at: string;
}

const TYPE_META: { id: MaintenanceType; label: string; icon: string; color: string }[] = [
  { id: 'inspection',       label: 'Inspection',       icon: '◎', color: 'text-sky-400 bg-sky-400/10' },
  { id: 'calibration',      label: 'Calibration',      icon: '⊕', color: 'text-violet-400 bg-violet-400/10' },
  { id: 'cleaning',         label: 'Cleaning',         icon: '◌', color: 'text-emerald-400 bg-emerald-400/10' },
  { id: 'lubrication',      label: 'Lubrication',      icon: '◐', color: 'text-amber-400 bg-amber-400/10' },
  { id: 'part-replacement', label: 'Part replacement', icon: '⊞', color: 'text-orange-400 bg-orange-400/10' },
  { id: 'repair',           label: 'Repair',           icon: '✕', color: 'text-rose-400 bg-rose-400/10' },
  { id: 'firmware-update',  label: 'Firmware update',  icon: '⚡', color: 'text-cyan-400 bg-cyan-400/10' },
  { id: 'other',            label: 'Other',            icon: '·', color: 'text-henry-text-muted bg-henry-surface' },
];

const inputCls = 'w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all';

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1.5 block">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-henry-text-muted/70 mt-1">{hint}</p>}
    </div>
  );
}

function typeMeta(t: string) {
  return TYPE_META.find(x => x.id === t) || TYPE_META[TYPE_META.length - 1];
}

function newEntry(machineId = ''): MaintenanceEntry {
  return {
    id: `maint_${Date.now()}`,
    machine_id: machineId,
    type: 'inspection',
    description: '',
    cost: 0,
    duration_minutes: undefined,
    created_at: new Date().toISOString(),
  };
}

function fmtMoney(n: number): string {
  if (!n) return '$0';
  return `$${n.toFixed(2)}`;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso.slice(0, 10); }
}

function daysSince(iso?: string): number | null {
  if (!iso) return null;
  try {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  } catch { return null; }
}

function daysUntil(iso?: string): number | null {
  if (!iso) return null;
  try {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.floor((t - Date.now()) / 86400000);
  } catch { return null; }
}

export default function MaintenancePanel() {
  const setCurrentView = useStore((s) => s.setCurrentView);
  const [entries, setEntries] = useState<MaintenanceEntry[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [editing, setEditing] = useState<MaintenanceEntry | null>(null);
  const [machineFilter, setMachineFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<MaintenanceType | ''>('');
  const [loading, setLoading] = useState(true);

  const api = (typeof window !== 'undefined' && (window as any).henryAPI) || null;

  const reload = useCallback(async () => {
    if (!api?.makerMaintenanceList) { setLoading(false); return; }
    try {
      const [m, e] = await Promise.all([
        api.makerMachinesList({ activeOnly: true }),
        api.makerMaintenanceList(machineFilter || undefined),
      ]);
      setMachines(Array.isArray(m) ? m : []);
      setEntries(Array.isArray(e) ? e : []);
    } catch (err) { console.warn('[Maintenance] load failed', err); }
    finally { setLoading(false); }
  }, [api, machineFilter]);

  useEffect(() => { void reload(); }, [reload]);

  const machineName = (id?: string) => machines.find(m => m.id === id)?.name || '—';
  const machineById = (id?: string) => machines.find(m => m.id === id);

  const filtered = useMemo(() => {
    let list = entries;
    if (typeFilter) list = list.filter(e => e.type === typeFilter);
    return list;
  }, [entries, typeFilter]);

  // Status summary for each machine — when did it last get serviced, when's the next one due
  const machineStatusList = useMemo(() => {
    return machines.map(m => {
      const lastDays = daysSince(m.last_maintenance_at);
      const nextDays = daysUntil(m.next_maintenance_at);
      let urgency: 'overdue' | 'soon' | 'ok' | 'unknown' = 'unknown';
      if (nextDays != null) {
        urgency = nextDays < 0 ? 'overdue' : nextDays <= 7 ? 'soon' : 'ok';
      } else if (lastDays != null && lastDays > 90) {
        urgency = 'soon';
      } else if (m.last_maintenance_at) {
        urgency = 'ok';
      }
      return { machine: m, lastDays, nextDays, urgency };
    });
  }, [machines]);

  const overdueCount = machineStatusList.filter(s => s.urgency === 'overdue').length;
  const soonCount = machineStatusList.filter(s => s.urgency === 'soon').length;

  const save = async () => {
    if (!editing || !api?.makerMaintenanceSave) return;
    if (!editing.machine_id || !editing.description.trim()) return;
    await api.makerMaintenanceSave(editing);
    setEditing(null);
    await reload();
  };

  const remove = async (id: string) => {
    if (!api?.makerMaintenanceDelete) return;
    if (!confirm('Delete this maintenance entry?')) return;
    await api.makerMaintenanceDelete(id);
    await reload();
  };

  const askHenryAboutMachine = (machineId: string) => {
    const m = machineById(machineId);
    if (!m) return;
    const machineEntries = entries.filter(e => e.machine_id === machineId).slice(0, 10);
    const summary = machineEntries.map(e => `${fmtDate(e.created_at)}: ${typeMeta(e.type).label} — ${e.description}`).join('\n');
    sendToHenry(
      `Tell me about the maintenance pattern on my ${m.name} (${m.machine_type}). ` +
        `Recent entries:\n${summary || 'no entries yet'}\n\nWhat patterns do you see, and what should I do next?`
    );
    setCurrentView('chat');
  };

  return (
    <div className="flex flex-col h-full bg-henry-bg overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-3 border-b border-henry-border/20 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-henry-text">Maintenance</h1>
            <p className="text-[11px] text-henry-text-muted mt-0.5">
              {entries.length} entries · {machines.length} machines tracked
              {overdueCount > 0 && <span className="text-rose-400 font-semibold"> · {overdueCount} overdue</span>}
              {soonCount > 0 && <span className="text-amber-400"> · {soonCount} due soon</span>}
            </p>
          </div>
          <button onClick={() => setEditing(newEntry(machineFilter))} disabled={machines.length === 0}
            className="px-4 py-2 rounded-xl bg-henry-accent text-white text-sm font-bold disabled:opacity-40 hover:bg-henry-accent/80 transition-all">
            + Log service
          </button>
        </div>

        {/* Per-machine status row */}
        {machineStatusList.length > 0 && (
          <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-2">
            {machineStatusList.map(({ machine, lastDays, nextDays, urgency }) => {
              const urgencyClass =
                urgency === 'overdue' ? 'border-rose-500/40 bg-rose-500/5' :
                urgency === 'soon' ? 'border-amber-400/40 bg-amber-400/5' :
                urgency === 'ok' ? 'border-henry-border/20 bg-henry-surface' :
                'border-henry-border/20 bg-henry-surface';
              return (
                <button key={machine.id}
                  onClick={() => setMachineFilter(machine.id === machineFilter ? '' : machine.id)}
                  className={`text-left rounded-xl border px-3 py-2 transition-all ${urgencyClass} ${
                    machineFilter === machine.id ? 'ring-1 ring-henry-accent/40' : ''
                  } hover:border-henry-accent/40`}>
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-semibold text-henry-text truncate">{machine.name}</span>
                    {urgency === 'overdue' && <span className="text-[9px] text-rose-400 font-bold uppercase ml-2">Overdue</span>}
                    {urgency === 'soon' && <span className="text-[9px] text-amber-400 font-bold uppercase ml-2">Soon</span>}
                  </div>
                  <p className="text-[10px] text-henry-text-muted mt-0.5">
                    {lastDays != null
                      ? `Last service ${lastDays === 0 ? 'today' : lastDays === 1 ? 'yesterday' : `${lastDays}d ago`}`
                      : 'No service logged'}
                    {nextDays != null && (
                      <span>
                        {' · '}
                        {nextDays < 0 ? `${-nextDays}d overdue` : nextDays === 0 ? 'due today' : `due in ${nextDays}d`}
                      </span>
                    )}
                  </p>
                </button>
              );
            })}
          </div>
        )}

        {/* Type filter chips */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button onClick={() => setTypeFilter('')}
            className={`text-[11px] px-2.5 py-1 rounded-full font-medium transition-all ${
              typeFilter === ''
                ? 'bg-henry-accent text-white'
                : 'bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text'
            }`}>
            All types
          </button>
          {TYPE_META.slice(0, 6).map(t => (
            <button key={t.id} onClick={() => setTypeFilter(t.id === typeFilter ? '' : t.id)}
              className={`text-[11px] px-2.5 py-1 rounded-full font-medium transition-all ${
                typeFilter === t.id
                  ? 'bg-henry-accent text-white'
                  : 'bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text'
              }`}>
              {t.icon} {t.label}
            </button>
          ))}
          {machineFilter && (
            <button onClick={() => setMachineFilter('')}
              className="text-[11px] px-2.5 py-1 rounded-full bg-henry-accent/15 text-henry-accent hover:bg-henry-accent/25 transition-all">
              {machineName(machineFilter)} ✕
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && <p className="text-henry-text-muted text-sm text-center py-12">Loading…</p>}

        {!loading && machines.length === 0 && (
          <div className="text-center py-12">
            <p className="text-3xl mb-3">⚙</p>
            <p className="text-henry-text-muted text-sm">Add a machine first.</p>
            <button onClick={() => setCurrentView('machines')}
              className="mt-3 text-xs text-henry-accent hover:underline">
              Go to Machines →
            </button>
          </div>
        )}

        {!loading && machines.length > 0 && filtered.length === 0 && (
          <div className="text-center py-12">
            <p className="text-3xl mb-3">◎</p>
            <p className="text-henry-text-muted text-sm">No maintenance entries yet.</p>
            <p className="text-henry-text-muted text-xs mt-1">Tap "Log service" to record one.</p>
          </div>
        )}

        <div className="space-y-2 max-w-3xl">
          {filtered.map((e) => {
            const meta = typeMeta(e.type);
            return (
              <div key={e.id}
                className="group bg-henry-surface rounded-xl border border-henry-border/20 hover:border-henry-accent/30 transition-all">
                <div className="px-4 py-3 flex items-start gap-3">
                  <span className={`text-xs font-bold px-2 py-1 rounded ${meta.color} flex-shrink-0 mt-0.5`}>{meta.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-semibold text-henry-text text-sm">{meta.label}</span>
                      <span className="text-[11px] text-henry-text-muted">
                        · {machineName(e.machine_id)}
                      </span>
                      {e.duration_minutes ? (
                        <span className="text-[11px] text-henry-text-muted">· {Math.round(e.duration_minutes)}m</span>
                      ) : null}
                    </div>
                    <p className="text-sm text-henry-text mt-1">{e.description}</p>
                    {e.parts_used && (
                      <p className="text-[11px] text-henry-text-muted mt-0.5">Parts: {e.parts_used}</p>
                    )}
                    {e.next_due_at && (
                      <p className="text-[11px] text-amber-400/90 mt-0.5">Next due: {fmtDate(e.next_due_at)}</p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    {e.cost > 0 && <p className="text-sm font-bold text-henry-text">{fmtMoney(e.cost)}</p>}
                    <p className="text-[10px] text-henry-text-muted">{fmtDate(e.created_at)}</p>
                  </div>
                  <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => askHenryAboutMachine(e.machine_id)} title="Ask Henry"
                      className="text-[10px] px-2 py-0.5 rounded bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20">Ask</button>
                    <button onClick={() => setEditing(e)}
                      className="text-[10px] px-2 py-0.5 rounded bg-henry-surface2 text-henry-text-muted hover:text-henry-text">Edit</button>
                    <button onClick={() => remove(e.id)}
                      className="text-[10px] px-2 py-0.5 rounded text-henry-text-muted hover:text-rose-400">✕</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="bg-henry-bg border border-henry-border rounded-2xl w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-henry-text">
                {entries.find(e => e.id === editing.id) ? 'Edit service entry' : 'Log service'}
              </h2>
              <button onClick={() => setEditing(null)} className="text-henry-text-muted hover:text-henry-text">✕</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Machine *">
                <select value={editing.machine_id} onChange={(e) => setEditing({ ...editing, machine_id: e.target.value })}
                  className={inputCls}>
                  <option value="">— select —</option>
                  {machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
              <Field label="Type">
                <select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as MaintenanceType })}
                  className={inputCls}>
                  {TYPE_META.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </Field>
            </div>

            <Field label="Description *">
              <textarea value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                rows={3} placeholder="Replaced hotend, cleaned bed, calibrated Z-offset…"
                className={inputCls + ' resize-none'} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Cost $">
                <input type="number" step="0.01" value={editing.cost || ''}
                  onChange={(e) => setEditing({ ...editing, cost: Number(e.target.value) || 0 })} className={inputCls} />
              </Field>
              <Field label="Duration (min)">
                <input type="number" value={editing.duration_minutes ?? ''}
                  onChange={(e) => setEditing({ ...editing, duration_minutes: Number(e.target.value) || undefined })} className={inputCls} />
              </Field>
            </div>

            <Field label="Parts used (optional)">
              <input value={editing.parts_used || ''} onChange={(e) => setEditing({ ...editing, parts_used: e.target.value })}
                placeholder="hotend, nozzle 0.4mm, belt…" className={inputCls} />
            </Field>

            <Field label="Next service due" hint="Sets a reminder for upcoming service">
              <input type="date" value={(editing.next_due_at || '').slice(0, 10)}
                onChange={(e) => setEditing({ ...editing, next_due_at: e.target.value || undefined })} className={inputCls} />
            </Field>

            <div className="flex gap-2 pt-2">
              <button onClick={() => setEditing(null)}
                className="flex-1 py-2.5 rounded-xl bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text transition-all">
                Cancel
              </button>
              <button onClick={() => void save()} disabled={!editing.machine_id || !editing.description.trim()}
                className="flex-1 py-2.5 rounded-xl bg-henry-accent text-white font-semibold disabled:opacity-40 hover:bg-henry-accent/80 transition-all">
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
