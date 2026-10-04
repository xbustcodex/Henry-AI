/**
 * PrinterDiscovery — find 3D printers on the local WiFi/LAN (build plan, 3D area).
 *
 * Calls `discoverPrinters` (main-process scan: HTTP probe of OctoPrint /
 * Klipper-Moonraker / PrusaLink / Repetier + an SSDP sweep for Bambu / UPnP)
 * and lists what it finds, with a link to open each printer's web UI.
 */

import { useCallback, useState } from 'react';
import NetworkPrinterMonitor from './NetworkPrinterMonitor';

type Printer = HenryDiscoveredPrinter;

const canMonitor = (kind: string) => /octoprint|moonraker|klipper/i.test(kind);

function api() {
  return typeof window !== 'undefined' ? window.henryAPI : undefined;
}

export default function PrinterDiscovery() {
  const [scanning, setScanning] = useState(false);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openIp, setOpenIp] = useState<string | null>(null);

  const scan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    try {
      const res = await api()?.discoverPrinters?.();
      if (!res) { setError('Network scan is only available in the desktop app.'); return; }
      if (!res.ok) { setError(res.error || 'Scan failed.'); return; }
      setPrinters(res.result ?? []);
      setScanned(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed.');
    } finally {
      setScanning(false);
    }
  }, [scanning]);

  return (
    <div className="bg-henry-surface/40 border border-henry-border/30 rounded-xl p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-henry-text">Find on WiFi</h3>
          <p className="text-[11px] text-henry-text-muted mt-0.5">
            Scan your network for any 3D printer — OctoPrint, Klipper, Prusa, Bambu, and more.
          </p>
        </div>
        <button
          onClick={() => void scan()}
          disabled={scanning}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 transition-colors disabled:opacity-50"
        >
          {scanning ? 'Scanning…' : 'Scan network'}
        </button>
      </div>

      {error && <p className="text-[11px] text-red-300 mt-3">{error}</p>}

      {scanned && !error && printers.length === 0 && (
        <p className="text-[11px] text-henry-text-muted mt-3">
          No network printers found. Make sure the printer is on the same WiFi — or connect it by USB below.
        </p>
      )}

      {printers.length > 0 && (
        <div className="mt-3 space-y-2">
          {printers.map((p) => (
            <div key={p.ip} className="bg-henry-surface/50 border border-henry-border/30 rounded-lg px-3 py-2">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-sm text-henry-text truncate">
                    {p.name || p.kind}
                    <span className="text-[10px] text-henry-text-muted ml-2">{p.kind}</span>
                  </div>
                  <div className="text-[10px] text-henry-text-muted">{p.ip}{p.port ? `:${p.port}` : ''} · via {p.via}</div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                  {canMonitor(p.kind) && (
                    <button
                      onClick={() => setOpenIp((cur) => (cur === p.ip ? null : p.ip))}
                      className="text-[11px] text-henry-accent hover:underline"
                    >
                      {openIp === p.ip ? 'Hide' : 'Monitor'}
                    </button>
                  )}
                  {p.url && (
                    <button onClick={() => api()?.computerOpenUrl?.(p.url!)} className="text-[11px] text-henry-accent hover:underline">
                      Open ↗
                    </button>
                  )}
                </div>
              </div>
              {openIp === p.ip && canMonitor(p.kind) && <NetworkPrinterMonitor printer={p} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
