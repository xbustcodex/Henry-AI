/**
 * Machine connectivity layer — shared types.
 *
 * One contract for every machine Henry can talk to: 3D printers (Bambu LAN,
 * Klipper/Moonraker, OctoPrint, Marlin over USB serial) and CNCs (GRBL over
 * USB serial). Every driver normalizes its protocol's status into
 * `MachineStatus` so the renderer, the poll loop, and Henry's agent tools all
 * speak the same language.
 */

export type MachineKind = 'printer' | 'cnc';

export type MachineProtocol =
  | 'bambu'          // Bambu Lab LAN mode (MQTT over TLS :8883)
  | 'moonraker'      // Klipper / Moonraker REST (:7125)
  | 'octoprint'      // OctoPrint REST (X-Api-Key)
  | 'marlin-serial'  // Marlin over USB serial
  | 'grbl-serial';   // GRBL over USB serial

export type MachineState = 'idle' | 'printing' | 'running' | 'paused' | 'error' | 'offline';

/** Normalized live status every driver produces. */
export interface MachineStatus {
  state: MachineState;
  /** 0–100 job progress where known. */
  progressPct?: number;
  /** Hotend / spindle-adjacent temp (°C). Printers only. */
  tempNozzle?: number;
  tempNozzleTarget?: number;
  tempBed?: number;
  tempBedTarget?: number;
  /** Current job / file name where known. */
  jobName?: string;
  timeRemainingSec?: number;
  /** Machine position — CNC (GRBL) and Klipper toolhead. */
  positionXYZ?: { x: number; y: number; z: number };
  /** Last raw protocol payload, for debugging. */
  raw?: unknown;
}

/** Per-protocol connection settings. Only the relevant fields are used. */
export interface MachineConnectionConfig {
  /** Network host/IP (bambu, moonraker, octoprint). */
  host?: string;
  /** Override port (moonraker 7125, octoprint 80/5000, bambu 8883). */
  port?: number;
  /** Bambu: printer serial number (from the printer's screen / Bambu Studio). */
  serialNumber?: string;
  /** Bambu: LAN access code. */
  accessCode?: string;
  /** OctoPrint: API key. */
  apiKey?: string;
  /** Serial: device path, e.g. /dev/tty.usbmodem1101. */
  devicePath?: string;
  /** Serial: baud rate (Marlin usually 115200, GRBL 115200). */
  baudRate?: number;
}

/** A saved machine connection (machine_connections table). */
export interface MachineConnection {
  id: string;
  name: string;
  kind: MachineKind;
  protocol: MachineProtocol;
  config: MachineConnectionConfig;
  created_at?: string;
  updated_at?: string;
}

/** Uniform result for job/control actions. */
export interface MachineActionResult {
  ok: boolean;
  message?: string;
  error?: string;
}

/** What a driver can actually do — the UI greys out the rest. */
export interface MachineCapabilities {
  sendJob: boolean;
  pauseResume: boolean;
  stop: boolean;
}

/**
 * The driver contract every protocol implements. Drivers are stateful (one
 * instance per connected machine, owned by the MachineManager).
 */
export interface MachineDriver {
  readonly protocol: MachineProtocol;
  readonly capabilities: MachineCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Normalized live status. Must not throw — return state 'offline'/'error'. */
  getStatus(): Promise<MachineStatus>;
  /** Upload + start a job (G-code file) where supported. */
  sendJob(filePath: string): Promise<MachineActionResult>;
  pause(): Promise<MachineActionResult>;
  resume(): Promise<MachineActionResult>;
  stop(): Promise<MachineActionResult>;
  /** Run the machine's homing cycle (CNC/GRBL '$H'). Optional per protocol. */
  home?(): Promise<MachineActionResult>;
}

/** A machine candidate found by lightweight discovery. */
export interface DiscoveredMachine {
  host?: string;
  port?: number;
  devicePath?: string;
  protocolGuess: MachineProtocol | 'unknown';
  label: string;
  via: 'port-scan' | 'serial';
}

/** Event pushed to the renderer over `machines:event`. */
export interface MachineEvent {
  type: 'status' | 'connected' | 'disconnected' | 'job-progress' | 'error';
  machineId: string;
  status?: MachineStatus;
  message?: string;
}

export const OFFLINE_STATUS: MachineStatus = { state: 'offline' };
