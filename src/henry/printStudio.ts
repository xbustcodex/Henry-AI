/**
 * Print Studio — Henry's 3D-print data layer.
 *
 * Backed by SQLite via IPC (durable). Uses localStorage as a fast read cache.
 * On first load, migrates any pre-existing localStorage data into SQLite.
 *
 * Public API stays sync (loadJobs/loadSpools/loadBOM) so existing callers
 * don't need to await — but every save fires a write-through to SQLite.
 *
 * Note: this file is now a thin compatibility shim. Going forward, prefer
 * the maker-studio API on window.henryAPI (makerMachinesList, makerMaterialsList,
 * makerRunsList, etc.) — it covers lasers, CNC, embroidery, vinyl, and more.
 */

import { log } from './log';

export type FilamentMaterial = 'PLA' | 'PETG' | 'ABS' | 'ASA' | 'TPU' | 'Nylon' | 'Resin' | 'Other';
export type BOMStatus = 'needed' | 'ordered' | 'in-hand' | 'used';

export interface PrintJob {
  id: string;
  name: string;
  date: string;
  material: string;
  color?: string;
  filamentSpoolId?: string;
  durationMinutes?: number;
  layerHeight?: number;
  infillPercent?: number;
  success: boolean;
  notes?: string;
  createdAt: string;
}

export interface FilamentSpool {
  id: string;
  brand: string;
  material: FilamentMaterial;
  color: string;
  colorHex?: string;
  weightGrams: number;
  remainingPercent: number;
  purchaseDate?: string;
  notes?: string;
}

export interface BOMItem {
  id: string;
  projectName: string;
  component: string;
  quantity: number;
  unit: string;
  source?: string;
  unitCost?: number;
  status: BOMStatus;
  notes?: string;
  createdAt: string;
}

const JOBS_KEY = 'henry:print:jobs';
const SPOOLS_KEY = 'henry:print:spools';
const BOM_KEY = 'henry:print:bom';
const MIGRATED_FLAG = 'henry:print:migrated_v2';

function load<T>(key: string): T[] {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function save<T>(key: string, items: T[]) {
  try { localStorage.setItem(key, JSON.stringify(items)); } catch { /* ignore quota */ }
}

// ── Write-through helpers ────────────────────────────────────────────────
// Fire-and-forget: cache to localStorage immediately, persist to SQLite async.
// If IPC is unavailable (web mode), localStorage is the durable layer.

function api(): Record<string, (...args: unknown[]) => Promise<unknown>> | null {
  return (typeof window !== 'undefined' && (window as unknown as { henryAPI?: unknown }).henryAPI)
    ? (window as unknown as { henryAPI: Record<string, (...args: unknown[]) => Promise<unknown>> }).henryAPI
    : null;
}

function writeThroughSpool(s: FilamentSpool) {
  const a = api(); if (!a?.makerMaterialsSave) return;
  const remaining = (s.weightGrams || 1000) * (s.remainingPercent || 100) / 100;
  void a.makerMaterialsSave({
    id: s.id,
    name: `${s.brand} ${s.material} ${s.color}`.trim(),
    category: 'filament',
    brand: s.brand,
    color: s.color,
    color_hex: s.colorHex || null,
    specs: `${s.material} ${s.weightGrams}g spool`,
    unit: 'g',
    quantity_total: Math.round(remaining),
    purchase_date: s.purchaseDate || null,
    notes: s.notes || null,
  });
}

function writeThroughJob(j: PrintJob) {
  const a = api(); if (!a?.makerRunsSave) return;
  const payload = {
    material: j.material, layerHeight: j.layerHeight,
    infillPercent: j.infillPercent, color: j.color,
    filamentSpoolId: j.filamentSpoolId,
  };
  void a.makerRunsSave({
    id: j.id,
    name: j.name,
    started_at: j.date,
    completed_at: j.date,
    duration_minutes: j.durationMinutes,
    success: j.success,
    payload,
    notes: j.notes,
    created_at: j.createdAt,
  });
}

function writeThroughBOM(b: BOMItem) {
  const a = api(); if (!a?.makerBomSave) return;
  void a.makerBomSave({
    id: b.id,
    project_name: b.projectName,
    component: b.component,
    quantity: b.quantity,
    unit: b.unit,
    source: b.source,
    unit_cost: b.unitCost,
    status: b.status,
    notes: b.notes,
    created_at: b.createdAt,
  });
}

function writeThroughDeleteSpool(id: string) {
  const a = api(); if (!a?.makerMaterialsDelete) return;
  void a.makerMaterialsDelete(id);
}
function writeThroughDeleteJob(id: string) {
  const a = api(); if (!a?.makerRunsDelete) return;
  void a.makerRunsDelete(id);
}
function writeThroughDeleteBOM(id: string) {
  const a = api(); if (!a?.makerBomDelete) return;
  void a.makerBomDelete(id);
}

// ── One-shot migration: localStorage → SQLite ────────────────────────────
// Runs once per device. Idempotent. Safe to call repeatedly.
export async function migratePrintStudioToSQLite(): Promise<{ migrated: boolean; counts?: unknown }> {
  if (typeof localStorage === 'undefined') return { migrated: false };
  if (localStorage.getItem(MIGRATED_FLAG) === '1') return { migrated: false };
  const a = api();
  if (!a?.makerMigrateFromLocalStorage) return { migrated: false };

  const data = {
    spools: load<FilamentSpool>(SPOOLS_KEY),
    jobs: load<PrintJob>(JOBS_KEY),
    bom: load<BOMItem>(BOM_KEY),
  };
  if (!data.spools.length && !data.jobs.length && !data.bom.length) {
    localStorage.setItem(MIGRATED_FLAG, '1');
    return { migrated: false };
  }
  try {
    const result = await a.makerMigrateFromLocalStorage(data) as { ok?: boolean; migrated?: unknown };
    if (result?.ok) {
      localStorage.setItem(MIGRATED_FLAG, '1');
      log.debug('[Henry] Print Studio migrated to SQLite:', result.migrated);
      return { migrated: true, counts: result.migrated };
    }
  } catch (e) { console.warn('[Henry] Print Studio migration failed:', e); }
  return { migrated: false };
}

// Auto-run migration on module load (once per session, idempotent inside).
if (typeof window !== 'undefined') {
  setTimeout(() => { void migratePrintStudioToSQLite(); }, 1500);
}

// ── Public sync API (unchanged signatures — callers don't need to update) ─
export const loadJobs = () => load<PrintJob>(JOBS_KEY);
export const loadSpools = () => load<FilamentSpool>(SPOOLS_KEY);
export const loadBOM = () => load<BOMItem>(BOM_KEY);

export function saveJob(j: PrintJob) {
  const all = loadJobs();
  const idx = all.findIndex((x) => x.id === j.id);
  if (idx >= 0) all[idx] = j; else all.unshift(j);
  save(JOBS_KEY, all);
  writeThroughJob(j);
}
export function deleteJob(id: string) {
  save(JOBS_KEY, loadJobs().filter((j) => j.id !== id));
  writeThroughDeleteJob(id);
}

export function saveSpool(s: FilamentSpool) {
  const all = loadSpools();
  const idx = all.findIndex((x) => x.id === s.id);
  if (idx >= 0) all[idx] = s; else all.unshift(s);
  save(SPOOLS_KEY, all);
  writeThroughSpool(s);
}
export function deleteSpool(id: string) {
  save(SPOOLS_KEY, loadSpools().filter((s) => s.id !== id));
  writeThroughDeleteSpool(id);
}

export function saveBOMItem(b: BOMItem) {
  const all = loadBOM();
  const idx = all.findIndex((x) => x.id === b.id);
  if (idx >= 0) all[idx] = b; else all.unshift(b);
  save(BOM_KEY, all);
  writeThroughBOM(b);
}
export function deleteBOMItem(id: string) {
  save(BOM_KEY, loadBOM().filter((b) => b.id !== id));
  writeThroughDeleteBOM(id);
}

export function newJob(): PrintJob {
  return { id: `job_${Date.now()}`, name: '', date: new Date().toISOString().slice(0, 10), material: 'PLA', success: true, createdAt: new Date().toISOString() };
}
export function newSpool(): FilamentSpool {
  return { id: `spool_${Date.now()}`, brand: '', material: 'PLA', color: '', weightGrams: 1000, remainingPercent: 100 };
}
export function newBOMItem(projectName = ''): BOMItem {
  return { id: `bom_${Date.now()}`, projectName, component: '', quantity: 1, unit: 'pcs', status: 'needed', createdAt: new Date().toISOString() };
}

export const MATERIAL_COLORS: Record<FilamentMaterial, string> = {
  PLA: 'text-emerald-400', PETG: 'text-sky-400', ABS: 'text-amber-400',
  ASA: 'text-orange-400', TPU: 'text-violet-400', Nylon: 'text-cyan-400',
  Resin: 'text-rose-400', Other: 'text-henry-text-muted',
};

export const BOM_STATUS_META: Record<BOMStatus, { label: string; color: string }> = {
  needed: { label: 'Needed', color: 'text-henry-error bg-henry-error/10' },
  ordered: { label: 'Ordered', color: 'text-amber-400 bg-amber-400/10' },
  'in-hand': { label: 'In hand', color: 'text-emerald-400 bg-emerald-400/10' },
  used: { label: 'Used', color: 'text-henry-text-muted bg-henry-surface' },
};

/** Build a context string about the print studio for Henry's system prompt */
export function buildPrintStudioContext(): string {
  const spools = loadSpools();
  if (!spools.length) return '';
  const spoolSummary = spools.map((s) => `${s.brand} ${s.material} ${s.color} (${s.remainingPercent}% remaining)`).join(', ');
  const jobs = loadJobs();
  const lastJob = jobs[0];
  return `3D Print Studio: ${spools.length} filament spool(s) available: ${spoolSummary}.${lastJob ? ` Last print: "${lastJob.name}" on ${lastJob.date}.` : ''}`;
}
