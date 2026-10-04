/**
 * USB-serial drivers — Marlin (3D printers) and GRBL (CNC).
 *
 * Both drivers speak through a small `SerialTransport` interface. The real
 * transport needs the native `serialport` package, which is NOT a dependency
 * yet (native rebuild risk for the running dev app) — connection is gated on
 * a dynamic import and fails with a clear one-time-setup message:
 *
 *   "serial support needs one-time setup — npm install serialport && npm run rebuild"
 *
 * Device discovery still works without the dep via an `ls /dev/tty.usb*
 * /dev/cu.usb*` shell fallback.
 *
 * Marlin: M105 temp polling, streamed G-code with ok flow control,
 *         M25/M24 pause/resume (SD), M524 abort (+M112 emergency stop fallback).
 * GRBL:   '?' status reports `<Idle|MPos:…>` / `<Run|WPos:…>`, '!' feed hold,
 *         '~' cycle start/resume, Ctrl-X (0x18) soft reset, '$H' home,
 *         streamed G-code line-by-line with ok flow control.
 */

import { spawn } from 'child_process';
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

export const SERIAL_SETUP_MESSAGE =
  'serial support needs one-time setup — npm install serialport && npm run rebuild';

// ── Pure parsers (unit-tested) ──────────────────────────────────────────────

export interface GrblStatusReport {
  state: MachineState;
  /** GRBL machine state word as reported (Idle, Run, Hold:0, Alarm, …). */
  grblState: string;
  position?: { x: number; y: number; z: number };
  /** Whether the position was machine (MPos) or work (WPos) coordinates. */
  positionType?: 'MPos' | 'WPos';
  feedRate?: number;
}

const GRBL_STATE_MAP: Array<[RegExp, MachineState]> = [
  [/^idle$/i, 'idle'],
  [/^(run|jog|home|check)$/i, 'running'],
  [/^(hold|door)/i, 'paused'],
  [/^alarm$/i, 'error'],
  [/^sleep$/i, 'idle'],
];

/**
 * Parse a GRBL real-time status line like:
 *   `<Idle|MPos:0.000,0.000,0.000|FS:0,0>`
 *   `<Run|WPos:12.500,-3.100,1.000|FS:500,8000>`
 *   `<Hold:0|MPos:5.000,5.000,0.000|FS:0,0>`
 * Returns null for anything that isn't a status report.
 */
export function parseGrblStatus(line: string): GrblStatusReport | null {
  const m = line.trim().match(/^<([^|>]+)((?:\|[^>]*)?)>$/);
  if (!m) return null;
  const grblState = m[1].trim();
  const fields = m[2].split('|').filter(Boolean);

  const mapped = GRBL_STATE_MAP.find(([re]) => re.test(grblState.split(':')[0]));
  const state: MachineState = mapped ? mapped[1] : 'running';

  let position: GrblStatusReport['position'];
  let positionType: GrblStatusReport['positionType'];
  let feedRate: number | undefined;

  for (const field of fields) {
    const [key, value] = field.split(':', 2);
    if ((key === 'MPos' || key === 'WPos') && value) {
      const nums = value.split(',').map(Number);
      if (nums.length >= 3 && nums.slice(0, 3).every(Number.isFinite)) {
        position = { x: nums[0], y: nums[1], z: nums[2] };
        positionType = key;
      }
    } else if ((key === 'FS' || key === 'F') && value) {
      const f = Number(value.split(',')[0]);
      if (Number.isFinite(f)) feedRate = f;
    }
  }

  return { state, grblState, position, positionType, feedRate };
}

export interface MarlinTemps {
  nozzle?: number;
  nozzleTarget?: number;
  bed?: number;
  bedTarget?: number;
}

/**
 * Parse a Marlin M105 temperature report like:
 *   `ok T:210.4 /210.0 B:60.1 /60.0 @:127 B@:127`
 *   `T:24.3 /0.0 B:23.9 /0.0 @:0 B@:0` (autoreport)
 * Returns null when the line carries no temperature info.
 */
export function parseMarlinTemps(line: string): MarlinTemps | null {
  const t = line.match(/\bT:\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  const b = line.match(/\bB:\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (!t && !b) return null;
  const out: MarlinTemps = {};
  if (t) { out.nozzle = Number(t[1]); out.nozzleTarget = Number(t[2]); }
  if (b) { out.bed = Number(b[1]); out.bedTarget = Number(b[2]); }
  return out;
}

// ── Serial transport ────────────────────────────────────────────────────────

export interface SerialTransport {
  open(): Promise<void>;
  /** Write raw data (append your own newline where needed). */
  write(data: string): Promise<void>;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
  close(): Promise<void>;
  readonly isOpen: boolean;
}

/** Runtime-only import so neither tsc nor rollup tries to resolve serialport. */
async function loadSerialport(): Promise<Record<string, any> | null> {
  try {
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<Record<string, any>>;
    return await dynamicImport('serialport');
  } catch {
    return null;
  }
}

/** Real transport over node-serialport. Throws SERIAL_SETUP_MESSAGE when missing. */
export async function createSerialTransport(devicePath: string, baudRate: number): Promise<SerialTransport> {
  const mod = await loadSerialport();
  if (!mod?.SerialPort) throw new Error(SERIAL_SETUP_MESSAGE);
  const SerialPortCtor = mod.SerialPort;

  let port: any = null;
  const lineCbs: Array<(line: string) => void> = [];
  const closeCbs: Array<() => void> = [];
  let buffer = '';

  return {
    get isOpen() { return Boolean(port?.isOpen); },
    open() {
      return new Promise<void>((resolve, reject) => {
        port = new SerialPortCtor({ path: devicePath, baudRate, autoOpen: false });
        port.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (line) for (const cb of lineCbs) cb(line);
          }
        });
        port.on('close', () => { for (const cb of closeCbs) cb(); });
        port.open((err: Error | null) => (err ? reject(err) : resolve()));
      });
    },
    write(data: string) {
      return new Promise<void>((resolve, reject) => {
        if (!port?.isOpen) { reject(new Error('Serial port is not open.')); return; }
        port.write(data, (err: Error | null) => (err ? reject(err) : resolve()));
      });
    },
    onLine(cb) { lineCbs.push(cb); },
    onClose(cb) { closeCbs.push(cb); },
    close() {
      return new Promise<void>((resolve) => {
        if (!port?.isOpen) { resolve(); return; }
        port.close(() => resolve());
      });
    },
  };
}

// ── Device discovery (works without serialport) ─────────────────────────────

export interface SerialDeviceInfo {
  devicePath: string;
  description: string;
}

export async function listSerialDevices(): Promise<SerialDeviceInfo[]> {
  // Preferred: serialport's own enumerator (richer metadata).
  const mod = await loadSerialport();
  if (mod?.SerialPort?.list) {
    try {
      const ports = (await mod.SerialPort.list()) as Array<{ path: string; manufacturer?: string }>;
      return ports
        .filter((p) => /usb|acm/i.test(p.path))
        .map((p) => ({ devicePath: p.path, description: p.manufacturer || 'USB serial device' }));
    } catch { /* fall through to ls */ }
  }
  // Fallback: shell listing — no native dep needed.
  if (process.platform === 'win32') return [];
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', 'ls /dev/tty.usb* /dev/cu.usb* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null']);
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', () => {
      resolve(
        out.trim().split('\n').filter(Boolean).map((devicePath) => ({
          devicePath: devicePath.trim(),
          description: 'USB serial device',
        })),
      );
    });
    child.on('error', () => resolve([]));
  });
}

// ── G-code streaming with ok flow control ───────────────────────────────────

/** Strip comments/blank lines; returns the sendable lines. */
export function prepareGcodeLines(gcode: string): string[] {
  return gcode
    .split('\n')
    .map((l) => l.replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim())
    .filter(Boolean);
}

class GcodeStreamer {
  private lines: string[] = [];
  private index = 0;
  private paused = false;
  private aborted = false;
  private waiting: (() => void) | null = null;
  active = false;
  jobName = '';

  constructor(private transport: SerialTransport) {}

  get progressPct(): number | undefined {
    if (!this.active || this.lines.length === 0) return undefined;
    return Math.round((this.index / this.lines.length) * 100);
  }

  /** Call for every incoming serial line — releases the next G-code line on ok. */
  handleLine(line: string): void {
    const l = line.trim().toLowerCase();
    if (l === 'ok' || l.startsWith('ok ') || l.startsWith('error')) {
      this.waiting?.();
      this.waiting = null;
    }
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  abort(): void {
    this.aborted = true;
    this.waiting?.();
    this.waiting = null;
  }

  async run(lines: string[], jobName: string): Promise<void> {
    if (this.active) throw new Error('A streamed job is already running.');
    this.lines = lines;
    this.index = 0;
    this.paused = false;
    this.aborted = false;
    this.active = true;
    this.jobName = jobName;
    try {
      while (this.index < this.lines.length && !this.aborted) {
        if (this.paused) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        const line = this.lines[this.index];
        const ack = new Promise<void>((resolve) => { this.waiting = resolve; });
        await this.transport.write(line + '\n');
        // Wait for ok (or error) with a generous ceiling so a wedged
        // controller can't hang the stream forever.
        await Promise.race([ack, new Promise((r) => setTimeout(r, 120_000))]);
        this.index++;
      }
    } finally {
      this.active = false;
      this.waiting = null;
    }
  }
}

// ── Shared serial driver base ───────────────────────────────────────────────

abstract class SerialDriverBase implements MachineDriver {
  abstract readonly protocol: 'marlin-serial' | 'grbl-serial';
  readonly capabilities: MachineCapabilities = { sendJob: true, pauseResume: true, stop: true };

  protected transport: SerialTransport | null = null;
  protected streamer: GcodeStreamer | null = null;
  protected connected = false;

  constructor(protected config: MachineConnectionConfig) {}

  protected get devicePath(): string { return String(this.config.devicePath ?? '').trim(); }
  protected get baudRate(): number { return Number(this.config.baudRate) || 115200; }

  async connect(): Promise<void> {
    if (!this.devicePath) throw new Error('Serial connection needs a device path (e.g. /dev/tty.usbmodem…).');
    const transport = await createSerialTransport(this.devicePath, this.baudRate);
    await transport.open();
    this.transport = transport;
    this.streamer = new GcodeStreamer(transport);
    transport.onLine((line) => {
      this.streamer?.handleLine(line);
      this.onSerialLine(line);
    });
    transport.onClose(() => { this.connected = false; });
    this.connected = true;
    // Give the controller a moment after the open-triggered reset.
    await new Promise((r) => setTimeout(r, 1500));
    await this.afterConnect();
  }

  protected abstract onSerialLine(line: string): void;
  protected async afterConnect(): Promise<void> { /* per protocol */ }

  async disconnect(): Promise<void> {
    this.streamer?.abort();
    this.connected = false;
    const t = this.transport;
    this.transport = null;
    this.streamer = null;
    if (t) await t.close();
  }

  protected async write(data: string): Promise<void> {
    if (!this.transport?.isOpen) throw new Error('Not connected.');
    await this.transport.write(data);
  }

  async sendJob(filePath: string): Promise<MachineActionResult> {
    if (!this.transport?.isOpen || !this.streamer) return { ok: false, error: 'Not connected.' };
    if (this.streamer.active) return { ok: false, error: 'A job is already streaming to this machine.' };
    if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
    const lines = prepareGcodeLines(fs.readFileSync(filePath, 'utf8'));
    if (lines.length === 0) return { ok: false, error: 'File contains no sendable G-code.' };
    const jobName = path.basename(filePath);
    // Stream in the background; status polling reports progress.
    void this.streamer.run(lines, jobName).catch((e) => {
      console.warn(`[machines:${this.protocol}] stream error:`, e instanceof Error ? e.message : e);
    });
    return { ok: true, message: `Streaming ${jobName} (${lines.length} lines) over serial.` };
  }

  abstract getStatus(): Promise<MachineStatus>;
  abstract pause(): Promise<MachineActionResult>;
  abstract resume(): Promise<MachineActionResult>;
  abstract stop(): Promise<MachineActionResult>;
}

// ── Marlin ──────────────────────────────────────────────────────────────────

export class MarlinSerialDriver extends SerialDriverBase {
  readonly protocol = 'marlin-serial' as const;

  private temps: MarlinTemps = {};
  private paused = false;

  protected onSerialLine(line: string): void {
    const t = parseMarlinTemps(line);
    if (t) this.temps = { ...this.temps, ...t };
  }

  protected async afterConnect(): Promise<void> {
    await this.write('M105\n').catch(() => { /* first poll is best-effort */ });
  }

  async getStatus(): Promise<MachineStatus> {
    if (!this.transport?.isOpen) return { state: 'offline' };
    // Poll temps; the report arrives async and lands in this.temps.
    await this.write('M105\n').catch(() => { /* keep last known */ });
    const streaming = this.streamer?.active ?? false;
    const state: MachineState = streaming ? (this.paused ? 'paused' : 'printing') : 'idle';
    return {
      state,
      progressPct: this.streamer?.progressPct,
      jobName: streaming ? this.streamer?.jobName : undefined,
      tempNozzle: this.temps.nozzle,
      tempNozzleTarget: this.temps.nozzleTarget,
      tempBed: this.temps.bed,
      tempBedTarget: this.temps.bedTarget,
    };
  }

  async pause(): Promise<MachineActionResult> {
    try {
      this.streamer?.pause();
      await this.write('M25\n'); // pause SD print (harmless when streaming)
      this.paused = true;
      return { ok: true, message: 'Paused.' };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }

  async resume(): Promise<MachineActionResult> {
    try {
      await this.write('M24\n'); // resume SD print
      this.streamer?.resume();
      this.paused = false;
      return { ok: true, message: 'Resumed.' };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }

  async stop(): Promise<MachineActionResult> {
    try {
      this.streamer?.abort();
      this.paused = false;
      // M524 aborts an SD print on modern Marlin; M112 is the emergency stop
      // fallback older firmwares understand.
      await this.write('M524\n');
      await this.write('M112\n').catch(() => { /* best effort */ });
      return { ok: true, message: 'Stop sent (M524 + M112).' };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
}

// ── GRBL ────────────────────────────────────────────────────────────────────

export class GrblSerialDriver extends SerialDriverBase {
  readonly protocol = 'grbl-serial' as const;

  private lastReport: GrblStatusReport | null = null;

  protected onSerialLine(line: string): void {
    const report = parseGrblStatus(line);
    if (report) this.lastReport = report;
  }

  protected async afterConnect(): Promise<void> {
    await this.write('?').catch(() => { /* first poll is best-effort */ });
  }

  async getStatus(): Promise<MachineStatus> {
    if (!this.transport?.isOpen) return { state: 'offline' };
    // '?' is a real-time command — no newline needed, answered immediately.
    await this.write('?').catch(() => { /* keep last known */ });
    const r = this.lastReport;
    const streaming = this.streamer?.active ?? false;
    let state: MachineState = r?.state ?? (streaming ? 'running' : 'idle');
    if (streaming && state === 'idle') state = 'running';
    return {
      state,
      progressPct: this.streamer?.progressPct,
      jobName: streaming ? this.streamer?.jobName : undefined,
      positionXYZ: r?.position,
      raw: r?.grblState,
    };
  }

  /** '$H' — run GRBL's homing cycle. Exposed via machines:job action 'home'. */
  async home(): Promise<MachineActionResult> {
    try {
      await this.write('$H\n');
      return { ok: true, message: 'Homing cycle started ($H).' };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }

  async pause(): Promise<MachineActionResult> {
    try {
      this.streamer?.pause();
      await this.write('!'); // feed hold (real-time)
      return { ok: true, message: 'Feed hold (!).' };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }

  async resume(): Promise<MachineActionResult> {
    try {
      await this.write('~'); // cycle start / resume (real-time)
      this.streamer?.resume();
      return { ok: true, message: 'Cycle start (~).' };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }

  async stop(): Promise<MachineActionResult> {
    try {
      this.streamer?.abort();
      await this.write('!'); // hold first so the reset doesn't lose steps mid-move
      await new Promise((r) => setTimeout(r, 150));
      await this.write('\x18'); // Ctrl-X soft reset
      return { ok: true, message: 'Stopped (feed hold + soft reset).' };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
}
