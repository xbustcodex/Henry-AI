/**
 * Network 3D-printer discovery (build plan, 3D area). Henry's USB bridge only
 * sees printers on a cable; this finds them on your WiFi/LAN — any brand —
 * with zero extra dependencies (Node built-ins only).
 *
 * Two complementary scans run in parallel:
 *   1. HTTP subnet probe — for each host on your /24, probe the well-known
 *      endpoints of the common network print stacks (OctoPrint, Klipper/
 *      Moonraker, PrusaLink, Repetier). This reliably IDs real printers.
 *   2. SSDP sweep — a UPnP M-SEARCH on 1900 plus a short listen on Bambu's
 *      2021 broadcast, to catch Bambu Lab and other SSDP-announcing printers.
 *
 * Everything stays on the LAN; nothing is sent anywhere. Exposed as
 * `printers:discover`.
 */

import { ipcMain } from 'electron';
import os from 'os';
import dgram from 'dgram';

export interface DiscoveredPrinter {
  ip: string;
  port?: number;
  kind: string;      // 'OctoPrint' | 'Klipper/Moonraker' | 'PrusaLink' | 'Repetier' | 'Bambu Lab' | 'UPnP device'
  name?: string;
  url?: string;
  via: 'http' | 'ssdp';
}

// ── Local subnet hosts (/24) ────────────────────────────────────────────────

function localHosts(): string[] {
  const hosts = new Set<string>();
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const parts = ni.address.split('.');
      if (parts.length !== 4) continue;
      const base = `${parts[0]}.${parts[1]}.${parts[2]}.`;
      for (let i = 1; i <= 254; i++) hosts.add(base + i);
    }
  }
  return [...hosts];
}

// ── HTTP probing ────────────────────────────────────────────────────────────

async function fetchText(url: string, timeoutMs: number): Promise<{ status: number; text: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    return { status: res.status, text: text.slice(0, 2000) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe one host across the known print-stack endpoints. */
async function probeHost(ip: string, timeoutMs: number): Promise<DiscoveredPrinter | null> {
  // OctoPrint / PrusaLink share /api/version; distinguish by the payload.
  const v = await fetchText(`http://${ip}/api/version`, timeoutMs);
  if (v && v.status < 500 && /octoprint|prusa|api/i.test(v.text)) {
    if (/prusa/i.test(v.text)) return { ip, port: 80, kind: 'PrusaLink', via: 'http', url: `http://${ip}/` };
    if (/octoprint/i.test(v.text)) return { ip, port: 80, kind: 'OctoPrint', via: 'http', url: `http://${ip}/` };
  }
  // Moonraker (Klipper) — open by default, no auth.
  const m = await fetchText(`http://${ip}:7125/printer/info`, timeoutMs);
  if (m && m.status < 500 && /klippy|hostname|state/i.test(m.text)) {
    let name: string | undefined;
    try { name = JSON.parse(m.text)?.result?.hostname; } catch { /* ignore */ }
    return { ip, port: 7125, kind: 'Klipper/Moonraker', name, via: 'http', url: `http://${ip}:7125/` };
  }
  // Repetier-Server.
  const r = await fetchText(`http://${ip}:3344/printer/info`, timeoutMs);
  if (r && r.status < 500 && /repetier|printer/i.test(r.text)) {
    return { ip, port: 3344, kind: 'Repetier', via: 'http', url: `http://${ip}:3344/` };
  }
  return null;
}

/** Probe all hosts with bounded concurrency. */
async function httpScan(timeoutMs: number): Promise<DiscoveredPrinter[]> {
  const hosts = localHosts();
  const found: DiscoveredPrinter[] = [];
  const CONCURRENCY = 64;
  let i = 0;
  async function worker() {
    while (i < hosts.length) {
      const ip = hosts[i++];
      const hit = await probeHost(ip, timeoutMs);
      if (hit) found.push(hit);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found;
}

// ── SSDP / Bambu sweep ──────────────────────────────────────────────────────

function ssdpScan(durationMs: number): Promise<DiscoveredPrinter[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredPrinter>();
    let done = false;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* ignore */ }
      resolve([...found.values()]);
    };

    sock.on('error', () => finish());

    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const isBambu = /bambu/i.test(text);
      const isPrinter = /printer|3dprint|moonraker|octoprint|prusa|klipper/i.test(text);
      if (!isBambu && !isPrinter && !/upnp/i.test(text)) return;
      const ip = rinfo.address;
      if (found.has(ip)) return;
      const nameMatch = text.match(/DevName\.bambu\.com:\s*(.+)/i) || text.match(/SERVER:\s*(.+)/i);
      found.set(ip, {
        ip,
        kind: isBambu ? 'Bambu Lab' : isPrinter ? 'Network printer' : 'UPnP device',
        name: nameMatch?.[1]?.trim().slice(0, 80),
        via: 'ssdp',
      });
    });

    try {
      sock.bind(() => {
        try { sock.setBroadcast(true); } catch { /* ignore */ }
        // Standard UPnP M-SEARCH.
        const msearch = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\n' +
            'HOST: 239.255.255.250:1900\r\n' +
            'MAN: "ssdp:discover"\r\n' +
            'MX: 2\r\n' +
            'ST: ssdp:all\r\n\r\n',
        );
        sock.send(msearch, 0, msearch.length, 1900, '239.255.255.250', () => { /* sent */ });
        // Bambu announces on 2021; some respond to a probe there too.
        sock.send(msearch, 0, msearch.length, 2021, '239.255.255.250', () => { /* best effort */ });
      });
    } catch {
      finish();
      return;
    }

    setTimeout(finish, durationMs);
  });
}

// ── IPC ─────────────────────────────────────────────────────────────────────

export function registerPrinterDiscoveryHandlers(): void {
  ipcMain.handle('printers:discover', async () => {
    try {
      const [http, ssdp] = await Promise.all([
        httpScan(1200),
        ssdpScan(3500),
      ]);
      // Merge, dedup by ip (HTTP detail wins over SSDP).
      const byIp = new Map<string, DiscoveredPrinter>();
      for (const p of ssdp) byIp.set(p.ip, p);
      for (const p of http) byIp.set(p.ip, p);
      const printers = [...byIp.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
      return { ok: true, result: printers };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
