import { useState, useCallback, useEffect } from 'react';
import {
  loadJobs, loadSpools, loadBOM, saveJob, saveSpool, saveBOMItem,
  deleteJob, deleteSpool, deleteBOMItem, newJob, newSpool, newBOMItem,
  MATERIAL_COLORS, BOM_STATUS_META,
  type PrintJob, type FilamentSpool, type BOMItem, type FilamentMaterial, type BOMStatus,
} from '../../henry/printStudio';
import { useStore } from '../../store';
import { henryQuickAsk } from '../../henry/henryQuickAsk';
import ModelGenerator from './ModelGenerator';

type Tab = 'gallery' | 'filament' | 'bom' | '3d';

const MATERIALS: FilamentMaterial[] = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'Nylon', 'Resin', 'Other'];

export default function PrintStudioPanel() {
  const { setCurrentView } = useStore();
  const [tab, setTab] = useState<Tab>('gallery');
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [spools, setSpools] = useState<FilamentSpool[]>([]);
  const [bom, setBOM] = useState<BOMItem[]>([]);
  const [editingJob, setEditingJob] = useState<PrintJob | null>(null);
  const [editingSpool, setEditingSpool] = useState<FilamentSpool | null>(null);
  const [editingBOM, setEditingBOM] = useState<BOMItem | null>(null);
  const [bomProject, setBomProject] = useState('');

  const reload = useCallback(() => {
    setJobs(loadJobs());
    setSpools(loadSpools());
    setBOM(loadBOM());
  }, []);

  useEffect(() => { reload(); }, [reload]);

  function askHenry(context: string, prompt: string) {
    window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode: 'design3d', prompt: context + '\n\n' + prompt } }));
    setCurrentView('chat');
  }

  function slicerAdvice() {
    const spoolList = spools.map((s) => `${s.brand} ${s.material} ${s.color} (${s.remainingPercent}% left)`).join(', ');
    askHenry(
      `My available filament: ${spoolList || 'not specified'}.`,
      `What slicer settings should I use for a functional print today? Give me layer height, infill, temperature, and supports guidance based on what I have.`
    );
  }

  const bomProjects = [...new Set(bom.map((b) => b.projectName).filter(Boolean))];

  // --- Edit handlers ---
  function saveJobEdit() {
    if (!editingJob || !editingJob.name.trim()) return;
    saveJob(editingJob);
    setEditingJob(null);
    reload();
  }
  function saveSpoolEdit() {
    if (!editingSpool || !editingSpool.brand.trim() || !editingSpool.color.trim()) return;
    saveSpool(editingSpool);
    setEditingSpool(null);
    reload();
  }
  function saveBOMEdit() {
    if (!editingBOM || !editingBOM.component.trim()) return;
    saveBOMItem(editingBOM);
    setEditingBOM(null);
    reload();
  }

  return (
    <div className="flex h-full bg-henry-bg">
      <div className="flex flex-col flex-1 min-h-0">
        {/* Header */}
        <div className="p-6 border-b border-henry-border/30">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center justify-between w-full">
                <h1 className="text-xl font-semibold text-henry-text">Print Studio</h1>
                <button
                  onClick={() => henryQuickAsk({
                    prompt: 'Help me with my 3D print. I need a good prompt or settings for printing. Ask me what I want to make and help me set it up right.',
                    mode: 'design3d',
                  })}
                  className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all"
                >🧠 Ask Henry</button>
              </div>
              <p className="text-xs text-henry-text-muted mt-0.5">
                {jobs.length} prints · {spools.length} spools · {bom.length} BOM items
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={slicerAdvice} className="px-3 py-1.5 text-xs bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-lg hover:bg-rose-500/20 transition-colors">
                🖨️ Slicer Advice
              </button>
              <button
                onClick={() => {
                  if (tab === 'gallery') setEditingJob(newJob());
                  else if (tab === 'filament') setEditingSpool(newSpool());
                  else setEditingBOM(newBOMItem(bomProject));
                }}
                className="px-4 py-2 bg-henry-accent text-henry-bg rounded-xl text-xs font-semibold hover:bg-henry-accent/90 transition-colors"
              >
                + Add {tab === 'gallery' ? 'Print' : tab === 'filament' ? 'Spool' : 'Item'}
              </button>
            </div>
          </div>
          <div className="flex gap-1">
            {(['gallery', 'filament', 'bom'] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${tab === t ? 'bg-henry-accent/15 text-henry-accent' : 'text-henry-text-muted hover:text-henry-text'}`}>
                {t === 'gallery' ? '🖼️ Gallery' : t === 'filament' ? '🎞️ Filament' : '🔩 BOM'}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Gallery */}
          {tab === 'gallery' && (
            <div>
              {jobs.length === 0 ? (
                <EmptyState icon="🖼️" label="No prints logged yet" action="Log your first print" onAction={() => setEditingJob(newJob())} />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {jobs.map((j) => (
                    <div key={j.id} className="group bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4 hover:border-henry-border/60 transition-colors">
                      <div className="flex items-start justify-between mb-2">
                        <div className="w-10 h-10 rounded-xl bg-rose-500/15 flex items-center justify-center text-xl">{j.success ? '✅' : '❌'}</div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => setEditingJob({ ...j })} className="p-1 text-henry-text-dim hover:text-henry-text text-sm">✏️</button>
                          <button onClick={() => { deleteJob(j.id); reload(); }} className="p-1 text-henry-text-dim hover:text-henry-error text-sm">✕</button>
                        </div>
                      </div>
                      <p className="text-sm font-semibold text-henry-text">{j.name}</p>
                      <p className="text-xs text-henry-text-muted mt-0.5">{j.date}</p>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium bg-henry-surface ${MATERIAL_COLORS[j.material as FilamentMaterial] || 'text-henry-text-muted'}`}>{j.material}</span>
                        {j.color && <span className="text-[10px] px-1.5 py-0.5 rounded bg-henry-surface text-henry-text-muted">{j.color}</span>}
                        {j.durationMinutes && <span className="text-[10px] px-1.5 py-0.5 rounded bg-henry-surface text-henry-text-dim">{Math.round(j.durationMinutes / 60)}h {j.durationMinutes % 60}m</span>}
                        {j.layerHeight && <span className="text-[10px] px-1.5 py-0.5 rounded bg-henry-surface text-henry-text-dim">{j.layerHeight}mm layers</span>}
                        {j.infillPercent && <span className="text-[10px] px-1.5 py-0.5 rounded bg-henry-surface text-henry-text-dim">{j.infillPercent}% infill</span>}
                      </div>
                      {j.notes && <p className="text-xs text-henry-text-dim mt-2">{j.notes}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Filament */}
          {tab === 'filament' && (
            <div>
              {spools.length === 0 ? (
                <EmptyState icon="🎞️" label="No filament tracked yet" action="Add your first spool" onAction={() => setEditingSpool(newSpool())} />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {spools.map((s) => (
                    <div key={s.id} className="group bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4 hover:border-henry-border/60 transition-colors">
                      <div className="flex items-start justify-between mb-3">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ backgroundColor: s.colorHex ? s.colorHex + '30' : undefined }}>
                          🎞️
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => setEditingSpool({ ...s })} className="p-1 text-henry-text-dim hover:text-henry-text text-sm">✏️</button>
                          <button onClick={() => { deleteSpool(s.id); reload(); }} className="p-1 text-henry-text-dim hover:text-henry-error text-sm">✕</button>
                        </div>
                      </div>
                      <p className="text-sm font-semibold text-henry-text">{s.brand}</p>
                      <p className={`text-xs font-medium ${MATERIAL_COLORS[s.material]}`}>{s.material} · {s.color}</p>
                      <div className="mt-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-henry-text-dim">Remaining</span>
                          <span className={`text-[10px] font-semibold ${s.remainingPercent < 20 ? 'text-henry-error' : s.remainingPercent < 50 ? 'text-amber-400' : 'text-emerald-400'}`}>{s.remainingPercent}%</span>
                        </div>
                        <div className="h-1.5 bg-henry-bg rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${s.remainingPercent < 20 ? 'bg-henry-error' : s.remainingPercent < 50 ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${s.remainingPercent}%` }} />
                        </div>
                      </div>
                      <p className="text-[10px] text-henry-text-dim mt-1">{s.weightGrams}g spool</p>
                      {s.notes && <p className="text-xs text-henry-text-dim mt-2">{s.notes}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* BOM */}
          {tab === 'bom' && (
            <div>
              {/* Project filter */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <button onClick={() => setBomProject('')} className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${!bomProject ? 'bg-henry-accent/15 text-henry-accent' : 'text-henry-text-muted hover:text-henry-text'}`}>All</button>
                {bomProjects.map((p) => (
                  <button key={p} onClick={() => setBomProject(p)} className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${bomProject === p ? 'bg-henry-accent/15 text-henry-accent' : 'text-henry-text-muted hover:text-henry-text'}`}>{p}</button>
                ))}
              </div>
              {bom.length === 0 ? (
                <EmptyState icon="🔩" label="No BOM items yet" action="Add your first item" onAction={() => setEditingBOM(newBOMItem())} />
              ) : (
                <div className="space-y-2">
                  {bom.filter((b) => !bomProject || b.projectName === bomProject).map((b) => (
                    <div key={b.id} className="group flex items-center gap-3 p-3 bg-henry-surface/40 rounded-xl border border-henry-border/20 hover:border-henry-border/40 transition-colors">
                      <span className={`text-[10px] px-2 py-1 rounded-full font-medium shrink-0 ${BOM_STATUS_META[b.status].color}`}>{BOM_STATUS_META[b.status].label}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-henry-text">{b.component}</p>
                        <p className="text-[10px] text-henry-text-dim">{b.quantity} {b.unit}{b.projectName ? ` · ${b.projectName}` : ''}{b.source ? ` · ${b.source}` : ''}{b.unitCost ? ` · $${(b.unitCost * b.quantity).toFixed(2)}` : ''}</p>
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* Quick status cycle */}
                        <select value={b.status} onChange={(e) => { saveBOMItem({ ...b, status: e.target.value as BOMStatus }); reload(); }}
                          className="text-[10px] bg-henry-bg border border-henry-border/40 rounded px-1 py-0.5 text-henry-text-muted">
                          {(Object.keys(BOM_STATUS_META) as BOMStatus[]).map((s) => <option key={s} value={s}>{BOM_STATUS_META[s].label}</option>)}
                        </select>
                        <button onClick={() => setEditingBOM({ ...b })} className="p-1 text-henry-text-dim hover:text-henry-text text-sm">✏️</button>
                        <button onClick={() => { deleteBOMItem(b.id); reload(); }} className="p-1 text-henry-text-dim hover:text-henry-error text-sm">✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
      {tab === '3d' && <ModelGenerator />}

        </div>
      </div>

      {/* Edit panels */}
      {editingJob && (
        <EditPanel title={jobs.some((j) => j.id === editingJob.id) ? 'Edit Print' : 'Log a Print'} onClose={() => setEditingJob(null)} onSave={saveJobEdit} disabled={!editingJob.name.trim()}>
          <Field label="Print name *"><input autoFocus value={editingJob.name} onChange={(e) => setEditingJob({ ...editingJob, name: e.target.value })} placeholder="What did you print?" className={INPUT_CLS} /></Field>
          <Field label="Date"><input type="date" value={editingJob.date} onChange={(e) => setEditingJob({ ...editingJob, date: e.target.value })} className={INPUT_CLS} /></Field>
          <Field label="Material">
            <select value={editingJob.material} onChange={(e) => setEditingJob({ ...editingJob, material: e.target.value })} className={INPUT_CLS}>
              {MATERIALS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Color"><input value={editingJob.color || ''} onChange={(e) => setEditingJob({ ...editingJob, color: e.target.value })} placeholder="White, Black..." className={INPUT_CLS} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration (min)"><input type="number" value={editingJob.durationMinutes || ''} onChange={(e) => setEditingJob({ ...editingJob, durationMinutes: parseInt(e.target.value) || undefined })} placeholder="0" className={INPUT_CLS} /></Field>
            <Field label="Layer height (mm)"><input type="number" step="0.05" value={editingJob.layerHeight || ''} onChange={(e) => setEditingJob({ ...editingJob, layerHeight: parseFloat(e.target.value) || undefined })} placeholder="0.2" className={INPUT_CLS} /></Field>
          </div>
          <Field label="Infill %"><input type="number" value={editingJob.infillPercent || ''} onChange={(e) => setEditingJob({ ...editingJob, infillPercent: parseInt(e.target.value) || undefined })} placeholder="20" className={INPUT_CLS} /></Field>
          <div>
            <label className="block text-xs text-henry-text-muted mb-1">Outcome</label>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setEditingJob({ ...editingJob, success: true })} className={`py-2 rounded-lg text-xs border transition-colors ${editingJob.success ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'}`}>✅ Success</button>
              <button onClick={() => setEditingJob({ ...editingJob, success: false })} className={`py-2 rounded-lg text-xs border transition-colors ${!editingJob.success ? 'bg-henry-error/15 border-henry-error/30 text-henry-error' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'}`}>❌ Failed</button>
            </div>
          </div>
          <Field label="Notes"><textarea value={editingJob.notes || ''} onChange={(e) => setEditingJob({ ...editingJob, notes: e.target.value })} rows={3} placeholder="What happened? What to try next time?" className={INPUT_CLS + ' resize-none'} /></Field>
          {jobs.some((j) => j.id === editingJob.id) && <DeleteBtn onClick={() => { deleteJob(editingJob.id); setEditingJob(null); reload(); }} />}
        </EditPanel>
      )}
      {editingSpool && (
        <EditPanel title="Filament Spool" onClose={() => setEditingSpool(null)} onSave={saveSpoolEdit} disabled={!editingSpool.brand.trim() || !editingSpool.color.trim()}>
          <Field label="Brand *"><input autoFocus value={editingSpool.brand} onChange={(e) => setEditingSpool({ ...editingSpool, brand: e.target.value })} placeholder="Hatchbox, Bambu, SUNLU..." className={INPUT_CLS} /></Field>
          <Field label="Material">
            <select value={editingSpool.material} onChange={(e) => setEditingSpool({ ...editingSpool, material: e.target.value as FilamentMaterial })} className={INPUT_CLS}>
              {MATERIALS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Color *"><input value={editingSpool.color} onChange={(e) => setEditingSpool({ ...editingSpool, color: e.target.value })} placeholder="Silk White, Galaxy Black..." className={INPUT_CLS} /></Field>
          <Field label="Color (hex)"><input type="color" value={editingSpool.colorHex || '#888888'} onChange={(e) => setEditingSpool({ ...editingSpool, colorHex: e.target.value })} className="w-12 h-10 rounded cursor-pointer border-0 bg-transparent" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Spool weight (g)"><input type="number" value={editingSpool.weightGrams} onChange={(e) => setEditingSpool({ ...editingSpool, weightGrams: parseInt(e.target.value) || 1000 })} className={INPUT_CLS} /></Field>
            <Field label="Remaining %"><input type="number" min="0" max="100" value={editingSpool.remainingPercent} onChange={(e) => setEditingSpool({ ...editingSpool, remainingPercent: Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) })} className={INPUT_CLS} /></Field>
          </div>
          <Field label="Notes"><input value={editingSpool.notes || ''} onChange={(e) => setEditingSpool({ ...editingSpool, notes: e.target.value })} placeholder="Any notes..." className={INPUT_CLS} /></Field>
          {spools.some((s) => s.id === editingSpool.id) && <DeleteBtn onClick={() => { deleteSpool(editingSpool.id); setEditingSpool(null); reload(); }} />}
        </EditPanel>
      )}
      {editingBOM && (
        <EditPanel title="BOM Item" onClose={() => setEditingBOM(null)} onSave={saveBOMEdit} disabled={!editingBOM.component.trim()}>
          <Field label="Component *"><input autoFocus value={editingBOM.component} onChange={(e) => setEditingBOM({ ...editingBOM, component: e.target.value })} placeholder="e.g. M3 heat inserts" className={INPUT_CLS} /></Field>
          <Field label="Project"><input value={editingBOM.projectName} onChange={(e) => setEditingBOM({ ...editingBOM, projectName: e.target.value })} placeholder="Project name" className={INPUT_CLS} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity"><input type="number" value={editingBOM.quantity} onChange={(e) => setEditingBOM({ ...editingBOM, quantity: parseInt(e.target.value) || 1 })} className={INPUT_CLS} /></Field>
            <Field label="Unit"><input value={editingBOM.unit} onChange={(e) => setEditingBOM({ ...editingBOM, unit: e.target.value })} placeholder="pcs, kg, m..." className={INPUT_CLS} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Source"><input value={editingBOM.source || ''} onChange={(e) => setEditingBOM({ ...editingBOM, source: e.target.value })} placeholder="Amazon, DigiKey..." className={INPUT_CLS} /></Field>
            <Field label="Unit cost ($)"><input type="number" step="0.01" value={editingBOM.unitCost || ''} onChange={(e) => setEditingBOM({ ...editingBOM, unitCost: parseFloat(e.target.value) || undefined })} placeholder="0.00" className={INPUT_CLS} /></Field>
          </div>
          <div>
            <label className="block text-xs text-henry-text-muted mb-1">Status</label>
            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(BOM_STATUS_META) as BOMStatus[]).map((s) => (
                <button key={s} onClick={() => setEditingBOM({ ...editingBOM, status: s })}
                  className={`py-2 rounded-lg text-xs border transition-colors ${editingBOM.status === s ? 'bg-henry-accent/15 border-henry-accent/40 text-henry-accent' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'}`}>
                  {BOM_STATUS_META[s].label}
                </button>
              ))}
            </div>
          </div>
          <Field label="Notes"><input value={editingBOM.notes || ''} onChange={(e) => setEditingBOM({ ...editingBOM, notes: e.target.value })} placeholder="Any notes..." className={INPUT_CLS} /></Field>
          {bom.some((b) => b.id === editingBOM.id) && <DeleteBtn onClick={() => { deleteBOMItem(editingBOM.id); setEditingBOM(null); reload(); }} />}
        </EditPanel>
      )}
    </div>
  );
}

const INPUT_CLS = 'w-full bg-henry-bg border border-henry-border/50 rounded-lg px-3 py-2 text-sm text-henry-text placeholder-henry-text-dim focus:outline-none focus:border-henry-accent/50';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-henry-text-muted mb-1">{label}</label>
      {children}
    </div>
  );
}

function DeleteBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full py-2.5 text-henry-error hover:bg-henry-error/10 rounded-xl text-sm transition-colors border border-henry-error/20">Delete</button>
  );
}

function EditPanel({ title, onClose, onSave, disabled, children }: {
  title: string; onClose: () => void; onSave: () => void; disabled: boolean; children: React.ReactNode;
}) {
  return (
    <div className="w-full md:w-80 border-l border-henry-border/30 bg-henry-surface/50 flex flex-col">
      <div className="p-4 border-b border-henry-border/30 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-henry-text">{title}</h2>
        <button onClick={onClose} className="text-henry-text-dim hover:text-henry-text text-lg leading-none">×</button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">{children}</div>
      <div className="p-4 border-t border-henry-border/30">
        <button onClick={onSave} disabled={disabled} className="w-full py-2.5 bg-henry-accent text-henry-bg rounded-xl text-sm font-semibold hover:bg-henry-accent/90 disabled:opacity-40 transition-colors">Save</button>
      </div>
    </div>
  );
}

function EmptyState({ icon, label, action, onAction }: { icon: string; label: string; action: string; onAction: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-40 text-henry-text-dim">
      <span className="text-3xl mb-2">{icon}</span>
      <p className="text-sm">{label}</p>
      <button onClick={onAction} className="mt-3 text-henry-accent text-xs hover:underline">{action}</button>
    </div>
  );
}
