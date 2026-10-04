/**
 * Production Runs Panel — every job run on every machine, with auto-cost
 * and profit calculation.
 *
 * Backed by SQLite. Henry can answer "what was my profit this month",
 * "what was my last run on the X1", "show me all failed runs" etc. by
 * querying this table directly — zero AI tokens.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useStore } from '../../store';
import { sendToHenry } from '../../actions/store/chatBridgeStore';

interface Machine {
  id: string;
  name: string;
  machine_type: string;
  hourly_rate?: number;
  power_watts?: number;
}

interface MaterialUsed {
  material_id?: string;
  description: string;
  quantity: number;
  unit: string;
  unit_cost?: number;
}

interface ProductionRun {
  id: string;
  name: string;
  machine_id?: string;
  project?: string;
  customer_id?: string;
  materials_used: string;             // JSON
  started_at?: string;
  completed_at?: string;
  duration_minutes?: number;
  success: number;                    // 0/1
  failure_reason?: string;
  material_cost: number;
  machine_cost: number;
  electricity_cost: number;
  labor_cost: number;
  total_cost: number;
  charged_amount: number;
  profit: number;
  source_file_path?: string;
  output_photo_path?: string;
  payload: string;                    // JSON
  notes?: string;
  created_at: string;
  updated_at: string;
}

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

function newRun(): ProductionRun {
  const now = new Date().toISOString();
  return {
    id: `run_${Date.now()}`,
    name: '', machine_id: '', project: '', customer_id: '',
    materials_used: '[]',
    started_at: now.slice(0, 16),
    completed_at: '',
    duration_minutes: undefined,
    success: 1,
    material_cost: 0, machine_cost: 0, electricity_cost: 0, labor_cost: 0,
    total_cost: 0, charged_amount: 0, profit: 0,
    payload: '{}',
    created_at: now, updated_at: now,
  };
}

function fmtMoney(n: number): string {
  if (!n) return '$0';
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  catch { return iso.slice(0, 10); }
}

function fmtDuration(mins?: number | null): string {
  if (!mins || mins <= 0) return '—';
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function autoComputeDuration(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  try {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (e <= s) return undefined;
    return Math.round((e - s) / 60000);
  } catch { return undefined; }
}

export default function ProductionRunsPanel() {
  const setCurrentView = useStore((s) => s.setCurrentView);
  const [runs, setRuns] = useState<ProductionRun[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [filter, setFilter] = useState<'all' | 'success' | 'failed' | 'this-month'>('all');
  const [machineFilter, setMachineFilter] = useState<string>('');
  const [editing, setEditing] = useState<ProductionRun | null>(null);
  const [summary, setSummary] = useState<{ runs:number; total_cost:number; revenue:number; profit:number; total_minutes:number } | null>(null);
  const [loading, setLoading] = useState(true);

  const api = (typeof window !== 'undefined' && (window as any).henryAPI) || null;

  const reload = useCallback(async () => {
    if (!api?.makerRunsList) { setLoading(false); return; }
    try {
      const [r, m, s] = await Promise.all([
        api.makerRunsList({ limit: 200 }),
        api.makerMachinesList({ activeOnly: true }),
        api.makerRunsSummary({ month: new Date().toISOString().slice(0, 7) }),
      ]);
      setRuns(Array.isArray(r) ? r : []);
      setMachines(Array.isArray(m) ? m : []);
      setSummary(s || null);
    } catch (e) { console.warn('[ProductionRuns] load failed', e); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void reload(); }, [reload]);

  const filtered = useMemo(() => {
    let list = runs;
    if (filter === 'success') list = list.filter(r => r.success === 1);
    if (filter === 'failed') list = list.filter(r => r.success === 0);
    if (filter === 'this-month') {
      const month = new Date().toISOString().slice(0, 7);
      list = list.filter(r => (r.completed_at || r.started_at || r.created_at).startsWith(month));
    }
    if (machineFilter) list = list.filter(r => r.machine_id === machineFilter);
    return list;
  }, [runs, filter, machineFilter]);

  const machineName = (id?: string) => machines.find(m => m.id === id)?.name || '—';

  const save = async () => {
    if (!editing || !api?.makerRunsSave) return;
    const payload = { ...editing };
    // Auto-compute duration if not set but we have start/end
    if (!payload.duration_minutes) {
      const dur = autoComputeDuration(payload.started_at, payload.completed_at);
      if (dur != null) payload.duration_minutes = dur;
    }
    // Auto-compute machine_cost if hourly rate and duration are known
    const machine = machines.find(m => m.id === payload.machine_id);
    if (machine?.hourly_rate && payload.duration_minutes && !payload.machine_cost) {
      payload.machine_cost = (machine.hourly_rate * payload.duration_minutes) / 60;
    }
    await api.makerRunsSave(payload);
    setEditing(null);
    await reload();
  };

  const remove = async (id: string) => {
    if (!api?.makerRunsDelete) return;
    if (!confirm('Delete this run? This cannot be undone.')) return;
    await api.makerRunsDelete(id);
    await reload();
  };

  const askHenry = (r: ProductionRun) => {
    const m = machineName(r.machine_id);
    const date = r.completed_at ? fmtDate(r.completed_at) : 'recent';
    const profit = r.profit;
    const dur = fmtDuration(r.duration_minutes);
    const status = r.success ? 'succeeded' : `failed (${r.failure_reason || 'unknown'})`;
    sendToHenry(
      `Tell me about this production run: "${r.name}" on ${m}, ${date}, ${dur}, ${status}. ` +
        `Cost $${r.total_cost.toFixed(2)}, charged $${r.charged_amount.toFixed(2)}, profit ${fmtMoney(profit)}. ` +
        `Notes: ${r.notes || 'none'}. What can I learn from this and what should I do next?`
    );
    setCurrentView('chat');
  };

  return (
    <div className="flex flex-col h-full bg-henry-bg overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-3 border-b border-henry-border/20 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-henry-text">Production Runs</h1>
            <p className="text-[11px] text-henry-text-muted mt-0.5">
              {runs.length} total · {filtered.length} shown
            </p>
          </div>
          <button onClick={() => setEditing(newRun())}
            className="px-4 py-2 rounded-xl bg-henry-accent text-white text-sm font-bold hover:bg-henry-accent/80 transition-all">
            + Log run
          </button>
        </div>

        {/* This month summary */}
        {summary && (
          <div className="mt-3 grid grid-cols-4 gap-2">
            <div className="bg-henry-surface rounded-xl border border-henry-border/20 px-3 py-2.5">
              <p className="text-[9px] uppercase tracking-wider text-henry-text-muted">Runs (mo)</p>
              <p className="text-base font-bold text-henry-text mt-0.5">{summary.runs}</p>
            </div>
            <div className="bg-henry-surface rounded-xl border border-henry-border/20 px-3 py-2.5">
              <p className="text-[9px] uppercase tracking-wider text-henry-text-muted">Revenue</p>
              <p className="text-base font-bold text-emerald-400 mt-0.5">{fmtMoney(summary.revenue)}</p>
            </div>
            <div className="bg-henry-surface rounded-xl border border-henry-border/20 px-3 py-2.5">
              <p className="text-[9px] uppercase tracking-wider text-henry-text-muted">Cost</p>
              <p className="text-base font-bold text-henry-text mt-0.5">{fmtMoney(summary.total_cost)}</p>
            </div>
            <div className={`rounded-xl border px-3 py-2.5 ${
              summary.profit >= 0
                ? 'bg-henry-accent/10 border-henry-accent/30'
                : 'bg-rose-500/10 border-rose-500/30'
            }`}>
              <p className="text-[9px] uppercase tracking-wider text-henry-text-muted">Profit</p>
              <p className={`text-base font-bold mt-0.5 ${
                summary.profit >= 0 ? 'text-henry-accent' : 'text-rose-400'
              }`}>{fmtMoney(summary.profit)}</p>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(['all','this-month','success','failed'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-[11px] px-2.5 py-1 rounded-full font-medium transition-all ${
                filter === f
                  ? 'bg-henry-accent text-white'
                  : 'bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text'
              }`}>
              {f === 'all' ? 'All' : f === 'this-month' ? 'This month' : f === 'success' ? 'Successful' : 'Failed'}
            </button>
          ))}
          {machines.length > 0 && (
            <select value={machineFilter} onChange={(e) => setMachineFilter(e.target.value)}
              className="text-[11px] px-2.5 py-1 rounded-full bg-henry-surface border border-henry-border/30 text-henry-text-muted">
              <option value="">All machines</option>
              {machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && <p className="text-henry-text-muted text-sm text-center py-12">Loading runs…</p>}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-12">
            <p className="text-3xl mb-3">▶</p>
            <p className="text-henry-text-muted text-sm">No production runs yet.</p>
            <p className="text-henry-text-muted text-xs mt-1">Tap "Log run" to record your first job.</p>
          </div>
        )}

        <div className="space-y-2 max-w-4xl">
          {filtered.map((r) => (
            <div key={r.id}
              className="group bg-henry-surface rounded-xl border border-henry-border/20 hover:border-henry-accent/30 transition-all">
              <div className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <h3 className="font-semibold text-henry-text text-sm truncate">{r.name || 'Untitled run'}</h3>
                    <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold ${
                      r.success ? 'text-emerald-400 bg-emerald-400/10' : 'text-rose-400 bg-rose-400/10'
                    }`}>
                      {r.success ? 'OK' : 'Failed'}
                    </span>
                    {r.project && <span className="text-[10px] text-henry-text-muted">· {r.project}</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-henry-text-muted flex-wrap">
                    <span>{machineName(r.machine_id)}</span>
                    <span>·</span>
                    <span>{fmtDate(r.completed_at || r.started_at || r.created_at)}</span>
                    <span>·</span>
                    <span>{fmtDuration(r.duration_minutes)}</span>
                    {r.failure_reason && <><span>·</span><span className="text-rose-400">{r.failure_reason}</span></>}
                  </div>
                  {r.notes && <p className="text-[11px] text-henry-text-muted mt-1.5 line-clamp-1">{r.notes}</p>}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className={`text-sm font-bold ${r.profit >= 0 ? 'text-henry-accent' : 'text-rose-400'}`}>
                    {fmtMoney(r.profit)}
                  </p>
                  <p className="text-[10px] text-henry-text-muted">
                    cost {fmtMoney(r.total_cost)}
                  </p>
                </div>
                <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => askHenry(r)}
                    title="Ask Henry"
                    className="text-[10px] px-2 py-1 rounded bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20">Ask</button>
                  <button onClick={() => setEditing(r)}
                    className="text-[10px] px-2 py-1 rounded bg-henry-surface2 text-henry-text-muted hover:text-henry-text">Edit</button>
                  <button onClick={() => remove(r.id)}
                    className="text-[10px] px-2 py-1 rounded text-henry-text-muted hover:text-rose-400">✕</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="bg-henry-bg border border-henry-border rounded-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-henry-text">
                {runs.find(r => r.id === editing.id) ? 'Edit run' : 'Log new run'}
              </h2>
              <button onClick={() => setEditing(null)} className="text-henry-text-muted hover:text-henry-text">✕</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Name *">
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="Custom logo plaque" className={inputCls} />
              </Field>
              <Field label="Machine">
                <select value={editing.machine_id || ''} onChange={(e) => setEditing({ ...editing, machine_id: e.target.value })}
                  className={inputCls}>
                  <option value="">— none —</option>
                  {machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
              <Field label="Project">
                <input value={editing.project || ''} onChange={(e) => setEditing({ ...editing, project: e.target.value })}
                  placeholder="Acme order #103" className={inputCls} />
              </Field>
              <Field label="Status">
                <select value={editing.success} onChange={(e) => setEditing({ ...editing, success: Number(e.target.value) })}
                  className={inputCls}>
                  <option value={1}>Successful</option>
                  <option value={0}>Failed</option>
                </select>
              </Field>
              {!editing.success && (
                <Field label="Failure reason">
                  <input value={editing.failure_reason || ''} onChange={(e) => setEditing({ ...editing, failure_reason: e.target.value })}
                    placeholder="layer shift, warping, file error…" className={inputCls} />
                </Field>
              )}
              <Field label="Started">
                <input type="datetime-local" value={(editing.started_at || '').slice(0, 16)}
                  onChange={(e) => setEditing({ ...editing, started_at: e.target.value })} className={inputCls} />
              </Field>
              <Field label="Completed">
                <input type="datetime-local" value={(editing.completed_at || '').slice(0, 16)}
                  onChange={(e) => setEditing({ ...editing, completed_at: e.target.value })} className={inputCls} />
              </Field>
              <Field label="Duration (min)" hint="Auto-fills from start/end if blank">
                <input type="number" value={editing.duration_minutes ?? ''}
                  onChange={(e) => setEditing({ ...editing, duration_minutes: Number(e.target.value) || undefined })}
                  placeholder="auto" className={inputCls} />
              </Field>
            </div>

            <div className="border-t border-henry-border/20 pt-3 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-henry-text-muted font-semibold">Cost & price</p>
              <div className="grid grid-cols-4 gap-2">
                <Field label="Material $">
                  <input type="number" step="0.01" value={editing.material_cost || ''}
                    onChange={(e) => setEditing({ ...editing, material_cost: Number(e.target.value) || 0 })} className={inputCls} />
                </Field>
                <Field label="Machine $" hint="Auto if hourly rate">
                  <input type="number" step="0.01" value={editing.machine_cost || ''}
                    onChange={(e) => setEditing({ ...editing, machine_cost: Number(e.target.value) || 0 })} className={inputCls} />
                </Field>
                <Field label="Electricity $">
                  <input type="number" step="0.01" value={editing.electricity_cost || ''}
                    onChange={(e) => setEditing({ ...editing, electricity_cost: Number(e.target.value) || 0 })} className={inputCls} />
                </Field>
                <Field label="Labor $">
                  <input type="number" step="0.01" value={editing.labor_cost || ''}
                    onChange={(e) => setEditing({ ...editing, labor_cost: Number(e.target.value) || 0 })} className={inputCls} />
                </Field>
              </div>
              <Field label="Charged amount $">
                <input type="number" step="0.01" value={editing.charged_amount || ''}
                  onChange={(e) => setEditing({ ...editing, charged_amount: Number(e.target.value) || 0 })}
                  placeholder="0 for personal/hobby" className={inputCls} />
              </Field>
              <div className="text-[11px] text-henry-text-muted bg-henry-surface rounded-lg px-3 py-2 flex justify-between">
                <span>Estimated total cost: <span className="text-henry-text font-semibold">
                  {fmtMoney((editing.material_cost||0)+(editing.machine_cost||0)+(editing.electricity_cost||0)+(editing.labor_cost||0))}
                </span></span>
                <span>Estimated profit: <span className={`font-semibold ${
                  (editing.charged_amount||0) - ((editing.material_cost||0)+(editing.machine_cost||0)+(editing.electricity_cost||0)+(editing.labor_cost||0)) >= 0
                    ? 'text-henry-accent' : 'text-rose-400'
                }`}>
                  {fmtMoney((editing.charged_amount||0) - ((editing.material_cost||0)+(editing.machine_cost||0)+(editing.electricity_cost||0)+(editing.labor_cost||0)))}
                </span></span>
              </div>
            </div>

            <Field label="Source file path">
              <input value={editing.source_file_path || ''} onChange={(e) => setEditing({ ...editing, source_file_path: e.target.value })}
                placeholder="/Users/…/logo.svg" className={inputCls} />
            </Field>
            <Field label="Notes">
              <textarea value={editing.notes || ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                rows={3} placeholder="Settings, observations, lessons learned…"
                className={inputCls + ' resize-none'} />
            </Field>

            <div className="flex gap-2 pt-2">
              <button onClick={() => setEditing(null)}
                className="flex-1 py-2.5 rounded-xl bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text transition-all">
                Cancel
              </button>
              <button onClick={() => void save()} disabled={!editing.name.trim()}
                className="flex-1 py-2.5 rounded-xl bg-henry-accent text-white font-semibold disabled:opacity-40 hover:bg-henry-accent/80 transition-all">
                Save run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
