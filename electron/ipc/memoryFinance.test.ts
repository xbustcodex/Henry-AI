/**
 * `finance:create` supplies `updated_at`, but the original `transactions` DDL omitted it.
 * Every insert therefore raised `no such column: updated_at`, and the renderer's import
 * loop swallowed the throw while still reporting success — so bank CSV import recorded
 * nothing and told the user it had worked.
 *
 * CREATE TABLE IF NOT EXISTS cannot add a column to an existing install, so this also
 * covers the migration path rather than only a fresh database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureFinanceSchema } from './memory';

const OLD_DDL = `CREATE TABLE transactions (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, amount REAL NOT NULL,
  category TEXT NOT NULL, description TEXT, date TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

describe('finance transactions schema', () => {
  let dir = '';

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-finance-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('accepts the updated_at column finance:create supplies, on a fresh database', () => {
    const file = path.join(dir, 'fresh.db');
    const db = new DatabaseSync(file);
    ensureFinanceSchema(db as never);
    const cols = (db.prepare('PRAGMA table_info(transactions)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('updated_at');

    db.prepare(
      'INSERT INTO transactions (id,date,description,category,amount,type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run('t1', '2026-01-01', 'x', 'other', 1.5, 'expense', 'now', 'now');
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('migrates an existing install whose table predates updated_at', () => {
    const file = path.join(dir, 'legacy.db');
    const db = new DatabaseSync(file);
    // Exactly the shape an already-installed Henry has.
    db.exec(OLD_DDL);
    db.prepare('INSERT INTO transactions (id,date,description,category,amount,type,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('old', '2026-01-01', 'kept', 'other', 9, 'expense', 'now');
    ensureFinanceSchema(db as never);

    const cols = (db.prepare('PRAGMA table_info(transactions)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('updated_at');

    // The pre-existing row survives the migration, and a new one now inserts cleanly.
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(1);
    db.prepare(
      'INSERT INTO transactions (id,date,description,category,amount,type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run('new', '2026-01-02', 'y', 'other', 2, 'expense', 'now', 'now');
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(2);
    db.close();
  });
});
