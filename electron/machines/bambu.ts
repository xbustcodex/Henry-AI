/**
 * Bambu Lab LAN-mode driver — MQTT over TLS.
 *
 * Bambu printers in LAN mode run an MQTT broker on :8883 (TLS, self-signed
 * cert). Auth is username `bblp` + the LAN access code from the printer's
 * screen. The printer publishes status reports on `device/{serial}/report`;
 * we request a full state dump by publishing a `pushall` command to
 * `device/{serial}/request`. Reports are often *partial* (diffs), so the
 * driver merges every report into a running status.
 *
 * Control (pause/resume/stop) also goes over MQTT. Job upload is implicit
 * FTPS on port 990, which raw Node does not speak — so sendJob shells out to
 * the system `curl` binary (macOS ships curl with ftps support), then starts
 * the print over the existing MQTT connection with a `project_file` (.3mf)
 * or `gcode_file` (.gcode) command, following the community-documented
 * OpenBambuAPI shapes. Experimental: exercised against the protocol docs,
 * not real hardware — curl errors are surfaced verbatim.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import mqtt, { type MqttClient } from 'mqtt';
import type {
  MachineActionResult,
  MachineCapabilities,
  MachineConnectionConfig,
  MachineDriver,
  MachineState,
  MachineStatus,
} from './types';

// ── Pure mapper (unit-tested) ───────────────────────────────────────────────

/** Bambu `print` report payload → the fields we care about. */
export interface BambuPrintReport {
  gcode_state?: string;        // IDLE | RUNNING | PAUSE | FINISH | FAILED | PREPARE | SLICING
  mc_percent?: number;         // 0–100
  mc_remaining_time?: number;  // minutes
  nozzle_temper?: number;
  nozzle_target_temper?: number;
  bed_temper?: number;
  bed_target_temper?: number;
  subtask_name?: string;
  [key: string]: unknown;
}

export function mapBambuGcodeState(gcodeState: string | undefined): MachineState | undefined {
  if (!gcodeState) return undefined;
  switch (gcodeState.toUpperCase()) {
    case 'RUNNING':
    case 'PREPARE':
    case 'SLICING':
      return 'printing';
    case 'PAUSE':
      return 'paused';
    case 'FAILED':
      return 'error';
    case 'IDLE':
    case 'FINISH':
      return 'idle';
    default:
      return undefined;
  }
}

/**
 * Merge one (possibly partial) Bambu report into the previous status.
 * Fields absent from the report keep their previous value.
 */
export function mapBambuReport(report: BambuPrintReport, prev?: MachineStatus): MachineStatus {
  const state = mapBambuGcodeState(report.gcode_state) ?? prev?.state ?? 'idle';
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  return {
    state,
    progressPct: num(report.mc_percent) ?? prev?.progressPct,
    timeRemainingSec:
      num(report.mc_remaining_time) !== undefined
        ? Math.round(report.mc_remaining_time! * 60)
        : prev?.timeRemainingSec,
    tempNozzle: num(report.nozzle_temper) ?? prev?.tempNozzle,
    tempNozzleTarget: num(report.nozzle_target_temper) ?? prev?.tempNozzleTarget,
    tempBed: num(report.bed_temper) ?? prev?.tempBed,
    tempBedTarget: num(report.bed_target_temper) ?? prev?.tempBedTarget,
    jobName: typeof report.subtask_name === 'string' && report.subtask_name
      ? report.subtask_name
      : prev?.jobName,
    raw: report,
  };
}

// ── Driver ──────────────────────────────────────────────────────────────────

const CAPABILITIES: MachineCapabilities = { sendJob: true, pauseResume: true, stop: true };

/** Upload a file to the printer's SD card over implicit FTPS using system curl. */
export function buildBambuCurlArgs(host: string, accessCode: string, filePath: string, remoteName: string): string[] {
  return [
    '--silent',
    '--show-error',
    '--insecure', // Bambu uses a self-signed cert
    '--connect-timeout', '15',
    '--user', `bblp:${accessCode}`,
    '-T', filePath,
    `ftps://${host}:990/${encodeURIComponent(remoteName)}`,
  ];
}

export class BambuDriver implements MachineDriver {
  readonly protocol = 'bambu' as const;
  readonly capabilities = CAPABILITIES;

  private client: MqttClient | null = null;
  private status: MachineStatus = { state: 'offline' };
  private connected = false;
  private seq = 1;

  constructor(private config: MachineConnectionConfig) {}

  private get serial(): string {
    return String(this.config.serialNumber ?? '').trim();
  }

  async connect(): Promise<void> {
    const host = String(this.config.host ?? '').trim();
    const accessCode = String(this.config.accessCode ?? '').trim();
    if (!host) throw new Error('Bambu connection needs the printer IP (LAN mode).');
    if (!this.serial) throw new Error('Bambu connection needs the printer serial number.');
    if (!accessCode) throw new Error('Bambu connection needs the LAN access code (printer screen → Settings → WLAN).');

    const port = this.config.port ?? 8883;
    const url = `mqtts://${host}:${port}`;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const client = mqtt.connect(url, {
        username: 'bblp',
        password: accessCode,
        rejectUnauthorized: false, // Bambu uses a self-signed cert
        connectTimeout: 8000,
        reconnectPeriod: 5000,
        keepalive: 30,
      });
      this.client = client;

      client.on('connect', () => {
        this.connected = true;
        client.subscribe(`device/${this.serial}/report`, (err) => {
          if (err) console.warn('[machines:bambu] subscribe failed:', err.message);
        });
        this.requestPushAll();
        if (!settled) { settled = true; resolve(); }
      });

      client.on('message', (_topic, payload) => this.onMessage(payload));

      client.on('error', (err) => {
        if (!settled) {
          settled = true;
          client.end(true);
          this.client = null;
          reject(new Error(`Bambu MQTT connect failed: ${err.message}. Check the IP and LAN access code.`));
        }
      });

      client.on('close', () => {
        this.connected = false;
        if (this.status.state !== 'offline') this.status = { ...this.status, state: 'offline' };
      });
    });
  }

  private onMessage(payload: Buffer): void {
    try {
      const msg = JSON.parse(payload.toString('utf8')) as { print?: BambuPrintReport };
      if (msg.print && typeof msg.print === 'object') {
        this.status = mapBambuReport(msg.print, this.status.state === 'offline' ? undefined : this.status);
      }
    } catch {
      /* non-JSON report — ignore */
    }
  }

  private publishRequest(body: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connected) {
        reject(new Error('Not connected to the printer.'));
        return;
      }
      this.client.publish(
        `device/${this.serial}/request`,
        JSON.stringify(body),
        { qos: 0 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  private requestPushAll(): void {
    void this.publishRequest({
      pushing: { sequence_id: String(this.seq++), command: 'pushall' },
    }).catch(() => { /* best effort */ });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    const client = this.client;
    this.client = null;
    this.status = { state: 'offline' };
    if (client) {
      await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
    }
  }

  async getStatus(): Promise<MachineStatus> {
    if (!this.client || !this.connected) return { state: 'offline' };
    // P1-series printers only push on request; X1 pushes periodically. A
    // pushall per poll keeps both fresh and is cheap on the LAN.
    this.requestPushAll();
    return this.status;
  }

  /**
   * Upload the file to the printer SD card via implicit FTPS (system curl),
   * then start it over MQTT. Experimental — verified against the community
   * OpenBambuAPI protocol docs, not real hardware.
   */
  async sendJob(filePath: string): Promise<MachineActionResult> {
    if (!this.client || !this.connected) return { ok: false, error: 'Not connected to the printer.' };
    if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.3mf' && ext !== '.gcode') {
      return { ok: false, error: `Bambu printers accept .3mf or .gcode files (got ${ext || 'no extension'}).` };
    }
    const remoteName = path.basename(filePath);
    const host = String(this.config.host ?? '').trim();
    const accessCode = String(this.config.accessCode ?? '').trim();

    // 1) Upload over implicit FTPS (port 990) using the system curl binary.
    const upload = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      execFile(
        'curl',
        buildBambuCurlArgs(host, accessCode, filePath, remoteName),
        { timeout: 10 * 60_000 },
        (err, _stdout, stderr) => {
          if (err) {
            const detail = (stderr || err.message || '').trim();
            resolve({ ok: false, error: detail || 'curl upload failed' });
          } else {
            resolve({ ok: true });
          }
        },
      );
    });
    if (!upload.ok) {
      return { ok: false, error: `FTPS upload to the printer failed: ${upload.error}` };
    }

    // 2) Start the print over MQTT (OpenBambuAPI shapes).
    try {
      if (ext === '.3mf') {
        await this.publishRequest({
          print: {
            sequence_id: String(this.seq++),
            command: 'project_file',
            param: 'Metadata/plate_1.gcode',
            url: `file:///sdcard/${remoteName}`,
            subtask_name: remoteName,
            use_ams: false,
            timelapse: false,
            bed_leveling: true,
            flow_cali: false,
            vibration_cali: false,
            layer_inspect: false,
          },
        });
      } else {
        await this.publishRequest({
          print: {
            sequence_id: String(this.seq++),
            command: 'gcode_file',
            param: `/sdcard/${remoteName}`,
          },
        });
      }
    } catch (e) {
      return {
        ok: false,
        error: `Uploaded ${remoteName} to the printer SD card, but starting the print failed: ${e instanceof Error ? e.message : String(e)}. You can start it from the printer screen.`,
      };
    }

    return {
      ok: true,
      message: `Uploaded ${remoteName} and asked the printer to start it (experimental — watch the printer screen for the first print).`,
    };
  }

  private async printCommand(command: 'pause' | 'resume' | 'stop'): Promise<MachineActionResult> {
    try {
      await this.publishRequest({
        print: { sequence_id: String(this.seq++), command, param: '' },
      });
      return { ok: true, message: `Sent ${command} to the printer.` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  pause(): Promise<MachineActionResult> { return this.printCommand('pause'); }
  resume(): Promise<MachineActionResult> { return this.printCommand('resume'); }
  stop(): Promise<MachineActionResult> { return this.printCommand('stop'); }
}
