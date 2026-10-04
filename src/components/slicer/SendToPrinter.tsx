/**
 * SendToPrinter — closes the loop (slicer plan, P4). After a slice, scan for a
 * network printer, pick one, and upload + start the print. OctoPrint needs its
 * API key; Klipper/Moonraker connects with none.
 */

import { useCallback, useState } from 'react';

type Printer = HenryDiscoveredPrinter;

const canSend = (kind: string) => /octoprint|moonraker|klipper/i.test(kind);

function api() {
  return typeof window !== 'undefined' ? window.henryAPI : undefined;
}

export default function SendToPrinter({ gcodePath }: { gcodePath: string }) {
  const [scanning, setScanning] = useState(false);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [ip, setIp] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = printers.find((p) => p.ip === ip);
  const needsKey = selected && /octoprint/i.test(selected.kind);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await api()?.discoverPrinters?.();
      if (!res?.ok) { setError(res?.error || 'Scan failed.'); return; }
      const sendable = (res.result ?? []).filter((p) => canSend(p.kind));
      setPrinters(sendable);
      if (sendable.length && !ip) setIp(sendable[0].ip);
      if (!sendable.length) setError('No OctoPrint/Klipper printers found on the network.');
    } finally {
      setScanning(false);
    }
  }, [ip]);

  const send = useCallback(async () => {
    if (!selected || sending) return;
    setSending(true);
    setMsg(null);
    setError(null);
    try {
      const conn: HenryPrinterConn = { ip: selected.ip, port: selected.port, kind: selected.kind, apiKey: apiKey.trim() || undefined };
      const res = await api()?.printerNetUpload?.(conn, gcodePath, true);
      if (res?.ok) setMsg('Sent — the print is starting on the printer.');
      else setError(res?.error || 'Send failed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed.');
    } finally {
      setSending(false);
    }
  }, [selected, apiKey, gcodePath, sending]);

  return (
    <div className="mt-3 border-t border-henry-border/20 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-henry-text-dim">Send to a printer</span>
        <button onClick={() => void scan()} disabled={scanning} className="text-[11px] text-henry-accent hover:underline disabled:opacity-50">
          {scanning ? 'Scanning…' : printers.length ? 'Re-scan' : 'Find printers'}
        </button>
      </div>

      {printers.length > 0 && (
        <div className="mt-2 space-y-2">
          <select
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            className="w-full bg-henry-surface border border-henry-border/30 rounded-lg px-2 py-1.5 text-xs text-henry-text outline-none"
          >
            {printers.map((p) => <option key={p.ip} value={p.ip}>{(p.name || p.kind)} · {p.ip} ({p.kind})</option>)}
          </select>
          {needsKey && (
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="OctoPrint API key"
              className="w-full bg-henry-surface border border-henry-border/30 rounded-lg px-2 py-1.5 text-xs text-henry-text outline-none"
            />
          )}
          <button
            onClick={() => void send()}
            disabled={sending || !selected || (Boolean(needsKey) && !apiKey.trim())}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? 'Sending…' : 'Send & start print'}
          </button>
        </div>
      )}

      {msg && <p className="text-[11px] text-emerald-400 mt-2">{msg}</p>}
      {error && <p className="text-[11px] text-red-300 mt-2">{error}</p>}
    </div>
  );
}
