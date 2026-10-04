/**
 * Waste Panel — track every failed print, cutoff, scrap, or expired material.
 *
 * Three things this panel does:
 *   1. Log waste events fast (one tap → entry).
 *   2. Surface PATTERNS — "you've had 4 layer-shift failures this month" —
 *      so Henry (and you) can spot trouble before it costs more.
 *   3. Track disposal route (recycle/reuse/regrind/compost/donate/trash)
 *      so nothing just disappears.
 *
 * Backed by SQLite. Pattern queries are pure SQL — zero AI tokens.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { sendToHenry } from '../../actions/store/chatBridgeStore';
import { useStore } from '../../store';

type WasteReason =
  | 'failed-print' | 'support-material' | 'cutoff' | 'test-piece'
  | 'expired' | 'damaged' | 'wrong-color' | 'kerf' | 'overcut'
  | 'thread-jam' | 'tear-out' | 'other';

type DisposalRoute = 'recycle' | 'reuse' | 'regrind' | 'compost' | 'donate' | 'trash' | 'pending';

interface WasteEntry {
  id: string;
  run_id?: string;
  material_id?: string;
  material_description?: string;
  quantity: number;
  unit?: string;
  reason: WasteReason;
  disposal_route: DisposalRoute;
  estimated_cost: number;
  notes?: string;
  created_at: string;
}

interface Material {
  id: string;
  name: string;
  category: string;
  unit: string;
}

interface WastePattern {
  reason: WasteReason;
  count: number;
  total_qty: number;
  total_cost: number;
}

const REASONS: { id: WasteReason; label: string; icon: string }[] = [
  { id: 'failed-print',     label: 'Failed print',      icon: '⌧' },
  { id: 'support-material', label: 'Support material',  icon: '◇' },
  { id: 'cutoff',           label: 'Cutoff / offcut',   icon: '◰' },
  { id: 'test-piece',       label: 'Test piece',        icon: '◐' },
  { id: 'expired',          label: 'Expired',           icon: '◌' },
  { id: 'damaged',          label: 'Damaged material',  icon: '✕' },
  { id: 'wrong-color',      label: 'Wrong color',       icon: '◔' },
  { id: 'kerf',             label: 'Laser kerf',        icon: '╱' },
  { id: 'overcut',          label: 'Overcut / burn',    icon: '◣' },
  { id: 'thread-jam',       label: 'Thread jam',        icon: '◈' },
  { id: 'tear-out',         label: 'CNC tear-out',      icon: '◎' },
  { id: 'other',            label: 'Other',             icon: '·' },
];

const DISPOSAL_META: Record<DisposalRoute, { label: string; color: string }> = {
  recycle: { label: 'Recycle',  color: 'text-emerald-400 bg-emerald-400/10' },
  reuse:   { label: 'Reuse',    color: 'text-sky-400 bg-sky-400/10' },
  regrind: { label: 'Regrind',  color: 'text-violet-400 bg-violet-400/10' },
  compost: { label: 'Compost',  color: 'text-lime-400 bg-lime-400/10' },
  donate:  { label: 'Donate',   color: 'text-amber-400 bg-amber-400/10' },
  trash:   { label: 'Trash',    color: 'text-rose-400 bg-rose-400/10' },
  pending: { label: 'Pending',  color: 'text-henry-text-muted bg-henry-surface' },
};

const inputCls = 'w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

function reasonMeta(r: string) {
  return REASONS.find(x => x.id === r) || REASONS[REASONS.length - 1];
}

function fmtMoney(n: number): string {
  if (!n) return '$0';
  return `$${n.toFixed(2)}`;
}

function newWaste(): WasteEntry {
  return {
    id: `w_${Date.now()}`,
    quantity: 0,
    reason: 'failed-print',
    disposal_route: 'pending',
    estimated_cost: 0,
    created_at: new Date().toISOString(),
  };
}

export default function WastePanel() {
  const setCurrentView = useStore((s) => s.setCurrentView);
  const [entries, setEntries] = useState<WasteEntry[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [patterns, setPatterns] = useState<WastePattern[]>([]);
  const [editing, setEditing] = useState<WasteEntry | null>(null);
  const [filterReason, setFilterReason] = useState<string>('');
  const [windowDays, setWindowDays] = useState<number>(30);
  const [loading, setLoading] = useState(true);

  const api = (typeof window !== 'undefined' && (window as any).henryAPI) || null;

  const reload = useCallback(async () => {
    if (!api?.makerWasteList) { setLoading(false); return; }
    try {
      const [w, m, p] = await Promise.all([
        api.makerWasteList(300),
        api.makerMaterialsList({ activeOnly: true }),
        api.makerWastePatterns({ sinceDays: windowDays }),
      ]);
      setEntries(Array.isArray(w) ? w : []);
      setMaterials(Array.isArray(m) ? m : []);
      setPatterns(Array.isArray(p) ? p : []);
    } catch (e) { console.warn('[Waste] load failed', e); }
    finally { setLoading(false); }
  }, [api, windowDays]);

  useEffect(() => { void reload(); }, [reload]);

  const totals = useMemo(() => {
    const totalCount = entries.length;
    const totalCost = entries.reduce((s, e) => s + (e.estimated_cost || 0), 0);
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();
    const recent = entries.filter(e => e.created_at >= since);
    const recentCost = recent.reduce((s, e) => s + (e.estimated_cost || 0), 0);
    return { totalCount, totalCost, recentCount: recent.length, recentCost };
  }, [entries, windowDays]);

  const filtered = useMemo(() => {
    if (!filterReason) return entries;
    return entries.filter(e => e.reason === filterReason);
  }, [entries, filterReason]);

  const save = async () => {
    if (!editing || !api?.makerWasteSave) return;
    await api.makerWasteSave(editing);
    setEditing(null);
    await reload();
  };

  const remove = async (id: string) => {
    if (!api?.makerWasteDelete) return;
    if (!confirm('Delete this waste entry?')) return;
    await api.makerWasteDelete(id);
    await reload();
  };

  const setRoute = async (e: WasteEntry, route: DisposalRoute) => {
    if (!api?.makerWasteSave) return;
    await api.makerWasteSave({ ...e, disposal_route: route });
    await reload();
  };

  const askHenryAboutPatterns = () => {
    const summary = patterns.slice(0, 5).map(p =>
      `${reasonMeta(p.reason).label}: ${p.count}x (${fmtMoney(p.total_cost)} lost)`
    ).join(', ');
    sendToHenry(
      `Looking at my waste log for the last ${windowDays} days. Patterns: ${summary || 'no waste recorded'}. ` +
        `What does this tell you, and what would you check or change to reduce waste?`
    );
    setCurrentView('chat');
  };

  const materialName = (id?: string) => materials.find(m => m.id === id)?.name;

  return (
    <div className="flex flex-col h-full bg-henry-bg overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-3 border-b border-henry-border/20 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-henry-text">Waste log</h1>
            <p className="text-[11px] text-henry-text-muted mt-0.5">
              {totals.totalCount} total · {fmtMoney(totals.totalCost)} lost lifetime
            </p>
          </div>
          <button onClick={() => setEditing(newWaste())}
            className="px-4 py-2 rounded-xl bg-henry-accent text-white text-sm font-bold hover:bg-henry-accent/80 transition-all">
            + Log waste
          </button>
        </div>

        {/* Window selector */}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-henry-text-muted">Window:</span>
          {[7, 30, 90, 365].map(d => (
            <button key={d} onClick={() => setWindowDays(d)}
              className={`text-[11px] px-2.5 py-1 rounded-full font-medium transition-all ${
                windowDays === d
                  ? 'bg-henry-accent text-white'
                  : 'bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text'
              }`}>
              {d === 365 ? '1y' : `${d}d`}
            </button>
          ))}
          <span className="text-[11px] text-henry-text-muted ml-3">
            {totals.recentCount} events · {fmtMoney(totals.recentCost)}
          </span>
        </div>

        {/* Patterns row */}
        {patterns.length > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] uppercase tracking-wider text-henry-text-muted font-semibold">
                Top patterns ({windowDays}d)
              </p>
              <button onClick={askHenryAboutPatterns}
                className="text-[10px] text-henry-accent hover:underline">
                Ask Henry →
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {patterns.slice(0, 6).map(p => {
                const meta = reasonMeta(p.reason);
                return (
                  <button key={p.reason}
                    onClick={() => setFilterReason(p.reason === filterReason ? '' : p.reason)}
                    className={`text-left rounded-xl border px-3 py-2 transition-all ${
                      filterReason === p.reason
                        ? 'bg-henry-accent/10 border-henry-accent/40'
                        : 'bg-henry-surface border-henry-border/20 hover:border-henry-accent/30'
                    }`}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs font-semibold text-henry-text truncate">{meta.label}</span>
                      <span className="text-base font-bold text-henry-accent ml-2">{p.count}x</span>
                    </div>
                    <p className="text-[10px] text-henry-text-muted mt-0.5">
                      {fmtMoney(p.total_cost)} lost
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Filter chip if active */}
        {filterReason && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-henry-text-muted">Filtered:</span>
            <button onClick={() => setFilterReason('')}
              className="text-[11px] px-2.5 py-1 rounded-full bg-henry-accent/15 text-henry-accent hover:bg-henry-accent/25 transition-all">
              {reasonMeta(filterReason).label} ✕
            </button>
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && <p className="text-henry-text-muted text-sm text-center py-12">Loading…</p>}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-12">
            <p className="text-3xl mb-3">◌</p>
            <p className="text-henry-text-muted text-sm">
              {filterReason ? 'No entries with this reason.' : 'No waste recorded yet — keep it that way.'}
            </p>
          </div>
        )}

        <div className="space-y-2 max-w-3xl">
          {filtered.map((e) => {
            const meta = reasonMeta(e.reason);
            const dMeta = DISPOSAL_META[e.disposal_route] || DISPOSAL_META.pending;
            const matName = e.material_id ? materialName(e.material_id) : e.material_description;
            return (
              <div key={e.id}
                className="group bg-henry-surface rounded-xl border border-henry-border/20 hover:border-henry-accent/30 transition-all">
                <div className="px-4 py-3 flex items-start gap-3">
                  <span className="text-base text-henry-accent flex-shrink-0 mt-0.5">{meta.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-semibold text-henry-text text-sm">{meta.label}</span>
                      {e.quantity > 0 && (
                        <span className="text-[11px] text-henry-text-muted">
                          · {e.quantity}{e.unit ? ` ${e.unit}` : ''}
                        </span>
                      )}
                      <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold ${dMeta.color}`}>
                        {dMeta.label}
                      </span>
                    </div>
                    {matName && <p className="text-[11px] text-henry-text-muted mt-0.5 truncate">{matName}</p>}
                    {e.notes && <p className="text-[11px] text-henry-text-muted mt-1 line-clamp-1">{e.notes}</p>}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-bold text-rose-400">{fmtMoney(e.estimated_cost)}</p>
                    <p className="text-[10px] text-henry-text-muted">{new Date(e.created_at).toLocaleDateString()}</p>
                  </div>
                  <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <select value={e.disposal_route} onChange={(ev) => void setRoute(e, ev.target.value as DisposalRoute)}
                      onClick={(ev) => ev.stopPropagation()}
                      className="text-[10px] px-1 py-0.5 rounded bg-henry-surface2 border border-henry-border/30 text-henry-text-muted">
                      {Object.entries(DISPOSAL_META).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
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
                {entries.find(e => e.id === editing.id) ? 'Edit waste entry' : 'Log waste'}
              </h2>
              <button onClick={() => setEditing(null)} className="text-henry-text-muted hover:text-henry-text">✕</button>
            </div>

            <Field label="Reason">
              <select value={editing.reason} onChange={(e) => setEditing({ ...editing, reason: e.target.value as WasteReason })}
                className={inputCls}>
                {REASONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </Field>

            <div className="grid grid-cols-3 gap-2">
              <Field label="Quantity">
                <input type="number" step="0.01" value={editing.quantity || ''}
                  onChange={(e) => setEditing({ ...editing, quantity: Number(e.target.value) || 0 })} className={inputCls} />
              </Field>
              <Field label="Unit">
                <input value={editing.unit || ''} onChange={(e) => setEditing({ ...editing, unit: e.target.value })}
                  placeholder="g, in, sheet…" className={inputCls} />
              </Field>
              <Field label="Lost $">
                <input type="number" step="0.01" value={editing.estimated_cost || ''}
                  onChange={(e) => setEditing({ ...editing, estimated_cost: Number(e.target.value) || 0 })} className={inputCls} />
              </Field>
            </div>

            <Field label="Material (optional)">
              <select value={editing.material_id || ''} onChange={(e) => setEditing({ ...editing, material_id: e.target.value })}
                className={inputCls}>
                <option value="">— freeform description below —</option>
                {materials.map(m => <option key={m.id} value={m.id}>{m.name} ({m.category})</option>)}
              </select>
            </Field>
            {!editing.material_id && (
              <Field label="Material description">
                <input value={editing.material_description || ''} onChange={(e) => setEditing({ ...editing, material_description: e.target.value })}
                  placeholder="PLA black, 1/8 birch ply, vinyl scrap…" className={inputCls} />
              </Field>
            )}

            <Field label="Disposal route">
              <select value={editing.disposal_route} onChange={(e) => setEditing({ ...editing, disposal_route: e.target.value as DisposalRoute })}
                className={inputCls}>
                {Object.entries(DISPOSAL_META).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </Field>

            <Field label="Notes">
              <textarea value={editing.notes || ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                rows={2} placeholder="What went wrong, what to try next…"
                className={inputCls + ' resize-none'} />
            </Field>

            <div className="flex gap-2 pt-2">
              <button onClick={() => setEditing(null)}
                className="flex-1 py-2.5 rounded-xl bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text transition-all">
                Cancel
              </button>
              <button onClick={() => void save()}
                className="flex-1 py-2.5 rounded-xl bg-henry-accent text-white font-semibold hover:bg-henry-accent/80 transition-all">
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
