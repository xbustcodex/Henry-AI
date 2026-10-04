/**
 * NetworkPrinterMonitor — live status + control for a network printer
 * (build plan, 3D area). Polls `printerNetStatus` every few seconds and exposes
 * pause / resume / cancel + a G-code box via `printerNetCommand`.
 *
 * OctoPrint needs the printer's API key (entered once here); Klipper/Moonraker
 * connects with no key.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type Status = HenryPrinterStatus;

function api() {
  return typeof window !== 'undefined' ? window.henryAPI : undefined;
}

const POLL_MS = 3000;

export default function NetworkPrinterMonitor({ printer }: { printer: HenryDiscoveredPrinter }) {
  const needsKey = /octoprint/i.test(printer.kind);
  const [apiKey, setApiKey] = useState('');
  const [connected, setConnected] = useState(!needsKey);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gcode, setGcode] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const conn = useCallback(
    (): HenryPrinterConn => ({ ip: printer.ip, port: printer.port, kind: printer.kind, apiKey: apiKey.trim() || undefined }),
    [printer, apiKey],
  );

  const poll = useCallback(async () => {
    try {
      const res = await api()?.printerNetStatus?.(conn());
      if (!res) { setError('Live monitor is only available in the desktop app.'); return; }
      if (!res.ok) { setError(res.error || 'Could not read status.'); return; }
      setStatus(res.result ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read status.');
    }
  }, [conn]);

  useEffect(() => {
    if (!connected) return;
    void poll();
    timer.current = setInterval(() => void poll(), POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [connected, poll]);

  const command = useCallback(async (action: string, g?: string) => {
    setError(null);
    const res = await api()?.printerNetCommand?.(conn(), action, g);
    if (res && !res.ok) setError(res.error || 'Command failed.');
    else void poll();
  }, [conn, poll]);

  if (needsKey && !connected) {
    return (
      <div className="mt-2 bg-henry-surface/50 border border-henry-border/30 rounded-lg p-3">
        <p className="text-[11px] text-henry-text-muted mb-2">
          OctoPrint needs its API key (OctoPrint → Settings → API).
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="OctoPrint API key"
            className="flex-1 bg-henry-surface border border-henry-border/30 rounded-lg px-2 py-1.5 text-xs text-henry-text outline-none"
          />
          <button
            onClick={() => apiKey.trim() && setConnected(true)}
            disabled={!apiKey.trim()}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 disabled:opacity-40"
          >
            Connect
          </button>
        </div>
        {error && <p className="text-[11px] text-red-300 mt-2">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-2 bg-henry-surface/50 border border-henry-border/30 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-henry-text">{status?.state || 'Connecting…'}</span>
        {status?.job && <span className="text-[10px] text-henry-text-muted truncate max-w-[50%]">{status.job}</span>}
      </div>

      {/* Temps */}
      <div className="grid grid-cols-2 gap-2">
        <Temp label="Nozzle" t={status?.nozzle} />
        <Temp label="Bed" t={status?.bed} />
      </div>

      {/* Progress */}
      {typeof status?.progress === 'number' && (
        <div>
          <div className="flex justify-between text-[10px] text-henry-text-muted mb-1">
            <span>Progress</span><span>{status.progress}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-henry-surface overflow-hidden">
            <div className="h-full bg-henry-accent transition-all" style={{ width: `${Math.max(0, Math.min(100, status.progress))}%` }} />
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex gap-2">
        <button onClick={() => void command('pause')} className="flex-1 px-2 py-1.5 rounded-lg text-[11px] bg-amber-500/15 text-amber-300 hover:bg-amber-500/25">Pause</button>
        <button onClick={() => void command('resume')} className="flex-1 px-2 py-1.5 rounded-lg text-[11px] bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25">Resume</button>
        <button onClick={() => void command('cancel')} className="flex-1 px-2 py-1.5 rounded-lg text-[11px] bg-red-500/15 text-red-300 hover:bg-red-500/25">Cancel</button>
      </div>

      {/* G-code */}
      <div className="flex gap-2">
        <input
          value={gcode}
          onChange={(e) => setGcode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && gcode.trim()) { void command('gcode', gcode); setGcode(''); } }}
          placeholder="Send G-code… e.g. G28"
          className="flex-1 bg-henry-surface border border-henry-border/30 rounded-lg px-2 py-1.5 text-xs text-henry-text font-mono outline-none"
        />
        <button
          onClick={() => { if (gcode.trim()) { void command('gcode', gcode); setGcode(''); } }}
          disabled={!gcode.trim()}
          className="px-3 py-1.5 rounded-lg text-xs bg-henry-surface text-henry-text-muted hover:text-henry-text disabled:opacity-40"
        >
          Send
        </button>
      </div>

      {error && <p className="text-[11px] text-red-300">{error}</p>}
    </div>
  );
}

function Temp({ label, t }: { label: string; t?: { actual: number; target: number } }) {
  return (
    <div className="bg-henry-surface/50 rounded-lg px-3 py-2">
      <div className="text-[10px] text-henry-text-muted">{label}</div>
      <div className="text-sm text-henry-text">
        {t ? `${Math.round(t.actual)}°` : '—'}
        {t && t.target > 0 && <span className="text-[10px] text-henry-text-muted"> / {Math.round(t.target)}°</span>}
      </div>
    </div>
  );
}
