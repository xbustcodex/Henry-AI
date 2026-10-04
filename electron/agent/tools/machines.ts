/**
 * Machine tools — Henry answers "what's my printer doing?" and can pause /
 * resume / stop a job on any connected machine (3D printer or CNC).
 *
 * Backed by the MachineManager singleton (electron/machines/manager.ts).
 * Control tools are confirm-tier — they go through the existing approval
 * gate before anything moves (or stops moving) in the real world.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { getMachineManager } from '../../machines/manager';
import type { MachineStatus } from '../../machines/types';

function ok(data: unknown): ToolResult { return { ok: true, data }; }
function fail(error: string, retryable = false): ToolResult { return { ok: false, error, retryable }; }

function summarize(status: MachineStatus): string {
  const bits: string[] = [status.state];
  if (status.progressPct !== undefined) bits.push(`${status.progressPct}%`);
  if (status.jobName) bits.push(`job: ${status.jobName}`);
  if (status.tempNozzle !== undefined) {
    bits.push(`nozzle ${Math.round(status.tempNozzle)}°C${status.tempNozzleTarget ? `/${Math.round(status.tempNozzleTarget)}°C` : ''}`);
  }
  if (status.tempBed !== undefined) {
    bits.push(`bed ${Math.round(status.tempBed)}°C${status.tempBedTarget ? `/${Math.round(status.tempBedTarget)}°C` : ''}`);
  }
  if (status.timeRemainingSec !== undefined && status.timeRemainingSec > 0) {
    const mins = Math.round(status.timeRemainingSec / 60);
    bits.push(`~${mins} min left`);
  }
  if (status.positionXYZ) {
    const { x, y, z } = status.positionXYZ;
    bits.push(`at X${x.toFixed(1)} Y${y.toFixed(1)} Z${z.toFixed(1)}`);
  }
  return bits.join(', ');
}

/** Resolve a machine by id or (partial, case-insensitive) name. */
function resolveMachine(machine: string): { id: string; name: string } | { error: string } {
  const manager = getMachineManager();
  if (!manager) return { error: 'The machine layer is not running.' };
  const all = manager.list();
  if (all.length === 0) return { error: 'No machines are set up yet. Add one in the Machines panel → Connections.' };
  const q = machine.trim().toLowerCase();
  const hit =
    all.find((m) => m.id === machine) ??
    all.find((m) => m.name.toLowerCase() === q) ??
    all.find((m) => m.name.toLowerCase().includes(q));
  if (!hit) {
    return { error: `No machine matches "${machine}". Known machines: ${all.map((m) => m.name).join(', ')}.` };
  }
  return { id: hit.id, name: hit.name };
}

async function controlAction(
  machine: string,
  action: 'pause' | 'resume' | 'stop',
): Promise<ToolResult> {
  const manager = getMachineManager();
  if (!manager) return fail('The machine layer is not running.');
  const resolved = resolveMachine(machine);
  if ('error' in resolved) return fail(resolved.error);
  if (!manager.isConnected(resolved.id)) {
    return fail(`${resolved.name} is not connected. Connect it in the Machines panel first.`);
  }
  const r = await manager.job(resolved.id, action);
  if (!r.ok) return fail(r.error ?? `${action} failed.`);
  return ok({ machine: resolved.name, action, message: r.message });
}

const machineParam = {
  type: 'object' as const,
  properties: {
    machine: {
      type: 'string',
      description: 'The machine name (as saved in the Machines panel) or its id.',
    },
  },
  required: ['machine'],
  additionalProperties: false,
};

export function machineTools(): ToolDefinition[] {
  return [
    {
      name: 'machines_status',
      description:
        "Live status of every 3D printer and CNC machine Henry is connected to — " +
        "state (idle/printing/running/paused/error/offline), job progress, nozzle/bed " +
        "temperatures, time remaining, and CNC position. Use whenever the user asks " +
        "what a printer or CNC is doing, how a print is going, or if a machine is free.",
      category: 'system',
      safetyLevel: 'silent',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(): Promise<ToolResult> {
        const manager = getMachineManager();
        if (!manager) return fail('The machine layer is not running.');
        const all = await manager.statusAll();
        if (all.length === 0) {
          return ok({
            machines: [],
            summary: 'No machines are set up yet. Add one in the Machines panel → Connections.',
          });
        }
        const machines = all.map((m) => ({
          id: m.id,
          name: m.name,
          kind: m.kind,
          protocol: m.protocol,
          connected: m.connected,
          state: m.status.state,
          progressPct: m.status.progressPct,
          jobName: m.status.jobName,
          tempNozzle: m.status.tempNozzle,
          tempBed: m.status.tempBed,
          timeRemainingSec: m.status.timeRemainingSec,
          positionXYZ: m.status.positionXYZ,
          summary: `${m.name} (${m.protocol}): ${m.connected ? summarize(m.status) : 'not connected'}`,
        }));
        return ok({ machines, summary: machines.map((m) => m.summary).join(' | ') });
      },
    },

    {
      name: 'machine_pause',
      description:
        'Pause the current job on a connected 3D printer or CNC machine. ' +
        'Use when the user asks to pause a print or hold a CNC cut.',
      category: 'automation',
      safetyLevel: 'confirm',
      confirmPrompt: (p) => `Pause the job running on "${String(p.machine ?? '')}"`,
      inputSchema: machineParam,
      execute: (params) => controlAction(String(params.machine ?? ''), 'pause'),
    },

    {
      name: 'machine_resume',
      description:
        'Resume a paused job on a connected 3D printer or CNC machine.',
      category: 'automation',
      safetyLevel: 'confirm',
      confirmPrompt: (p) => `Resume the paused job on "${String(p.machine ?? '')}"`,
      inputSchema: machineParam,
      execute: (params) => controlAction(String(params.machine ?? ''), 'resume'),
    },

    {
      name: 'machine_stop',
      description:
        'STOP/cancel the current job on a connected 3D printer or CNC machine. ' +
        'Destructive — the job cannot be resumed after a stop. Only use when the ' +
        'user clearly asks to stop, cancel, or abort.',
      category: 'automation',
      safetyLevel: 'confirm',
      confirmPrompt: (p) =>
        `STOP the job on "${String(p.machine ?? '')}" — this cancels the print/cut and cannot be undone`,
      inputSchema: machineParam,
      execute: (params) => controlAction(String(params.machine ?? ''), 'stop'),
    },
  ];
}
