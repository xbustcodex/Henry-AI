/**
 * Book Engine IPC (build plan, Phase 3) — the renderer's boundary to Topher's
 * captured life material. Mirrors the book agent tools so the panel and Henry
 * (and the Book Crew) write to the same table.
 *
 * Channels (match preload.ts):
 *   - `book:list`   → entries, optionally filtered by kind
 *   - `book:create` → capture a new entry
 *   - `book:update` → patch an entry by id
 *   - `book:delete` → remove an entry by id
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';

type Row = Record<string, unknown>;

const FIELDS = `id, kind, title, content, created_at, updated_at`;

export const BOOK_KINDS = [
  'story', 'lesson', 'letter', 'faith', 'health', 'fatherhood', 'business', 'money', 'other',
] as const;
const VALID_KIND = new Set<string>(BOOK_KINDS);
const EDITABLE = new Set(['kind', 'title', 'content']);

function safe<T>(fn: () => T) {
  try {
    return { ok: true as const, result: fn() };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

function genId(): string {
  return `book_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function registerBookHandlers(db: Database.Database): void {
  ipcMain.handle('book:list', (_e, payload?: { kind?: string; limit?: number }) =>
    safe(() => {
      const limit = Math.min(Number(payload?.limit) || 500, 2000);
      const kind = payload?.kind;
      const sql = kind
        ? `SELECT ${FIELDS} FROM book_entries WHERE kind = ? ORDER BY updated_at DESC LIMIT ?`
        : `SELECT ${FIELDS} FROM book_entries ORDER BY updated_at DESC LIMIT ?`;
      return (kind ? db.prepare(sql).all(kind, limit) : db.prepare(sql).all(limit)) as Row[];
    }),
  );

  ipcMain.handle('book:create', (_e, payload: { content: string; kind?: string; title?: string }) =>
    safe(() => {
      const content = String(payload?.content ?? '').trim();
      if (!content) throw new Error('There\'s nothing to save yet.');
      const kind = payload?.kind && VALID_KIND.has(String(payload.kind)) ? String(payload.kind) : 'story';
      const id = genId();
      db.prepare(
        `INSERT INTO book_entries (id, kind, title, content) VALUES (?, ?, ?, ?)`,
      ).run(id, kind, payload.title != null ? String(payload.title) : null, content);
      return db.prepare(`SELECT ${FIELDS} FROM book_entries WHERE id = ?`).get(id) as Row;
    }),
  );

  ipcMain.handle('book:update', (_e, payload: { id: string; patch: Record<string, unknown> }) =>
    safe(() => {
      const id = String(payload?.id ?? '').trim();
      if (!id) throw new Error('id is required');
      const patch = payload?.patch ?? {};
      const sets: string[] = [];
      const args: unknown[] = [];
      for (const [key, value] of Object.entries(patch)) {
        if (!EDITABLE.has(key)) continue;
        if (key === 'kind' && !VALID_KIND.has(String(value))) throw new Error(`Unknown kind: ${String(value)}`);
        sets.push(`${key} = ?`);
        args.push(value == null ? null : String(value));
      }
      if (sets.length === 0) throw new Error('No editable fields in patch');
      sets.push("updated_at = datetime('now')");
      const info = db.prepare(`UPDATE book_entries SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      if (info.changes === 0) throw new Error(`No entry found for id ${id}`);
      return db.prepare(`SELECT ${FIELDS} FROM book_entries WHERE id = ?`).get(id) as Row;
    }),
  );

  ipcMain.handle('book:delete', (_e, payload: { id: string }) =>
    safe(() => {
      const info = db.prepare('DELETE FROM book_entries WHERE id = ?').run(String(payload?.id ?? ''));
      return { deleted: info.changes > 0 };
    }),
  );
}
