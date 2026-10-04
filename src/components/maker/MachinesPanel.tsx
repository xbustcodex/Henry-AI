/**
 * Machines Panel — every workshop machine in one place.
 *
 * Supports: 3D printers, laser cutters/etchers, CNC mills/routers,
 * embroidery, vinyl cutters, sublimation, sewing, kilns, electronics
 * benches, woodworking tools, and anything else.
 */
import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../store';
import ConnectionsSection from './ConnectionsSection';

type MachineType = '3d-printer' | 'laser' | 'cnc' | 'embroidery' | 'vinyl'
  | 'sublimation' | 'sewing' | 'kiln' | 'electronics' | 'woodshop' | 'other';
type ConnectionType = 'usb-serial' | 'network' | 'manual' | 'unknown';
type MachineStatus = 'idle' | 'running' | 'maintenance' | 'broken' | 'retired';

interface Machine {
  id: string;
  name: string;
  machine_type: MachineType;
  brand?: string;
  model?: string;
  serial_number?: string;
  connection_type?: ConnectionType;
  connection_address?: string;
  status: MachineStatus;
  hourly_rate?: number;
  power_watts?: number;
  purchase_date?: string;
  purchase_cost?: number;
  total_runtime_hours?: number;
  last_maintenance_at?: string;
  next_maintenance_at?: string;
  notes?: string;
  active?: number;
  created_at?: string;
  updated_at?: string;
}

const MACHINE_TYPES: { id: MachineType; label: string; icon: string }[] = [
  { id: '3d-printer',  label: '3D Printer',     icon: '▣' },
  { id: 'laser',       label: 'Laser Cutter',   icon: '◢' },
  { id: 'cnc',         label: 'CNC Router/Mill',icon: '◰' },
  { id: 'embroidery',  label: 'Embroidery',     icon: '◈' },
  { id: 'vinyl',       label: 'Vinyl Cutter',   icon: '◆' },
  { id: 'sublimation', label: 'Sublimation',    icon: '◐' },
  { id: 'sewing',      label: 'Sewing Machine', icon: '⌘' },
  { id: 'kiln',        label: 'Kiln / Pottery', icon: '◉' },
  { id: 'electronics', label: 'Electronics Bench', icon: '⏚' },
  { id: 'woodshop',    label: 'Woodshop Tool',  icon: '◇' },
  { id: 'other',       label: 'Other',          icon: '◌' },
];

const STATUS_META: Record<MachineStatus, { label: string; color: string }> = {
  idle:        { label: 'Idle',        color: 'text-emerald-400 bg-emerald-400/10' },
  running:     { label: 'Running',     color: 'text-sky-400 bg-sky-400/10' },
  maintenance: { label: 'Maintenance', color: 'text-amber-400 bg-amber-400/10' },
  broken:      { label: 'Broken',      color: 'text-rose-400 bg-rose-400/10' },
  retired:     { label: 'Retired',     color: 'text-henry-text-muted bg-henry-surface' },
};

function newMachine(): Machine {
  return {
    id: `m_${Date.now()}`,
    name: '',
    machine_type: '3d-printer',
    status: 'idle',
    connection_type: 'manual',
  };
}

function typeMeta(t: string) {
  return MACHINE_TYPES.find(x => x.id === t) || MACHINE_TYPES[MACHINE_TYPES.length - 1];
}

const inputCls = 'w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

export default function MachinesPanel() {
  const { setCurrentView } = useStore();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [filter, setFilter] = useState<'all' | MachineType>('all');
  const [editing, setEditing] = useState<Machine | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const api = (window as any).henryAPI;
    if (!api?.makerMachinesList) { setLoading(false); return; }
    try {
      const list = await api.makerMachinesList({ activeOnly: true }) as Machine[];
      setMachines(list || []);
    } catch (e) { console.warn('machines list failed', e); }
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function save() {
    if (!editing || !editing.name.trim()) return;
    const api = (window as any).henryAPI;
    await api?.makerMachinesSave?.(editing);
    setEditing(null);
    void reload();
  }

  async function remove(id: string) {
    if (!confirm('Delete this machine? Production runs linked to it will keep history but lose the link.')) return;
    const api = (window as any).henryAPI;
    await api?.makerMachinesDelete?.(id);
    void reload();
  }

  const filtered = filter === 'all' ? machines : machines.filter(m => m.machine_type === filter);
  const counts = MACHINE_TYPES.map(t => ({ ...t, n: machines.filter(m => m.machine_type === t.id).length }));

  function askHenry(prompt: string) {
    window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode: 'planner', prompt } }));
    setCurrentView('chat');
  }

  return (
    <div className="flex flex-col h-full bg-henry-bg overflow-hidden">
      <div className="px-6 pt-6 pb-4 border-b border-henry-border/30">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-henry-text">Machines</h1>
            <p className="text-xs text-henry-text-muted mt-0.5">
              {machines.length} machine{machines.length === 1 ? '' : 's'} in your workshop
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => askHenry('Help me plan maintenance for my workshop machines based on usage and last service dates.')}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all">
              🧠 Ask Henry
            </button>
            <button onClick={() => setEditing(newMachine())}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent text-white hover:bg-henry-accent/80 transition-all">
              + Add machine
            </button>
          </div>
        </div>

        <div className="mt-4 flex gap-1.5 overflow-x-auto pb-1">
          <button onClick={() => setFilter('all')}
            className={`text-[11px] px-3 py-1.5 rounded-full whitespace-nowrap transition-all ${
              filter === 'all'
                ? 'bg-henry-accent/15 text-henry-accent border border-henry-accent/30'
                : 'bg-henry-surface/60 text-henry-text-muted border border-henry-border/20 hover:text-henry-text'
            }`}>
            All ({machines.length})
          </button>
          {counts.filter(c => c.n > 0).map(c => (
            <button key={c.id} onClick={() => setFilter(c.id)}
              className={`text-[11px] px-3 py-1.5 rounded-full whitespace-nowrap transition-all ${
                filter === c.id
                  ? 'bg-henry-accent/15 text-henry-accent border border-henry-accent/30'
                  : 'bg-henry-surface/60 text-henry-text-muted border border-henry-border/20 hover:text-henry-text'
              }`}>
              {c.icon} {c.label} ({c.n})
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <ConnectionsSection />
        {loading ? (
          <p className="text-sm text-henry-text-muted">Loading…</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-henry-text-muted mb-3">
              {machines.length === 0
                ? 'No machines yet. Add your first one to start tracking jobs, materials, and costs.'
                : 'No machines in this category.'}
            </p>
            <button onClick={() => setEditing(newMachine())}
              className="text-[11px] px-4 py-2 rounded-lg bg-henry-accent text-white">
              + Add a machine
            </button>
          </div>
        ) : (
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map(m => {
              const tm = typeMeta(m.machine_type);
              const sm = STATUS_META[m.status] || STATUS_META.idle;
              return (
                <div key={m.id} className="bg-henry-surface/40 border border-henry-border/20 rounded-2xl p-4 hover:border-henry-border/50 transition-all">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg text-henry-accent">{tm.icon}</span>
                      <div>
                        <p className="text-sm font-semibold text-henry-text">{m.name}</p>
                        <p className="text-[11px] text-henry-text-muted">{tm.label}</p>
                      </div>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${sm.color}`}>{sm.label}</span>
                  </div>

                  {(m.brand || m.model) && (
                    <p className="text-[12px] text-henry-text-muted mb-2">
                      {[m.brand, m.model].filter(Boolean).join(' · ')}
                    </p>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-[11px] text-henry-text-muted mt-3">
                    {(m.hourly_rate ?? 0) > 0 && <p>Rate: ${m.hourly_rate}/hr</p>}
                    {(m.power_watts ?? 0) > 0 && <p>Power: {m.power_watts}W</p>}
                    {(m.total_runtime_hours ?? 0) > 0 && <p>Runtime: {Math.round(m.total_runtime_hours!)}h</p>}
                    {m.connection_address && <p className="font-mono truncate">{m.connection_address}</p>}
                  </div>

                  {m.next_maintenance_at && (
                    <p className="text-[11px] text-amber-400 mt-2">
                      Maint. due: {m.next_maintenance_at.slice(0, 10)}
                    </p>
                  )}

                  <div className="flex gap-1.5 mt-3 pt-3 border-t border-henry-border/15">
                    <button onClick={() => setEditing(m)}
                      className="flex-1 text-[11px] py-1.5 rounded-lg bg-henry-surface text-henry-text hover:bg-henry-surface/80 transition-all">
                      Edit
                    </button>
                    <button onClick={() => askHenry(`Tell me about my "${m.name}" (${tm.label}). What should I check or maintain on it next?`)}
                      className="flex-1 text-[11px] py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all">
                      Ask Henry
                    </button>
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
              {editing.created_at ? 'Edit machine' : 'Add machine'}
            </h2>

            <div className="space-y-3">
              <Field label="Name (required)">
                <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}
                  placeholder='e.g., "Bambu X1C", "Glowforge Pro", "Shapeoko 4 XXL"'
                  className={inputCls} />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Type">
                  <select value={editing.machine_type} onChange={e => setEditing({ ...editing, machine_type: e.target.value as MachineType })}
                    className={inputCls}>
                    {MACHINE_TYPES.map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
                  </select>
                </Field>
                <Field label="Status">
                  <select value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value as MachineStatus })}
                    className={inputCls}>
                    {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Brand">
                  <input value={editing.brand || ''} onChange={e => setEditing({ ...editing, brand: e.target.value })}
                    placeholder="Bambu, Glowforge, Carbide3D…" className={inputCls} />
                </Field>
                <Field label="Model">
                  <input value={editing.model || ''} onChange={e => setEditing({ ...editing, model: e.target.value })}
                    placeholder="X1C, Pro, 4 XXL…" className={inputCls} />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="$ / hour (for cost calc)">
                  <input type="number" min={0} step={0.5} value={editing.hourly_rate ?? 0}
                    onChange={e => setEditing({ ...editing, hourly_rate: Number(e.target.value) })}
                    className={inputCls} />
                </Field>
                <Field label="Power draw (watts)">
                  <input type="number" min={0} value={editing.power_watts ?? 0}
                    onChange={e => setEditing({ ...editing, power_watts: Number(e.target.value) })}
                    className={inputCls} />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Connection">
                  <select value={editing.connection_type || 'manual'} onChange={e => setEditing({ ...editing, connection_type: e.target.value as ConnectionType })}
                    className={inputCls}>
                    <option value="manual">Manual (no connection)</option>
                    <option value="usb-serial">USB / Serial</option>
                    <option value="network">Network / WiFi</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </Field>
                <Field label="Connection address">
                  <input value={editing.connection_address || ''} onChange={e => setEditing({ ...editing, connection_address: e.target.value })}
                    placeholder="/dev/tty… or 192.168.x.x" className={inputCls + ' font-mono text-xs'} />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Purchase date">
                  <input type="date" value={editing.purchase_date || ''} onChange={e => setEditing({ ...editing, purchase_date: e.target.value })}
                    className={inputCls} />
                </Field>
                <Field label="Purchase cost ($)">
                  <input type="number" min={0} step={0.01} value={editing.purchase_cost ?? ''}
                    onChange={e => setEditing({ ...editing, purchase_cost: e.target.value === '' ? undefined : Number(e.target.value) })}
                    className={inputCls} />
                </Field>
              </div>

              <Field label="Next maintenance">
                <input type="date" value={editing.next_maintenance_at?.slice(0, 10) || ''}
                  onChange={e => setEditing({ ...editing, next_maintenance_at: e.target.value || undefined })}
                  className={inputCls} />
              </Field>

              <Field label="Notes">
                <textarea value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })}
                  rows={3} className={inputCls + ' resize-none'} />
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
