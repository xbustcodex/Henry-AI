/**
 * Henry AI — Computer Awareness System
 * Tracks what's happening on the machine: running apps, active app, permissions,
 * system health, recent files, and what Henry can or can't do right now.
 * Persists the last snapshot so Henry can reference it in conversation.
 */

import { create } from 'zustand';

const SNAPSHOT_KEY = 'henry:computer_snapshot';
const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export interface ComputerSnapshot {
  takenAt: number;
  platform: string;
  hostname: string;
  osVersion?: string;
  freeMemoryGB?: number;
  totalMemoryGB?: number;
  uptime?: string;
  runningApps: string[];
  activeApp?: string;
  recentFiles: string[];
  accessibility: boolean;
  screenRecording: boolean;
  canAct: boolean;
  blockedReason?: string;
  diskFreeGB?: number;
}

interface ComputerSnapshotState {
  snapshot: ComputerSnapshot | null;
  scanning: boolean;
  error: string | null;
  takeSnapshot: () => Promise<void>;
  loadLastSnapshot: () => void;
}

function safeLoad(): ComputerSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as ComputerSnapshot;
    if (Date.now() - s.takenAt > SNAPSHOT_MAX_AGE_MS) return null;
    return s;
  } catch {
    return null;
  }
}

function safeSave(s: ComputerSnapshot) {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export const useComputerSnapshotStore = create<ComputerSnapshotState>((set) => ({
  snapshot: safeLoad(),
  scanning: false,
  error: null,

  loadLastSnapshot: () => set({ snapshot: safeLoad() }),

  takeSnapshot: async () => {
    set({ scanning: true, error: null });
    try {
      const api = (window as any).henryAPI;
      const isDesktop = !!api?.computerCheckPermissions;

      if (!isDesktop) {
        set({
          scanning: false,
          error: 'Full computer awareness requires the desktop app.',
          snapshot: {
            takenAt: Date.now(),
            platform: 'web',
            hostname: 'browser',
            runningApps: [],
            recentFiles: [],
            accessibility: false,
            screenRecording: false,
            canAct: false,
            blockedReason: 'Running in browser — desktop app required for computer awareness.',
          },
        });
        return;
      }

      const [permsResult, sysResult, appsResult] = await Promise.allSettled([
        api.computerCheckPermissions(),
        api.computerSystemInfo(),
        api.computerListApps(),
      ]);

      const perms = permsResult.status === 'fulfilled' ? permsResult.value : null;
      const sys = sysResult.status === 'fulfilled' ? sysResult.value : null;
      const appsData = appsResult.status === 'fulfilled' ? appsResult.value : null;

      // Try to get the active/front app via AppleScript
      let activeApp: string | undefined;
      try {
        const r = await api.computerOsascript('tell application "System Events" to name of first application process whose frontmost is true');
        if (r?.output) activeApp = r.output.trim();
      } catch { /* ignore */ }

      // Try to get recent files from Downloads
      let recentFiles: string[] = [];
      try {
        const r = await api.computerRunShell({ command: 'ls -t ~/Downloads | head -5', timeout: 5000 });
        if (r?.output) {
          recentFiles = r.output.split('\n').filter(Boolean).slice(0, 5);
        }
      } catch { /* ignore */ }

      const accessibility = perms?.accessibility ?? false;
      const screenRecording = perms?.screenRecording ?? false;
      const canAct = accessibility;
      const blockedReason = !canAct ? 'Accessibility permission is not enabled — Henry cannot click apps or control the computer.' : undefined;

      const snapshot: ComputerSnapshot = {
        takenAt: Date.now(),
        platform: perms?.platform || sys?.platform || 'unknown',
        hostname: sys?.hostname || 'unknown',
        osVersion: sys?.osVersion,
        freeMemoryGB: sys?.freeMemoryGB,
        totalMemoryGB: sys?.totalMemoryGB,
        uptime: sys?.uptime,
        runningApps: (appsData?.apps || []).slice(0, 20),
        activeApp,
        recentFiles,
        accessibility,
        screenRecording,
        canAct,
        blockedReason,
      };

      safeSave(snapshot);
      set({ snapshot, scanning: false });
    } catch (e: any) {
      set({ scanning: false, error: e?.message || 'Snapshot failed.' });
    }
  },
}));

/** Injected into charter.ts when a recent snapshot exists. */
export function buildComputerSnapshotBlock(): string {
  let snapshot: ComputerSnapshot | null = null;
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (raw) {
      const s = JSON.parse(raw) as ComputerSnapshot;
      if (Date.now() - s.takenAt <= SNAPSHOT_MAX_AGE_MS) snapshot = s;
    }
  } catch { /* ignore */ }

  if (!snapshot) return '';

  const age = Math.round((Date.now() - snapshot.takenAt) / 60000);
  const ageStr = age <= 1 ? 'just now' : `${age} min ago`;

  const lines: string[] = [`## Computer snapshot (taken ${ageStr})`];

  lines.push(`Machine: ${snapshot.hostname}, ${snapshot.platform}${snapshot.osVersion ? `, ${snapshot.osVersion}` : ''}${snapshot.freeMemoryGB != null ? `, ${snapshot.freeMemoryGB}GB RAM free` : ''}.`);

  if (snapshot.activeApp) {
    lines.push(`Active app: ${snapshot.activeApp}.`);
  }

  if (snapshot.runningApps.length) {
    const displayed = snapshot.runningApps.slice(0, 8).join(', ');
    const extra = snapshot.runningApps.length > 8 ? ` (+${snapshot.runningApps.length - 8} more)` : '';
    lines.push(`Open apps: ${displayed}${extra}.`);
  }

  if (snapshot.recentFiles.length) {
    lines.push(`Recent Downloads: ${snapshot.recentFiles.join(', ')}.`);
  }

  const permLines: string[] = [];
  permLines.push(`Accessibility: ${snapshot.accessibility ? 'enabled' : 'not enabled'}`);
  permLines.push(`Screen recording: ${snapshot.screenRecording ? 'enabled' : 'not enabled'}`);
  lines.push(`Permissions — ${permLines.join(', ')}.`);

  if (!snapshot.canAct && snapshot.blockedReason) {
    lines.push(`Blocked: ${snapshot.blockedReason}`);
  } else if (snapshot.canAct) {
    lines.push(`Status: Henry can open apps, run commands, and control this computer.`);
  }

  return lines.join('\n');
}
