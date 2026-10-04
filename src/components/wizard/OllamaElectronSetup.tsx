/**
 * OllamaElectronSetup — Henry installs and launches Ollama automatically.
 *
 * Used in Electron mode only. Detects, downloads, launches, and pulls
 * a starter model with no user intervention beyond picking the model.
 */
import { useState, useEffect, useRef } from 'react';

type SetupPhase =
  | 'checking'
  | 'launching'
  | 'installing'
  | 'pulling'
  | 'pick_model'
  | 'done'
  | 'error';

type StepState = 'pending' | 'active' | 'done' | 'error';

interface Step {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
}

const DEFAULT_MODEL = 'llama3.2';

interface Props {
  onModelReady: (model: string) => void;
  onFallback: () => void; // call if user wants to go back to manual
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '';
  const mb = bytes / 1_000_000;
  return mb < 1000 ? `${mb.toFixed(0)} MB` : `${(mb / 1000).toFixed(1)} GB`;
}

export default function OllamaElectronSetup({ onModelReady, onFallback }: Props) {
  const [phase, setPhase] = useState<SetupPhase>('checking');
  const [steps, setSteps] = useState<Step[]>([
    { id: 'check',    label: 'Checking for Ollama',      state: 'active' },
    { id: 'launch',   label: 'Starting Ollama',           state: 'pending' },
    { id: 'model',    label: 'Pulling a starter model',   state: 'pending' },
    { id: 'ready',    label: 'Henry is ready',            state: 'pending' },
  ]);
  const [downloadProgress, setDownloadProgress] = useState<{ downloaded: number; total: number; message: string } | null>(null);
  const [pullProgress, setPullProgress] = useState<{ completed: number; total: number; status: string } | null>(null);
  const [detectedModels, setDetectedModels] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [binPath, setBinPath] = useState<string | undefined>();
  const started = useRef(false);

  function patchStep(id: string, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  async function getInstalledModels(): Promise<string[]> {
    try {
      const result = await window.henryAPI.ollamaModels?.('http://127.0.0.1:11434');
      return (result?.models ?? []).map((m: any) => m.name || '').filter(Boolean);
    } catch {
      return [];
    }
  }

  async function pullModel(model: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Listen for pull progress
      const unsub = window.henryAPI.onOllamaPullProgress?.((data: any) => {
        if (data.model !== model) return;
        setPullProgress({
          completed: data.completed ?? 0,
          total: data.total ?? 0,
          status: data.status ?? '',
        });
        if (data.status === 'success') {
          unsub?.();
          resolve(true);
        }
      });

      window.henryAPI.ollamaPull?.(model, 'http://127.0.0.1:11434').then((r) => {
        unsub?.();
        resolve(r?.success ?? false);
      });
    });
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, []);

  async function run() {
    const api = window.henryAPI;
    if (!api.ollamaIsInstalled) return; // shouldn't happen in Electron

    // ── Step 1: Check ──────────────────────────────────────────────────────
    setPhase('checking');
    patchStep('check', { state: 'active' });

    const check = await api.ollamaIsInstalled();

    if (check.running) {
      // Already running — just probe models
      patchStep('check', { state: 'done', detail: 'Already running' });
      patchStep('launch', { state: 'done', detail: 'Already running' });
      setBinPath(check.binPath);
      const models = await getInstalledModels();
      if (models.length > 0) {
        patchStep('model', { state: 'done', detail: `${models.length} model${models.length > 1 ? 's' : ''} found` });
        patchStep('ready', { state: 'done' });
        setDetectedModels(models);
        setPhase(models.length === 1 ? 'done' : 'pick_model');
        if (models.length === 1) onModelReady(models[0]);
        return;
      }
      // Running but no models — skip to pull
      patchStep('model', { state: 'active', detail: `Pulling ${DEFAULT_MODEL}…` });
      setPhase('pulling');
      const pulled = await pullModel(DEFAULT_MODEL);
      if (pulled) {
        patchStep('model', { state: 'done', detail: DEFAULT_MODEL });
        patchStep('ready', { state: 'done' });
        setPhase('done');
        onModelReady(DEFAULT_MODEL);
      } else {
        patchStep('model', { state: 'error', detail: 'Pull failed' });
        setPhase('pick_model');
        setDetectedModels([DEFAULT_MODEL]);
      }
      return;
    }

    if (check.installed && check.binPath) {
      // Installed but not running — just launch it
      patchStep('check', { state: 'done', detail: 'Found at ' + check.binPath.replace(/.*\//, '') });
      setBinPath(check.binPath);
      await launchAndContinue(check.binPath);
      return;
    }

    // ── Not installed — download it ───────────────────────────────────────
    patchStep('check', { state: 'done', detail: 'Not found — downloading' });
    patchStep('launch', { state: 'active', detail: 'Downloading Ollama…' });
    setPhase('installing');

    const unsub = api.onOllamaInstallProgress?.((p) => {
      setDownloadProgress({ downloaded: p.downloaded, total: p.total, message: p.message });
      if (p.phase === 'error') {
        patchStep('launch', { state: 'error', detail: p.message });
        setPhase('error');
        setErrorMsg(p.message);
        unsub?.();
      }
    });

    const installResult = await api.ollamaInstall?.();
    unsub?.();

    if (!installResult?.success) {
      patchStep('launch', { state: 'error', detail: installResult?.error ?? 'Install failed' });
      setPhase('error');
      setErrorMsg(installResult?.error ?? 'Download failed.');
      return;
    }

    patchStep('launch', { state: 'done', detail: 'Ollama installed and running' });
    setBinPath(installResult.binPath);
    await pullAndFinish();
  }

  async function launchAndContinue(bin: string) {
    patchStep('launch', { state: 'active', detail: 'Starting…' });
    setPhase('launching');

    const launchResult = await window.henryAPI.ollamaLaunch?.(bin);
    if (!launchResult?.success) {
      patchStep('launch', { state: 'error', detail: launchResult?.error });
      setPhase('error');
      setErrorMsg(launchResult?.error ?? 'Could not start Ollama.');
      return;
    }

    patchStep('launch', { state: 'done' });

    // Check for models
    const models = await getInstalledModels();
    if (models.length > 0) {
      patchStep('model', { state: 'done', detail: `${models.length} model${models.length > 1 ? 's' : ''} found` });
      patchStep('ready', { state: 'done' });
      setDetectedModels(models);
      setPhase(models.length === 1 ? 'done' : 'pick_model');
      if (models.length === 1) onModelReady(models[0]);
    } else {
      await pullAndFinish();
    }
  }

  async function pullAndFinish() {
    patchStep('model', { state: 'active', detail: `Pulling ${DEFAULT_MODEL}…` });
    setPhase('pulling');
    setPullProgress(null);

    const pulled = await pullModel(DEFAULT_MODEL);
    if (pulled) {
      patchStep('model', { state: 'done', detail: DEFAULT_MODEL });
      patchStep('ready', { state: 'done' });
      setPhase('done');
      onModelReady(DEFAULT_MODEL);
    } else {
      patchStep('model', { state: 'error', detail: 'Pull failed — pick manually' });
      setPhase('pick_model');
    }
  }

  async function retryPull(model: string) {
    setPullProgress(null);
    patchStep('model', { state: 'active', detail: `Pulling ${model}…` });
    setPhase('pulling');
    const pulled = await pullModel(model);
    if (pulled) {
      patchStep('model', { state: 'done', detail: model });
      patchStep('ready', { state: 'done' });
      setPhase('done');
      onModelReady(model);
    } else {
      patchStep('model', { state: 'error', detail: 'Pull failed' });
      setPhase('pick_model');
    }
  }

  const pullPct =
    pullProgress && pullProgress.total > 0
      ? Math.round((pullProgress.completed / pullProgress.total) * 100)
      : null;

  const downloadPct =
    downloadProgress && downloadProgress.total > 0
      ? Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)
      : null;

  return (
    <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-6 animate-fade-in">
      {/* Steps */}
      <div className="space-y-3 mb-6">
        {steps.map((step) => (
          <div key={step.id} className="flex items-start gap-3">
            {/* Icon */}
            <div className="mt-0.5 shrink-0">
              {step.state === 'done' && (
                <span className="text-henry-success text-base">✓</span>
              )}
              {step.state === 'active' && (
                <div className="w-4 h-4 border-2 border-henry-accent border-t-transparent rounded-full animate-spin" />
              )}
              {step.state === 'error' && (
                <span className="text-henry-error text-base">✗</span>
              )}
              {step.state === 'pending' && (
                <div className="w-4 h-4 rounded-full border-2 border-henry-border/40" />
              )}
            </div>

            {/* Label */}
            <div className="flex-1 min-w-0">
              <p className={`text-sm ${
                step.state === 'done' ? 'text-henry-text-dim' :
                step.state === 'active' ? 'text-henry-text font-medium' :
                step.state === 'error' ? 'text-henry-error' :
                'text-henry-text-muted'
              }`}>
                {step.label}
              </p>
              {step.detail && (
                <p className="text-[11px] text-henry-text-muted mt-0.5">{step.detail}</p>
              )}

              {/* Download progress bar */}
              {step.id === 'launch' && phase === 'installing' && downloadProgress && (
                <div className="mt-2">
                  <div className="h-1.5 bg-henry-border/30 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-henry-accent rounded-full transition-all duration-300"
                      style={{ width: `${downloadPct ?? 5}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-henry-text-muted mt-1">
                    {downloadProgress.message}
                    {downloadProgress.total > 0 && (
                      <> · {formatBytes(downloadProgress.downloaded)} / {formatBytes(downloadProgress.total)}</>
                    )}
                  </p>
                </div>
              )}

              {/* Pull progress bar */}
              {step.id === 'model' && phase === 'pulling' && pullProgress && (
                <div className="mt-2">
                  <div className="h-1.5 bg-henry-border/30 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-henry-success rounded-full transition-all duration-300"
                      style={{ width: pullPct !== null ? `${pullPct}%` : '8%' }}
                    />
                  </div>
                  <p className="text-[10px] text-henry-text-muted mt-1">
                    {pullProgress.status}
                    {pullProgress.total > 0 && pullPct !== null && <> · {pullPct}%</>}
                  </p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Model picker (if multiple found or pull failed) */}
      {phase === 'pick_model' && (
        <div className="border-t border-henry-border/30 pt-4 space-y-3">
          <p className="text-xs text-henry-text-dim">
            {detectedModels.length > 0
              ? 'Pick a model to use:'
              : 'Pull a model to get started:'}
          </p>

          {detectedModels.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {detectedModels.map((m) => (
                <button
                  key={m}
                  onClick={() => { onModelReady(m); }}
                  className="px-3 py-1.5 rounded-xl text-sm font-mono bg-henry-hover border border-henry-border text-henry-text-dim hover:border-henry-success hover:text-henry-success transition-all"
                >
                  {m}
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {['llama3.2', 'mistral', 'phi4'].map((m) => (
                <button
                  key={m}
                  onClick={() => retryPull(m)}
                  className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl border border-henry-border bg-henry-hover hover:border-henry-accent hover:bg-henry-accent/5 transition-all text-left"
                >
                  <span className="text-sm font-mono text-henry-text">{m}</span>
                  <span className="text-xs text-henry-text-muted">Pull →</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Error state with fallback */}
      {phase === 'error' && (
        <div className="border-t border-henry-border/30 pt-4 space-y-3">
          <p className="text-xs text-henry-error">{errorMsg}</p>
          <div className="flex gap-2">
            <button
              onClick={() => { started.current = false; setPhase('checking'); setSteps([
                { id: 'check',  label: 'Checking for Ollama',    state: 'active' },
                { id: 'launch', label: 'Starting Ollama',         state: 'pending' },
                { id: 'model',  label: 'Pulling a starter model', state: 'pending' },
                { id: 'ready',  label: 'Henry is ready',          state: 'pending' },
              ]); void run(); }}
              className="flex-1 py-2.5 rounded-xl border border-henry-border text-sm text-henry-text-dim hover:text-henry-text hover:border-henry-text-dim transition-all"
            >
              ↻ Try again
            </button>
            <button
              onClick={onFallback}
              className="flex-1 py-2.5 rounded-xl border border-henry-border text-sm text-henry-text-dim hover:text-henry-text transition-all"
            >
              Set up manually
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
