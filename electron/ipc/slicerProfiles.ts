/**
 * Slicer profiles IPC (slicer plan, P2). CRUD over the `slicer_profiles` table —
 * named bundles of CuraEngine settings + an optional printer-def override and a
 * material label, picked when slicing.
 *
 * Channels: `slicerProfiles:list` / `create` / `update` / `delete`.
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';

type Row = Record<string, unknown>;

const FIELDS = `id, name, material, printer_def, settings_json, notes, created_at, updated_at`;
const EDITABLE = new Set(['name', 'material', 'printer_def', 'settings_json', 'notes']);

function safe<T>(fn: () => T) {
  try { return { ok: true as const, result: fn() }; }
  catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) }; }
}

/** Validate settings_json is a flat object of string/number values. */
function normalizeSettings(raw: unknown): string {
  if (raw == null) return '{}';
  let obj: unknown = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { throw new Error('Settings must be valid JSON.'); } }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('Settings must be a JSON object.');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return JSON.stringify(out);
}

export function registerSlicerProfileHandlers(db: Database.Database): void {
  ipcMain.handle('slicerProfiles:list', () =>
    safe(() => db.prepare(`SELECT ${FIELDS} FROM slicer_profiles ORDER BY name ASC`).all() as Row[]),
  );

  ipcMain.handle('slicerProfiles:create', (_e, p: { name: string; material?: string; printer_def?: string; settings?: unknown; notes?: string }) =>
    safe(() => {
      const name = String(p?.name ?? '').trim();
      if (!name) throw new Error('A profile name is required.');
      const id = `slp_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      db.prepare(
        `INSERT INTO slicer_profiles (id, name, material, printer_def, settings_json, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id, name,
        p.material != null ? String(p.material) : null,
        p.printer_def != null ? String(p.printer_def) : null,
        normalizeSettings(p.settings),
        p.notes != null ? String(p.notes) : null,
      );
      return db.prepare(`SELECT ${FIELDS} FROM slicer_profiles WHERE id = ?`).get(id) as Row;
    }),
  );

  ipcMain.handle('slicerProfiles:update', (_e, payload: { id: string; patch: Record<string, unknown> }) =>
    safe(() => {
      const id = String(payload?.id ?? '').trim();
      if (!id) throw new Error('id is required');
      const sets: string[] = [];
      const args: unknown[] = [];
      for (const [key, value] of Object.entries(payload?.patch ?? {})) {
        if (!EDITABLE.has(key)) continue;
        if (key === 'settings_json') { sets.push('settings_json = ?'); args.push(normalizeSettings(value)); continue; }
        sets.push(`${key} = ?`);
        args.push(value == null ? null : String(value));
      }
      if (sets.length === 0) throw new Error('No editable fields in patch');
      sets.push("updated_at = datetime('now')");
      const info = db.prepare(`UPDATE slicer_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      if (info.changes === 0) throw new Error(`No profile found for id ${id}`);
      return db.prepare(`SELECT ${FIELDS} FROM slicer_profiles WHERE id = ?`).get(id) as Row;
    }),
  );

  ipcMain.handle('slicerProfiles:delete', (_e, payload: { id: string }) =>
    safe(() => {
      const info = db.prepare('DELETE FROM slicer_profiles WHERE id = ?').run(String(payload?.id ?? ''));
      return { deleted: info.changes > 0 };
    }),
  );
}
