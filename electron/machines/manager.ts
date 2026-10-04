/**
 * MachineManager — the registry + live-connection owner for every machine.
 *
 * Persists saved connections in SQLite (`machine_connections`), builds the
 * right protocol driver on connect, polls connected machines every 10 s and
 * pushes normalized status to the renderer over `machines:event`. Also hosts
 * the opt-in, time-boxed LAN discovery (port scan, no mDNS dep) + serial
 * device listing.
 */

import type Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import net from 'net';
import os from 'os';
import { BambuDriver } from './bambu';
import { MoonrakerDriver } from './moonraker';
import { OctoPrintDriver } from './octoprint';
import { GrblSerialDriver, MarlinSerialDriver, listSerialDevices } from './serial';
import type {
  DiscoveredMachine,
  MachineActionResult,
  MachineConnection,
  MachineConnectionConfig,
  MachineDriver,
  MachineEvent,
  MachineKind,
  MachineProtocol,
  MachineStatus,
} from './types';

const POLL_INTERVAL_MS = 10_000;

const PROTOCOLS: MachineProtocol[] = ['bambu', 'moonraker', 'octoprint', 'marlin-serial', 'grbl-serial'];

interface MachineRow {
  id: string;
  name: string;
  kind: string;
  protocol: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

function rowToConnection(row: MachineRow): MachineConnection {
  let config: MachineConnectionConfig = {};
  try { config = JSON.parse(row.config_json || '{}'); } catch { /* keep empty */ }
  return {
    id: row.id,
    name: row.name,
    kind: (row.kind === 'cnc' ? 'cnc' : 'printer') as MachineKind,
    protocol: row.protocol as MachineProtocol,
    config,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function buildDriver(conn: MachineConnection): MachineDriver {
  switch (conn.protocol) {
    case 'bambu': return new BambuDriver(conn.config);
    case 'moonraker': return new MoonrakerDriver(conn.config);
    case 'octoprint': return new OctoPrintDriver(conn.config);
    case 'marlin-serial': return new MarlinSerialDriver(conn.config);
    case 'grbl-serial': return new GrblSerialDriver(conn.config);
    default: throw new Error(`Unknown machine protocol: ${conn.protocol}`);
  }
}

export class MachineManager {
  private drivers = new Map<string, MachineDriver>();
  private lastStatus = new Map<string, MachineStatus>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private db: Database.Database,
    private getWindow: () => BrowserWindow | null,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS machine_connections (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'printer' CHECK(kind IN ('printer','cnc')),
        protocol    TEXT NOT NULL
          CHECK(protocol IN ('bambu','moonraker','octoprint','marlin-serial','grbl-serial')),
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private emit(event: MachineEvent): void {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('machines:event', event);
  }

  // ── Registry (SQLite) ─────────────────────────────────────────────────────

  list(): Array<MachineConnection & { connected: boolean; status?: MachineStatus }> {
    const rows = this.db
      .prepare('SELECT * FROM machine_connections ORDER BY created_at')
      .all() as MachineRow[];
    return rows.map((r) => {
      const conn = rowToConnection(r);
      return {
        ...conn,
        connected: this.drivers.has(conn.id),
        status: this.lastStatus.get(conn.id),
      };
    });
  }

  get(id: string): MachineConnection | null {
    const row = this.db.prepare('SELECT * FROM machine_connections WHERE id = ?').get(id) as MachineRow | undefined;
    return row ? rowToConnection(row) : null;
  }

  add(input: { name: string; kind: MachineKind; protocol: MachineProtocol; config: MachineConnectionConfig }): MachineConnection {
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('Machine name is required.');
    if (!PROTOCOLS.includes(input.protocol)) throw new Error(`Unknown protocol: ${input.protocol}`);
    const kind: MachineKind = input.kind === 'cnc' ? 'cnc' : 'printer';
    const id = `mc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare('INSERT INTO machine_connections (id, name, kind, protocol, config_json) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, kind, input.protocol, JSON.stringify(input.config ?? {}));
    return this.get(id)!;
  }

  update(id: string, patch: { name?: string; kind?: MachineKind; protocol?: MachineProtocol; config?: MachineConnectionConfig }): MachineConnection {
    const existing = this.get(id);
    if (!existing) throw new Error('Machine not found.');
    if (this.drivers.has(id)) throw new Error('Disconnect the machine before editing its connection.');
    const name = patch.name !== undefined ? String(patch.name).trim() : existing.name;
    const kind = patch.kind ?? existing.kind;
    const protocol = patch.protocol ?? existing.protocol;
    if (!PROTOCOLS.includes(protocol)) throw new Error(`Unknown protocol: ${protocol}`);
    const config = patch.config ?? existing.config;
    this.db
      .prepare(`UPDATE machine_connections SET name=?, kind=?, protocol=?, config_json=?, updated_at=datetime('now') WHERE id=?`)
      .run(name, kind, protocol, JSON.stringify(config), id);
    return this.get(id)!;
  }

  async remove(id: string): Promise<void> {
    if (this.drivers.has(id)) await this.disconnect(id).catch(() => { /* best effort */ });
    this.db.prepare('DELETE FROM machine_connections WHERE id = ?').run(id);
    this.lastStatus.delete(id);
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  async connect(id: string): Promise<MachineStatus> {
    const conn = this.get(id);
    if (!conn) throw new Error('Machine not found.');
    if (this.drivers.has(id)) {
      return this.lastStatus.get(id) ?? { state: 'idle' };
    }
    const driver = buildDriver(conn);
    await driver.connect();
    this.drivers.set(id, driver);
    const status = await driver.getStatus();
    this.lastStatus.set(id, status);
    this.emit({ type: 'connected', machineId: id, status });
    this.ensurePolling();
    return status;
  }

  async disconnect(id: string): Promise<void> {
    const driver = this.drivers.get(id);
    if (!driver) return;
    this.drivers.delete(id);
    this.lastStatus.set(id, { state: 'offline' });
    await driver.disconnect().catch(() => { /* best effort */ });
    this.emit({ type: 'disconnected', machineId: id });
    this.ensurePolling();
  }

  isConnected(id: string): boolean {
    return this.drivers.has(id);
  }

  async status(id: string): Promise<MachineStatus> {
    const driver = this.drivers.get(id);
    if (!driver) return { state: 'offline' };
    const status = await driver.getStatus();
    this.lastStatus.set(id, status);
    return status;
  }

  async statusAll(): Promise<Array<{ id: string; name: string; kind: MachineKind; protocol: MachineProtocol; connected: boolean; status: MachineStatus }>> {
    const out = [];
    for (const conn of this.list()) {
      const status = this.drivers.has(conn.id) ? await this.status(conn.id) : { state: 'offline' as const };
      out.push({
        id: conn.id,
        name: conn.name,
        kind: conn.kind,
        protocol: conn.protocol,
        connected: this.drivers.has(conn.id),
        status,
      });
    }
    return out;
  }

  capabilities(id: string): { sendJob: boolean; pauseResume: boolean; stop: boolean } | null {
    const driver = this.drivers.get(id);
    return driver ? driver.capabilities : null;
  }

  // ── Job control ───────────────────────────────────────────────────────────

  async job(
    id: string,
    action: 'send' | 'pause' | 'resume' | 'stop' | 'home',
    filePath?: string,
  ): Promise<MachineActionResult> {
    const driver = this.drivers.get(id);
    if (!driver) return { ok: false, error: 'Machine is not connected. Connect it first.' };
    switch (action) {
      case 'send':
        if (!filePath) return { ok: false, error: 'A G-code file path is required to send a job.' };
        return driver.sendJob(filePath);
      case 'pause': return driver.pause();
      case 'resume': return driver.resume();
      case 'stop': return driver.stop();
      case 'home':
        if (!driver.home) return { ok: false, error: 'This machine does not support a homing cycle.' };
        return driver.home();
      default: return { ok: false, error: `Unknown job action: ${String(action)}` };
    }
  }

  // ── Poll loop (connected machines only) ───────────────────────────────────

  private ensurePolling(): void {
    const shouldPoll = this.drivers.size > 0;
    if (shouldPoll && !this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.pollOnce(); }, POLL_INTERVAL_MS);
    } else if (!shouldPoll && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.polling) return; // never stack slow polls
    this.polling = true;
    try {
      for (const [id, driver] of this.drivers) {
        try {
          const status = await driver.getStatus();
          this.lastStatus.set(id, status);
          this.emit({ type: 'status', machineId: id, status });
        } catch (e) {
          this.emit({ type: 'error', machineId: id, message: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    const ids = [...this.drivers.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id).catch(() => { /* best effort */ })));
  }

  // ── Discovery (opt-in, time-boxed ~5 s, no mDNS dependency) ───────────────

  async discover(): Promise<DiscoveredMachine[]> {
    const [network, serial] = await Promise.all([scanNetwork(5000), listSerialDevices()]);
    const serialCandidates: DiscoveredMachine[] = serial.map((d) => ({
      devicePath: d.devicePath,
      protocolGuess: 'unknown' as const,
      label: `${d.devicePath} — ${d.description} (Marlin or GRBL)`,
      via: 'serial' as const,
    }));
    return [...network, ...serialCandidates];
  }
}

// ── LAN port scan ────────────────────────────────────────────────────────────

/** Ports we probe and the protocol each one suggests. */
const SCAN_PORTS: Array<{ port: number; guess: MachineProtocol; label: string; verify?: (host: string) => Promise<boolean> }> = [
  { port: 8883, guess: 'bambu', label: 'Bambu Lab (MQTT/TLS)' },
  { port: 7125, guess: 'moonraker', label: 'Klipper/Moonraker', verify: verifyMoonraker },
  { port: 5000, guess: 'octoprint', label: 'OctoPrint', verify: (h) => verifyOctoPrint(h, 5000) },
  { port: 80, guess: 'octoprint', label: 'OctoPrint', verify: (h) => verifyOctoPrint(h, 80) },
];

function localHosts(): string[] {
  const hosts = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
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

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (open: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<{ status: number; text: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    return { status: res.status, text: text.slice(0, 1000) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyMoonraker(host: string): Promise<boolean> {
  const r = await fetchWithTimeout(`http://${host}:7125/printer/info`, 1200);
  return Boolean(r && r.status < 500 && /klippy|hostname|result/i.test(r.text));
}

async function verifyOctoPrint(host: string, port: number): Promise<boolean> {
  const r = await fetchWithTimeout(`http://${host}:${port}/api/version`, 1200);
  return Boolean(r && r.status < 500 && /octoprint|api/i.test(r.text));
}

/** Parallel TCP connect scan of the local /24 on the known machine ports. */
async function scanNetwork(budgetMs: number): Promise<DiscoveredMachine[]> {
  const hosts = localHosts();
  if (hosts.length === 0) return [];
  const deadline = Date.now() + budgetMs;
  const found: DiscoveredMachine[] = [];
  const seen = new Set<string>();

  const jobs: Array<{ host: string; probe: (typeof SCAN_PORTS)[number] }> = [];
  for (const host of hosts) for (const probe of SCAN_PORTS) jobs.push({ host, probe });

  const CONCURRENCY = 128;
  let i = 0;
  async function worker() {
    while (i < jobs.length && Date.now() < deadline) {
      const { host, probe } = jobs[i++];
      const open = await tcpProbe(host, probe.port, 600);
      if (!open) continue;
      if (probe.verify && !(await probe.verify(host))) continue;
      const key = `${host}:${probe.guess}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        host,
        port: probe.port,
        protocolGuess: probe.guess,
        label: `${probe.label} at ${host}:${probe.port}`,
        via: 'port-scan',
      });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found.sort((a, b) => (a.host ?? '').localeCompare(b.host ?? '', undefined, { numeric: true }));
}

// ── Process-wide singleton ───────────────────────────────────────────────────

let managerInstance: MachineManager | null = null;

export function initMachineManager(db: Database.Database, getWindow: () => BrowserWindow | null): MachineManager {
  if (!managerInstance) managerInstance = new MachineManager(db, getWindow);
  return managerInstance;
}

export function getMachineManager(): MachineManager | null {
  return managerInstance;
}
