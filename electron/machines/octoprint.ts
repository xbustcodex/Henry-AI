/**
 * OctoPrint driver — REST with `X-Api-Key` auth.
 *
 * Status:  GET /api/printer + GET /api/job
 * Job:     POST /api/files/local (multipart, print=true)
 * Control: POST /api/job {command: pause|cancel, action: pause|resume}
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

export interface OctoPrintPrinterResponse {
  temperature?: {
    tool0?: { actual?: number; target?: number };
    bed?: { actual?: number; target?: number };
  };
  state?: {
    text?: string;
    flags?: {
      operational?: boolean;
      printing?: boolean;
      paused?: boolean;
      pausing?: boolean;
      cancelling?: boolean;
      error?: boolean;
      closedOrError?: boolean;
    };
  };
}

export interface OctoPrintJobResponse {
  job?: { file?: { name?: string | null } };
  progress?: { completion?: number | null; printTimeLeft?: number | null };
}

export function mapOctoPrintState(flags: NonNullable<OctoPrintPrinterResponse['state']>['flags']): MachineState {
  if (!flags) return 'idle';
  if (flags.error || flags.closedOrError) return 'error';
  if (flags.paused || flags.pausing) return 'paused';
  if (flags.printing || flags.cancelling) return 'printing';
  if (flags.operational) return 'idle';
  return 'offline';
}

export function mapOctoPrintStatus(
  printer: OctoPrintPrinterResponse,
  job: OctoPrintJobResponse,
): MachineStatus {
  const completion = job.progress?.completion;
  const timeLeft = job.progress?.printTimeLeft;
  return {
    state: mapOctoPrintState(printer.state?.flags),
    progressPct: typeof completion === 'number' ? Math.round(completion) : undefined,
    tempNozzle: printer.temperature?.tool0?.actual,
    tempNozzleTarget: printer.temperature?.tool0?.target,
    tempBed: printer.temperature?.bed?.actual,
    tempBedTarget: printer.temperature?.bed?.target,
    jobName: job.job?.file?.name ?? undefined,
    timeRemainingSec: typeof timeLeft === 'number' ? Math.max(0, Math.round(timeLeft)) : undefined,
    raw: { printer, job },
  };
}

// ── Driver ──────────────────────────────────────────────────────────────────

const CAPABILITIES: MachineCapabilities = { sendJob: true, pauseResume: true, stop: true };

export class OctoPrintDriver implements MachineDriver {
  readonly protocol = 'octoprint' as const;
  readonly capabilities = CAPABILITIES;

  private connected = false;

  constructor(private config: MachineConnectionConfig) {}

  private get base(): string {
    const host = String(this.config.host ?? '').trim();
    return `http://${host}:${this.config.port ?? 80}`;
  }

  private get headers(): Record<string, string> {
    return { 'X-Api-Key': String(this.config.apiKey ?? '') };
  }

  private async req(
    pathname: string,
    opts: { method?: string; body?: BodyInit; json?: unknown; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);
    try {
      const headers: Record<string, string> = { ...this.headers };
      let body = opts.body;
      if (opts.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.json);
      }
      const res = await fetch(`${this.base}${pathname}`, {
        method: opts.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      });
      const text = await res.text().catch(() => '');
      let json: unknown;
      try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  async connect(): Promise<void> {
    if (!String(this.config.host ?? '').trim()) throw new Error('OctoPrint connection needs the host/IP.');
    if (!String(this.config.apiKey ?? '').trim()) {
      throw new Error('OctoPrint needs an API key (OctoPrint → Settings → API).');
    }
    const r = await this.req('/api/version', { timeoutMs: 5000 }).catch((e) => {
      throw new Error(`Could not reach OctoPrint at ${this.base}: ${e instanceof Error ? e.message : e}`);
    });
    if (r.status === 401 || r.status === 403) throw new Error('OctoPrint rejected the API key.');
    if (r.status >= 500) throw new Error(`OctoPrint at ${this.base} answered ${r.status}.`);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false; // stateless REST
  }

  async getStatus(): Promise<MachineStatus> {
    if (!this.connected) return { state: 'offline' };
    try {
      const [p, j] = await Promise.all([this.req('/api/printer'), this.req('/api/job')]);
      if (p.status === 401 || p.status === 403) return { state: 'error', raw: 'API key rejected' };
      // 409 = printer not operational (e.g. disconnected from OctoPrint host)
      if (p.status === 409) return { state: 'offline', raw: 'Printer not connected to OctoPrint' };
      return mapOctoPrintStatus(
        (p.json ?? {}) as OctoPrintPrinterResponse,
        (j.json ?? {}) as OctoPrintJobResponse,
      );
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
      form.append('select', 'true');
      form.append('print', 'true');
      const res = await fetch(`${this.base}/api/files/local`, {
        method: 'POST',
        headers: this.headers,
        body: form,
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'OctoPrint rejected the API key.' };
      if (res.status >= 300) return { ok: false, error: `OctoPrint upload failed (${res.status}).` };
      return { ok: true, message: `Uploaded ${filename} and started the print.` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async jobCommand(body: Record<string, unknown>, label: string): Promise<MachineActionResult> {
    try {
      const r = await this.req('/api/job', { method: 'POST', json: body });
      if (r.status >= 300) return { ok: false, error: `OctoPrint ${label} failed (${r.status}).` };
      return { ok: true, message: `Sent ${label} to the printer.` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  pause(): Promise<MachineActionResult> { return this.jobCommand({ command: 'pause', action: 'pause' }, 'pause'); }
  resume(): Promise<MachineActionResult> { return this.jobCommand({ command: 'pause', action: 'resume' }, 'resume'); }
  stop(): Promise<MachineActionResult> { return this.jobCommand({ command: 'cancel' }, 'cancel'); }
}
