/**
 * Klipper / Moonraker driver — plain REST on http://host:7125.
 *
 * Status:  GET /printer/objects/query?print_stats&heater_bed&extruder&virtual_sdcard&toolhead
 * Job:     POST /server/files/upload (multipart) then POST /printer/print/start?filename=…
 * Control: POST /printer/print/{pause,resume,cancel}
 */

import fs from 'fs';
import path from 'path';
import type {
  MachineActionResult,
  MachineCapabilities,
  MachineConnectionConfig,
  MachineDriver,
  MachineState,
  MachineStatus,
} from './types';

// ── Pure mapper (unit-tested) ───────────────────────────────────────────────

/** Shape of `result.status` from /printer/objects/query. */
export interface MoonrakerQueryStatus {
  print_stats?: {
    state?: string; // standby | printing | paused | complete | error | cancelled
    filename?: string;
    print_duration?: number;
    message?: string;
  };
  extruder?: { temperature?: number; target?: number };
  heater_bed?: { temperature?: number; target?: number };
  virtual_sdcard?: { progress?: number; is_active?: boolean };
  toolhead?: { position?: number[] };
}

export function mapMoonrakerState(state: string | undefined): MachineState {
  switch ((state ?? '').toLowerCase()) {
    case 'printing': return 'printing';
    case 'paused': return 'paused';
    case 'error': return 'error';
    case 'standby':
    case 'complete':
    case 'cancelled':
      return 'idle';
    default:
      return 'idle';
  }
}

export function mapMoonrakerStatus(s: MoonrakerQueryStatus): MachineStatus {
  const ps = s.print_stats ?? {};
  const progress = typeof s.virtual_sdcard?.progress === 'number' ? s.virtual_sdcard.progress : undefined;
  const duration = typeof ps.print_duration === 'number' ? ps.print_duration : undefined;

  let timeRemainingSec: number | undefined;
  if (progress !== undefined && progress > 0.001 && duration !== undefined) {
    timeRemainingSec = Math.max(0, Math.round((duration / progress) - duration));
  }

  const pos = s.toolhead?.position;
  const positionXYZ =
    Array.isArray(pos) && pos.length >= 3 &&
    pos.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))
      ? { x: pos[0], y: pos[1], z: pos[2] }
      : undefined;

  return {
    state: mapMoonrakerState(ps.state),
    progressPct: progress !== undefined ? Math.round(progress * 100) : undefined,
    tempNozzle: s.extruder?.temperature,
    tempNozzleTarget: s.extruder?.target,
    tempBed: s.heater_bed?.temperature,
    tempBedTarget: s.heater_bed?.target,
    jobName: ps.filename || undefined,
    timeRemainingSec,
    positionXYZ,
    raw: s,
  };
}

// ── Driver ──────────────────────────────────────────────────────────────────

const CAPABILITIES: MachineCapabilities = { sendJob: true, pauseResume: true, stop: true };

async function httpJson(
  url: string,
  opts: { method?: string; body?: BodyInit; timeoutMs?: number } = {},
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);
  try {
    const res = await fetch(url, { method: opts.method ?? 'GET', body: opts.body, signal: controller.signal });
    const text = await res.text().catch(() => '');
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

export class MoonrakerDriver implements MachineDriver {
  readonly protocol = 'moonraker' as const;
  readonly capabilities = CAPABILITIES;

  private connected = false;

  constructor(private config: MachineConnectionConfig) {}

  private get base(): string {
    const host = String(this.config.host ?? '').trim();
    return `http://${host}:${this.config.port ?? 7125}`;
  }

  async connect(): Promise<void> {
    if (!String(this.config.host ?? '').trim()) {
      throw new Error('Moonraker connection needs the printer host/IP.');
    }
    const r = await httpJson(`${this.base}/printer/info`, { timeoutMs: 5000 }).catch((e) => {
      throw new Error(`Could not reach Moonraker at ${this.base}: ${e instanceof Error ? e.message : e}`);
    });
    if (r.status >= 500) throw new Error(`Moonraker at ${this.base} answered ${r.status} — is Klipper running?`);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false; // stateless REST — nothing to tear down
  }

  async getStatus(): Promise<MachineStatus> {
    if (!this.connected) return { state: 'offline' };
    try {
      const q = 'print_stats&heater_bed&extruder&virtual_sdcard&toolhead';
      const r = await httpJson(`${this.base}/printer/objects/query?${q}`);
      const status = ((r.json ?? {}) as { result?: { status?: MoonrakerQueryStatus } }).result?.status;
      if (!status) return { state: 'offline' };
      return mapMoonrakerStatus(status);
    } catch {
      return { state: 'offline' };
    }
  }

  async sendJob(filePath: string): Promise<MachineActionResult> {
    try {
      if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
      const MAX = 200 * 1024 * 1024;
      if (fs.statSync(filePath).size > MAX) return { ok: false, error: 'G-code is over 200 MB — too large to upload.' };

      const filename = path.basename(filePath);
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(filePath)], { type: 'text/plain' }), filename);
      const up = await fetch(`${this.base}/server/files/upload`, { method: 'POST', body: form });
      if (up.status >= 300) return { ok: false, error: `Moonraker upload failed (${up.status}).` };

      const start = await httpJson(
        `${this.base}/printer/print/start?filename=${encodeURIComponent(filename)}`,
        { method: 'POST' },
      );
      if (start.status >= 300) return { ok: false, error: `Uploaded, but starting the print failed (${start.status}).` };
      return { ok: true, message: `Uploaded ${filename} and started the print.` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async printAction(action: 'pause' | 'resume' | 'cancel'): Promise<MachineActionResult> {
    try {
      const r = await httpJson(`${this.base}/printer/print/${action}`, { method: 'POST' });
      if (r.status >= 300) return { ok: false, error: `Moonraker ${action} failed (${r.status}).` };
      return { ok: true, message: `Sent ${action} to the printer.` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  pause(): Promise<MachineActionResult> { return this.printAction('pause'); }
  resume(): Promise<MachineActionResult> { return this.printAction('resume'); }
  stop(): Promise<MachineActionResult> { return this.printAction('cancel'); }
}
