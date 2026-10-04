/**
 * Machine connectivity IPC — the renderer's door into the MachineManager.
 *
 * Channels (uniform `{ ok, result | error }` envelope, matching the other
 * maker-suite handlers):
 *   machines:list | add | update | remove
 *   machines:connect | disconnect
 *   machines:status (one) | statusAll
 *   machines:job  ({ id, action: send|pause|resume|stop|home, filePath? })
 *   machines:discover  (opt-in, time-boxed LAN port scan + serial listing)
 *
 * Live updates: main pushes `machines:event` (status/connected/disconnected)
 * from the manager's 10 s poll loop for connected machines only.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { initMachineManager } from './manager';
import type { MachineConnectionConfig, MachineKind, MachineProtocol } from './types';

type Envelope<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

async function envelope<T>(fn: () => T | Promise<T>): Promise<Envelope<T>> {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function registerMachineHandlers(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
): void {
  const manager = initMachineManager(db, getWindow);

  ipcMain.handle('machines:list', () => envelope(() => manager.list()));

  ipcMain.handle(
    'machines:add',
    (_e, input: { name: string; kind: MachineKind; protocol: MachineProtocol; config: MachineConnectionConfig }) =>
      envelope(() => manager.add(input ?? ({} as never))),
  );

  ipcMain.handle(
    'machines:update',
    (_e, payload: { id: string; patch: { name?: string; kind?: MachineKind; protocol?: MachineProtocol; config?: MachineConnectionConfig } }) =>
      envelope(() => manager.update(String(payload?.id ?? ''), payload?.patch ?? {})),
  );

  ipcMain.handle('machines:remove', (_e, payload: { id: string }) =>
    envelope(async () => {
      await manager.remove(String(payload?.id ?? ''));
      return { removed: true };
    }),
  );

  ipcMain.handle('machines:connect', (_e, payload: { id: string }) =>
    envelope(async () => {
      const id = String(payload?.id ?? '');
      const status = await manager.connect(id);
      return { status, capabilities: manager.capabilities(id) };
    }),
  );

  ipcMain.handle('machines:disconnect', (_e, payload: { id: string }) =>
    envelope(async () => {
      await manager.disconnect(String(payload?.id ?? ''));
      return { disconnected: true };
    }),
  );

  ipcMain.handle('machines:status', (_e, payload: { id: string }) =>
    envelope(() => manager.status(String(payload?.id ?? ''))),
  );

  ipcMain.handle('machines:statusAll', () => envelope(() => manager.statusAll()));

  ipcMain.handle(
    'machines:job',
    (_e, payload: { id: string; action: 'send' | 'pause' | 'resume' | 'stop' | 'home'; filePath?: string }) =>
      envelope(async () => {
        const r = await manager.job(String(payload?.id ?? ''), payload?.action, payload?.filePath);
        if (!r.ok) throw new Error(r.error ?? 'Job action failed.');
        return r;
      }),
  );

  ipcMain.handle('machines:discover', () => envelope(() => manager.discover()));
}
