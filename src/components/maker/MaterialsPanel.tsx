/**
 * Materials Panel — every consumable in your workshop.
 *
 * Categories: filament, wood, acrylic, metal, vinyl, thread, fabric,
 * leather, clay, glaze, paint, resin, blanks, ink, and more.
 * Tracks: brand, color (with hex), specs, quantity, cost, supplier,
 * location, reorder threshold. Surfaces low-stock alerts and a
 * cross-category color library for quick lookups.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useStore } from '../../store';

type MaterialCategory = 'filament' | 'wood' | 'acrylic' | 'metal' | 'vinyl'
  | 'thread' | 'fabric' | 'leather' | 'clay' | 'glaze' | 'paint' | 'resin'
  | 'blank' | 'ink' | 'paper' | 'other';

interface Material {
  id: string;
  name: string;
  category: MaterialCategory;
  brand?: string;
  color?: string;
  color_hex?: string;
  specs?: string;
  unit: string;
  quantity_total: number;
  quantity_unit_cost?: number;
  reorder_threshold?: number;
  supplier?: string;
  supplier_url?: string;
  location?: string;
  purchase_date?: string;
  notes?: string;
  active?: number;
  created_at?: string;
}

const CATEGORIES: { id: MaterialCategory; label: string; icon: string; defaultUnit: string }[] = [
  { id: 'filament',   label: 'Filament',     icon: '◉', defaultUnit: 'g' },
  { id: 'wood',       label: 'Wood',         icon: '◇', defaultUnit: 'sheet' },
  { id: 'acrylic',    label: 'Acrylic',      icon: '◆', defaultUnit: 'sheet' },
  { id: 'metal',      label: 'Metal',        icon: '◢', defaultUnit: 'sheet' },
  { id: 'vinyl',      label: 'Vinyl',        icon: '▣', defaultUnit: 'roll' },
  { id: 'thread',     label: 'Thread',       icon: '◈', defaultUnit: 'spool' },
  { id: 'fabric',     label: 'Fabric',       icon: '⌘', defaultUnit: 'yd' },
  { id: 'leather',    label: 'Leather',      icon: '◰', defaultUnit: 'sqft' },
  { id: 'clay',       label: 'Clay',         icon: '◉', defaultUnit: 'lb' },
  { id: 'glaze',      label: 'Glaze',        icon: '◐', defaultUnit: 'oz' },
  { id: 'paint',      label: 'Paint',        icon: '◯', defaultUnit: 'oz' },
  { id: 'resin',      label: 'Resin',        icon: '◑', defaultUnit: 'ml' },
  { id: 'blank',      label: 'Blanks',       icon: '☐', defaultUnit: 'piece' },
  { id: 'ink',        label: 'Ink',          icon: '◍', defaultUnit: 'ml' },
  { id: 'paper',      label: 'Paper',        icon: '⊞', defaultUnit: 'sheet' },
  { id: 'other',      label: 'Other',        icon: '◌', defaultUnit: 'piece' },
];

const UNITS = ['g', 'kg', 'lb', 'oz', 'ml', 'l', 'gal', 'piece', 'sheet', 'roll', 'spool', 'yd', 'm', 'ft', 'in', 'cm', 'sqft', 'sqm'];

function newMaterial(category: MaterialCategory = 'filament'): Material {
  const cat = CATEGORIES.find(c => c.id === category) || CATEGORIES[0];
  return {
    id: `mat_${Date.now()}`,
    name: '',
    category,
    unit: cat.defaultUnit,
    quantity_total: 0,
    quantity_unit_cost: 0,
    reorder_threshold: 0,
  };
}

function catMeta(c: string) { return CATEGORIES.find(x => x.id === c) || CATEGORIES[CATEGORIES.length - 1]; }

const inputCls = 'w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all';

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1.5 block">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-henry-text-muted mt-1">{hint}</p>}
    </div>
  );
}

export default function MaterialsPanel() {
  const { setCurrentView } = useStore();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [filter, setFilter] = useState<'all' | 'low' | MaterialCategory>('all');
  const [editing, setEditing] = useState<Material | null>(null);
  const [colorView, setColorView] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const api = (window as any).henryAPI;
    if (!api?.makerMaterialsList) { setLoading(false); return; }
    try {
      const list = await api.makerMaterialsList({ activeOnly: true }) as Material[];
      setMaterials(list || []);
    } catch (e) { console.warn('materials list failed', e); }
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function save() {
    if (!editing || !editing.name.trim()) return;
    const api = (window as any).henryAPI;
    await api?.makerMaterialsSave?.(editing);
    setEditing(null);
    void reload();
  }

  async function remove(id: string) {
    if (!confirm('Delete this material?')) return;
    const api = (window as any).henryAPI;
    await api?.makerMaterialsDelete?.(id);
    void reload();
  }

  const filtered = useMemo(() => {
    if (filter === 'all') return materials;
    if (filter === 'low') {
      return materials.filter(m => (m.reorder_threshold ?? 0) > 0 && m.quantity_total <= (m.reorder_threshold ?? 0));
    }
    return materials.filter(m => m.category === filter);
  }, [materials, filter]);

  const lowStockCount = materials.filter(m => (m.reorder_threshold ?? 0) > 0 && m.quantity_total <= (m.reorder_threshold ?? 0)).length;
  const counts = CATEGORIES.map(c => ({ ...c, n: materials.filter(m => m.category === c.id).length }));

  // Color library — group materials by color across all categories
  const colorLibrary = useMemo(() => {
    const byColor = new Map<string, { color: string; hex?: string; items: Material[] }>();
    materials.forEach(m => {
      if (!m.color) return;
      const key = `${m.color_hex || m.color}|${m.color}`;
      if (!byColor.has(key)) byColor.set(key, { color: m.color, hex: m.color_hex, items: [] });
      byColor.get(key)!.items.push(m);
    });
    return Array.from(byColor.values()).sort((a, b) => a.color.localeCompare(b.color));
  }, [materials]);

  function askHenry(prompt: string) {
    window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode: 'planner', prompt } }));
    setCurrentView('chat');
  }

  return (
    <div className="flex flex-col h-full bg-henry-bg overflow-hidden">
      <div className="px-6 pt-6 pb-4 border-b border-henry-border/30">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-henry-text">Materials</h1>
            <p className="text-xs text-henry-text-muted mt-0.5">
              {materials.length} item{materials.length === 1 ? '' : 's'}
              {lowStockCount > 0 && <span className="text-amber-400"> · {lowStockCount} low stock</span>}
              {colorLibrary.length > 0 && <> · {colorLibrary.length} colors</>}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setColorView(v => !v)}
              className={`text-[11px] px-3 py-1.5 rounded-lg transition-all ${colorView ? 'bg-henry-accent text-white' : 'bg-henry-surface text-henry-text-muted hover:text-henry-text'}`}>
              {colorView ? '✕ Close colors' : '🎨 Color library'}
            </button>
            <button onClick={() => askHenry('Look at my materials inventory and tell me: what should I reorder soon, what colors am I low on, and what could I use for a quick demo project today?')}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all">
              🧠 Ask Henry
            </button>
            <button onClick={() => setEditing(newMaterial())}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent text-white hover:bg-henry-accent/80 transition-all">
              + Add material
            </button>
          </div>
        </div>

        {!colorView && (
          <div className="mt-4 flex gap-1.5 overflow-x-auto pb-1">
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>All ({materials.length})</FilterChip>
            {lowStockCount > 0 && (
              <button onClick={() => setFilter('low')}
                className={`text-[11px] px-3 py-1.5 rounded-full whitespace-nowrap transition-all ${
                  filter === 'low' ? 'bg-amber-400/20 text-amber-400 border border-amber-400/40' : 'bg-amber-400/10 text-amber-400 border border-amber-400/20'
                }`}>
                ⚠ Low stock ({lowStockCount})
              </button>
            )}
            {counts.filter(c => c.n > 0).map(c => (
              <FilterChip key={c.id} active={filter === c.id} onClick={() => setFilter(c.id)}>
                {c.icon} {c.label} ({c.n})
              </FilterChip>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <p className="text-sm text-henry-text-muted">Loading…</p>
        ) : colorView ? (
          // Color library view
          colorLibrary.length === 0 ? (
            <p className="text-sm text-henry-text-muted text-center py-8">No colored materials yet. Add a material with a color to populate your library.</p>
          ) : (
            <div className="grid gap-2 grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {colorLibrary.map(c => (
                <div key={c.color + (c.hex || '')} className="bg-henry-surface/40 border border-henry-border/20 rounded-2xl p-3 flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl border border-henry-border/30 flex-shrink-0"
                    style={{ background: c.hex || '#666' }} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-henry-text truncate">{c.color}</p>
                    <p className="text-[11px] text-henry-text-muted">
                      {c.items.length} item{c.items.length === 1 ? '' : 's'}
                      {c.hex && <> · <span className="font-mono">{c.hex}</span></>}
                    </p>
                    <p className="text-[10px] text-henry-text-muted truncate">
                      {[...new Set(c.items.map(i => catMeta(i.category).label))].join(', ')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-henry-text-muted mb-3">
              {materials.length === 0
                ? 'No materials tracked yet. Add filament, wood, vinyl, thread — anything you consume.'
                : 'Nothing in this view.'}
            </p>
            <button onClick={() => setEditing(newMaterial())}
              className="text-[11px] px-4 py-2 rounded-lg bg-henry-accent text-white">
              + Add a material
            </button>
          </div>
        ) : (
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map(m => {
              const cm = catMeta(m.category);
              const lowStock = (m.reorder_threshold ?? 0) > 0 && m.quantity_total <= (m.reorder_threshold ?? 0);
              return (
                <div key={m.id} className={`bg-henry-surface/40 border rounded-2xl p-4 transition-all ${lowStock ? 'border-amber-400/40' : 'border-henry-border/20 hover:border-henry-border/50'}`}>
                  <div className="flex items-start gap-3 mb-2">
                    {m.color_hex ? (
                      <div className="w-10 h-10 rounded-xl border border-henry-border/30 flex-shrink-0" style={{ background: m.color_hex }} />
                    ) : (
                      <div className="w-10 h-10 rounded-xl bg-henry-surface flex items-center justify-center text-henry-accent flex-shrink-0">
                        {cm.icon}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-henry-text truncate">{m.name}</p>
                      <p className="text-[11px] text-henry-text-muted">
                        {cm.label}{m.brand && <> · {m.brand}</>}
                      </p>
                    </div>
                    {lowStock && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-400">Low</span>}
                  </div>

                  {m.specs && <p className="text-[11px] text-henry-text-muted mb-2 truncate">{m.specs}</p>}

                  <div className="flex items-baseline gap-1 mb-2">
                    <span className={`text-lg font-bold ${lowStock ? 'text-amber-400' : 'text-henry-text'}`}>
                      {m.quantity_total}
                    </span>
                    <span className="text-[11px] text-henry-text-muted">{m.unit}</span>
                    {(m.quantity_unit_cost ?? 0) > 0 && (
                      <span className="text-[11px] text-henry-text-muted ml-auto">
                        ${(m.quantity_total * (m.quantity_unit_cost ?? 0)).toFixed(2)} value
                      </span>
                    )}
                  </div>

                  {(m.location || m.supplier) && (
                    <p className="text-[10px] text-henry-text-muted mt-1">
                      {m.location}{m.location && m.supplier && ' · '}{m.supplier}
                    </p>
                  )}

                  <div className="flex gap-1.5 mt-3 pt-3 border-t border-henry-border/15">
                    <button onClick={() => setEditing(m)}
                      className="flex-1 text-[11px] py-1.5 rounded-lg bg-henry-surface text-henry-text hover:bg-henry-surface/80 transition-all">
                      Edit
                    </button>
                    {m.supplier_url && (
                      <a href={m.supplier_url} target="_blank" rel="noopener noreferrer"
                        className="flex-1 text-center text-[11px] py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all">
                        Reorder ↗
                      </a>
                    )}
                    <button onClick={() => remove(m.id)}
                      className="text-[11px] px-2 py-1.5 rounded-lg text-henry-text-muted hover:text-rose-400 hover:bg-rose-400/10 transition-all">
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="bg-henry-bg border border-henry-border/40 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-henry-text mb-4">
              {editing.created_at ? 'Edit material' : 'Add material'}
            </h2>

            <div className="space-y-3">
              <Field label="Name (required)">
                <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}
                  placeholder='e.g., "Bambu PLA Basic Black", "1/4″ Birch Plywood"'
                  className={inputCls} />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Category">
                  <select value={editing.category} onChange={e => {
                    const next = e.target.value as MaterialCategory;
                    const def = CATEGORIES.find(c => c.id === next);
                    setEditing({ ...editing, category: next, unit: editing.unit || (def?.defaultUnit || 'piece') });
                  }} className={inputCls}>
                    {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
                  </select>
                </Field>
                <Field label="Brand">
                  <input value={editing.brand || ''} onChange={e => setEditing({ ...editing, brand: e.target.value })}
                    className={inputCls} />
                </Field>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <Field label="Color">
                  <input value={editing.color || ''} onChange={e => setEditing({ ...editing, color: e.target.value })}
                    placeholder="Black, Sky Blue…" className={inputCls} />
                </Field>
                <Field label="Hex">
                  <input type="color" value={editing.color_hex || '#888888'}
                    onChange={e => setEditing({ ...editing, color_hex: e.target.value })}
                    className="w-full h-9 bg-henry-surface border border-henry-border/30 rounded-xl cursor-pointer" />
                </Field>
                <Field label="Specs">
                  <input value={editing.specs || ''} onChange={e => setEditing({ ...editing, specs: e.target.value })}
                    placeholder='1.75mm, 1/8″…' className={inputCls} />
                </Field>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <Field label="Quantity">
                  <input type="number" min={0} step={1} value={editing.quantity_total}
                    onChange={e => setEditing({ ...editing, quantity_total: Number(e.target.value) })}
                    className={inputCls} />
                </Field>
                <Field label="Unit">
                  <select value={editing.unit} onChange={e => setEditing({ ...editing, unit: e.target.value })}
                    className={inputCls}>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </Field>
                <Field label="$ / unit">
                  <input type="number" min={0} step={0.001} value={editing.quantity_unit_cost ?? 0}
                    onChange={e => setEditing({ ...editing, quantity_unit_cost: Number(e.target.value) })}
                    className={inputCls} />
                </Field>
              </div>

              <Field label="Reorder when below" hint="Set to 0 to disable low-stock alerts">
                <input type="number" min={0} step={1} value={editing.reorder_threshold ?? 0}
                  onChange={e => setEditing({ ...editing, reorder_threshold: Number(e.target.value) })}
                  className={inputCls} />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Location">
                  <input value={editing.location || ''} onChange={e => setEditing({ ...editing, location: e.target.value })}
                    placeholder="Shelf A2, Garage cabinet…" className={inputCls} />
                </Field>
                <Field label="Supplier">
                  <input value={editing.supplier || ''} onChange={e => setEditing({ ...editing, supplier: e.target.value })}
                    className={inputCls} />
                </Field>
              </div>

              <Field label="Reorder URL">
                <input type="url" value={editing.supplier_url || ''} onChange={e => setEditing({ ...editing, supplier_url: e.target.value })}
                  placeholder="https://…" className={inputCls + ' font-mono text-xs'} />
              </Field>

              <Field label="Notes">
                <textarea value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })}
                  rows={2} className={inputCls + ' resize-none'} />
              </Field>
            </div>

            <div className="flex gap-2 mt-5 pt-4 border-t border-henry-border/20">
              <button onClick={() => setEditing(null)}
                className="flex-1 py-2.5 rounded-xl bg-henry-surface text-henry-text-muted hover:text-henry-text transition-all">
                Cancel
              </button>
              <button onClick={() => void save()} disabled={!editing.name.trim()}
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

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`text-[11px] px-3 py-1.5 rounded-full whitespace-nowrap transition-all ${
        active
          ? 'bg-henry-accent/15 text-henry-accent border border-henry-accent/30'
          : 'bg-henry-surface/60 text-henry-text-muted border border-henry-border/20 hover:text-henry-text'
      }`}>
      {children}
    </button>
  );
}
