/**
 * SlicerPanel — P1 of the slicer (slicer plan). Configure the CuraEngine binary,
 * slice an STL/3MF/OBJ, and see the time + filament estimate. The engine is a
 * proven open-source slicer Henry drives as a subprocess; Henry's AI-assisted
 * profiles + send-to-printer come in later phases.
 *
 * The engine binary + definitions live on the Mac and are configured here once.
 */

import { useCallback, useEffect, useState } from 'react';
import SendToPrinter from './SendToPrinter';
import GcodePreview from './GcodePreview';

interface Status {
  available: boolean;
  missing: string[];
  version?: string;
  enginePath?: string;
  definitionsDir?: string;
  printerDef?: string;
}

function api() {
  return typeof window !== 'undefined' ? window.henryAPI : undefined;
}

function fmtTime(sec?: number): string {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const input = 'w-full bg-henry-surface border border-henry-border/30 rounded-lg px-2.5 py-1.5 text-xs text-henry-text font-mono outline-none focus:border-henry-accent/50';

/**
 * Expert tuning intents — plain-English goals mapped to concrete CuraEngine
 * settings, with the trade-off spelled out. Curated (not a model guessing keys),
 * so a tune can never produce a nonsense setting.
 */
interface TuneIntent {
  id: string;
  label: string;
  deltas: Record<string, string>;
  why: string;
}
const TUNE_INTENTS: TuneIntent[] = [
  { id: 'stronger', label: 'Stronger', deltas: { wall_line_count: '4', infill_sparse_density: '40', infill_pattern: 'gyroid' }, why: '4 walls + 40% gyroid infill. Trade-off: more filament and time.' },
  { id: 'lighter', label: 'Use less filament', deltas: { infill_sparse_density: '8', wall_line_count: '2', infill_pattern: 'lightning' }, why: 'Lightning infill + thin walls use the least plastic. Trade-off: weaker part.' },
  { id: 'faster', label: 'Faster', deltas: { layer_height: '0.28', speed_print: '80', infill_sparse_density: '12' }, why: 'Thicker layers, higher speed, lighter infill. Trade-off: coarser finish.' },
  { id: 'finer', label: 'Finer detail', deltas: { layer_height: '0.12' }, why: 'Thin 0.12mm layers for crisp detail. Trade-off: much slower.' },
  { id: 'overhangs', label: 'Better overhangs', deltas: { support_enable: 'true', support_angle: '50', cool_min_layer_time: '8' }, why: 'Supports + extra cooling hold up steep overhangs.' },
  { id: 'adhesion', label: 'Stick better', deltas: { adhesion_type: 'brim', brim_width: '5' }, why: 'A 5mm brim grips the bed so corners do not lift.' },
];

export default function SlicerPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);

  // setup fields
  const [enginePath, setEnginePath] = useState('');
  const [defsDir, setDefsDir] = useState('');
  const [printerDef, setPrinterDef] = useState('');
  const [savingSetup, setSavingSetup] = useState(false);

  // slice fields
  const [modelPath, setModelPath] = useState('');
  const [layerHeight, setLayerHeight] = useState('0.2');
  const [infill, setInfill] = useState('20');
  const [slicing, setSlicing] = useState(false);
  const [result, setResult] = useState<{ gcodePath: string; estimate: { timeSeconds?: number; filamentMm?: number; filamentGrams?: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // profiles
  const [profiles, setProfiles] = useState<HenrySlicerProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [showManage, setShowManage] = useState(false);
  const [npName, setNpName] = useState('');
  const [npMaterial, setNpMaterial] = useState('');
  const [npPrinterDef, setNpPrinterDef] = useState('');
  const [npSettings, setNpSettings] = useState('layer_height=0.2\ninfill_sparse_density=20');

  const loadProfiles = useCallback(async () => {
    const res = await api()?.slicerProfilesList?.();
    if (res?.ok) setProfiles(res.result ?? []);
  }, []);
  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  /** Parse a "key=value" lines textarea into a settings object. */
  const parseSettingsLines = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  };

  const addProfile = useCallback(async () => {
    if (!npName.trim()) return;
    const res = await api()?.slicerProfileCreate?.({
      name: npName.trim(),
      material: npMaterial.trim() || undefined,
      printer_def: npPrinterDef.trim() || undefined,
      settings: parseSettingsLines(npSettings),
    });
    if (res?.ok) {
      setNpName(''); setNpMaterial(''); setNpPrinterDef('');
      await loadProfiles();
    }
  }, [npName, npMaterial, npPrinterDef, npSettings, loadProfiles]);

  const deleteProfile = useCallback(async (id: string) => {
    await api()?.slicerProfileDelete?.(id);
    if (profileId === id) setProfileId('');
    await loadProfiles();
  }, [profileId, loadProfiles]);

  // tuning — overrides merged on top of the base/profile settings at slice time
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [tuneLog, setTuneLog] = useState<string[]>([]);
  const applyIntent = useCallback((intent: TuneIntent) => {
    setOverrides((cur) => ({ ...cur, ...intent.deltas }));
    setTuneLog((cur) => [`${intent.label}: ${intent.why}`, ...cur].slice(0, 6));
  }, []);
  const clearTuning = useCallback(() => { setOverrides({}); setTuneLog([]); }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api()?.slicerStatus?.();
      if (res?.ok && res.result) {
        setStatus(res.result);
        setEnginePath(res.result.enginePath || '');
        setDefsDir(res.result.definitionsDir || '');
        setPrinterDef(res.result.printerDef || '');
      } else {
        setStatus(null);
        setError(res?.error || 'Slicer is only available in the desktop app.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveSetup = useCallback(async () => {
    setSavingSetup(true);
    try {
      await api()?.saveSetting?.('slicer_engine_path', enginePath.trim());
      await api()?.saveSetting?.('slicer_definitions_dir', defsDir.trim());
      await api()?.saveSetting?.('slicer_printer_def', printerDef.trim());
      await refresh();
    } finally {
      setSavingSetup(false);
    }
  }, [enginePath, defsDir, printerDef, refresh]);

  const slice = useCallback(async () => {
    if (!modelPath.trim() || slicing) return;
    setSlicing(true);
    setError(null);
    setResult(null);
    try {
      const profile = profiles.find((p) => p.id === profileId);
      let settings: Record<string, string | number> = { layer_height: layerHeight, infill_sparse_density: infill };
      let printerDef: string | undefined;
      if (profile) {
        try { settings = JSON.parse(profile.settings_json || '{}'); } catch { settings = {}; }
        printerDef = profile.printer_def || undefined;
      }
      // Tuning overrides win over the base/profile settings.
      const merged = { ...settings, ...overrides };
      const res = await api()?.slicerSlice?.({ modelPath: modelPath.trim(), settings: merged, printerDef });
      if (res?.ok && res.result) setResult(res.result);
      else setError(res?.error || 'Slice failed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Slice failed.');
    } finally {
      setSlicing(false);
    }
  }, [modelPath, layerHeight, infill, slicing, profiles, profileId, overrides]);

  return (
    <div className="h-full overflow-y-auto bg-henry-bg">
      <div className="max-w-2xl mx-auto px-5 py-6">
        <h1 className="text-xl font-semibold text-henry-text">Slice</h1>
        <p className="text-xs text-henry-text-muted mb-5">
          Turn a 3D model into printer-ready G-code. Henry drives a proven slicing engine (CuraEngine) under the hood.
        </p>

        {loading && <div className="text-sm text-henry-text-muted py-10 text-center">Checking the engine…</div>}

        {!loading && status && !status.available && (
          <div className="bg-henry-surface/40 border border-amber-500/30 rounded-2xl p-4 mb-5">
            <h2 className="text-sm font-semibold text-henry-text">Set up the engine</h2>
            <p className="text-[11px] text-henry-text-muted mt-0.5 mb-3">
              Missing: {status.missing.join(', ')}. Install CuraEngine on this Mac, then point Henry at it.
            </p>
            <div className="space-y-2">
              <label className="block text-[11px] text-henry-text-dim">CuraEngine binary path</label>
              <input className={input} value={enginePath} onChange={(e) => setEnginePath(e.target.value)} placeholder="/opt/homebrew/bin/CuraEngine" />
              <label className="block text-[11px] text-henry-text-dim">Definitions folder</label>
              <input className={input} value={defsDir} onChange={(e) => setDefsDir(e.target.value)} placeholder="…/share/cura/resources/definitions" />
              <label className="block text-[11px] text-henry-text-dim">Printer definition (.def.json)</label>
              <input className={input} value={printerDef} onChange={(e) => setPrinterDef(e.target.value)} placeholder="…/definitions/creality_ender3.def.json" />
              <button onClick={() => void saveSetup()} disabled={savingSetup} className="mt-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 disabled:opacity-40">
                {savingSetup ? 'Saving…' : 'Save & check'}
              </button>
            </div>
          </div>
        )}

        {!loading && status?.available && (
          <>
            <div className="flex items-center gap-2 mb-4 text-[11px] text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Engine ready{status.version ? ` · ${status.version}` : ''}
              <button onClick={() => void refresh()} className="ml-auto text-henry-text-muted hover:text-henry-text">Re-check</button>
            </div>

            <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4 space-y-3">
              <div>
                <label className="block text-[11px] text-henry-text-dim mb-1">Model file (.stl / .3mf / .obj)</label>
                <input className={input} value={modelPath} onChange={(e) => setModelPath(e.target.value)} placeholder="/Users/you/Desktop/part.stl" />
              </div>
              <div>
                <label className="block text-[11px] text-henry-text-dim mb-1">Profile</label>
                <select className={input} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                  <option value="">Manual (layer height + infill below)</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.material ? ` · ${p.material}` : ''}</option>
                  ))}
                </select>
              </div>
              {!profileId && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-henry-text-dim mb-1">Layer height (mm)</label>
                    <input className={input} value={layerHeight} onChange={(e) => setLayerHeight(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-[11px] text-henry-text-dim mb-1">Infill (%)</label>
                    <input className={input} value={infill} onChange={(e) => setInfill(e.target.value)} />
                  </div>
                </div>
              )}
              <div className="border-t border-henry-border/20 pt-3">
                <div className="text-[11px] text-henry-text-dim mb-1.5">Tune <span className="text-henry-text-muted">(applies expert settings — hover for the trade-off)</span></div>
                <div className="flex flex-wrap gap-1.5">
                  {TUNE_INTENTS.map((it) => (
                    <button
                      key={it.id}
                      onClick={() => applyIntent(it)}
                      title={it.why}
                      className="px-2.5 py-1 rounded-full text-[11px] bg-henry-surface text-henry-text-muted hover:text-henry-accent hover:bg-henry-accent/10 transition-colors"
                    >
                      {it.label}
                    </button>
                  ))}
                </div>
                {Object.keys(overrides).length > 0 && (
                  <div className="mt-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(overrides).map(([k, v]) => (
                          <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-henry-accent/10 text-henry-accent font-mono">{k}={v}</span>
                        ))}
                      </div>
                      <button onClick={clearTuning} className="text-[10px] text-henry-text-muted hover:text-henry-text flex-shrink-0">Clear</button>
                    </div>
                    {tuneLog.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {tuneLog.map((l, i) => <li key={i} className="text-[10px] text-henry-text-muted leading-relaxed">• {l}</li>)}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <button onClick={() => void slice()} disabled={slicing || !modelPath.trim()} className="px-4 py-2 rounded-xl text-sm font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 disabled:opacity-40 disabled:cursor-not-allowed">
                {slicing ? 'Slicing…' : 'Slice'}
              </button>
            </div>

            <div className="mt-4">
              <button onClick={() => setShowManage((v) => !v)} className="text-[11px] text-henry-text-muted hover:text-henry-text">
                {showManage ? 'Hide profiles' : 'Manage profiles'}
              </button>
              {showManage && (
                <div className="mt-2 bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4 space-y-3">
                  {profiles.length > 0 && (
                    <div className="space-y-1.5">
                      {profiles.map((p) => (
                        <div key={p.id} className="flex items-center justify-between text-xs">
                          <span className="text-henry-text truncate">{p.name}{p.material ? ` · ${p.material}` : ''}</span>
                          <button onClick={() => void deleteProfile(p.id)} title="Delete profile" className="text-henry-text-muted hover:text-red-400 px-1 flex-shrink-0">✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="border-t border-henry-border/20 pt-3 space-y-2">
                    <div className="text-[11px] text-henry-text-dim">New profile</div>
                    <input className={input} value={npName} onChange={(e) => setNpName(e.target.value)} placeholder="Name — e.g. Ender3 PETG Strong" />
                    <div className="grid grid-cols-2 gap-2">
                      <input className={input} value={npMaterial} onChange={(e) => setNpMaterial(e.target.value)} placeholder="Material (PLA, PETG…)" />
                      <input className={input} value={npPrinterDef} onChange={(e) => setNpPrinterDef(e.target.value)} placeholder="Printer def override (optional)" />
                    </div>
                    <textarea className={input + ' resize-y'} rows={4} value={npSettings} onChange={(e) => setNpSettings(e.target.value)} placeholder="key=value per line, e.g. layer_height=0.2" />
                    <button onClick={() => void addProfile()} disabled={!npName.trim()} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 disabled:opacity-40">Add profile</button>
                  </div>
                </div>
              )}
            </div>

            {error && <div className="mt-4 bg-henry-surface/50 border border-red-500/30 rounded-xl p-3 text-sm text-red-300">{error}</div>}

            {result && (
              <div className="mt-4 bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4">
                <h3 className="text-sm font-semibold text-henry-text mb-2">Sliced ✓</h3>
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Est. print time" value={fmtTime(result.estimate.timeSeconds)} />
                  <Stat label="Filament" value={result.estimate.filamentMm ? `${(result.estimate.filamentMm / 1000).toFixed(2)} m${result.estimate.filamentGrams ? ` · ${result.estimate.filamentGrams} g` : ''}` : '—'} />
                </div>
                <p className="text-[10px] text-henry-text-muted mt-3 font-mono break-all">{result.gcodePath}</p>
                <GcodePreview gcodePath={result.gcodePath} />
                <SendToPrinter gcodePath={result.gcodePath} />
              </div>
            )}
          </>
        )}

        {!loading && !status && error && (
          <div className="bg-henry-surface/50 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">{error}</div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-henry-surface/50 rounded-lg px-3 py-2">
      <div className="text-sm text-henry-text">{value}</div>
      <div className="text-[10px] text-henry-text-muted mt-0.5">{label}</div>
    </div>
  );
}
