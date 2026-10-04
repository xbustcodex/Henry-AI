/**
 * A brand-new profile must arrive empty.
 *
 * `initDatabase` used to write eight default settings rows — including
 * `setup_complete` and empty `companion_provider` / `companion_model` values —
 * and seeded the Project Vault with the developer's own businesses. Both made
 * a profile that had never been configured look like one that had: the
 * first-launch gate reads settings and provider rows to decide whether setup
 * has been done, so a seeded row is a seeded decision.
 *
 * These run the real `initDatabase` against a real SQLite file (via `node:sqlite`,
 * because the installed better-sqlite3 binary is built for Electron's ABI), and
 * then assert on what is actually in the file.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('better-sqlite3', async () => {
  const { DatabaseSync: Sync } = await import('node:sqlite');
  class Shim {
    private inner: InstanceType<typeof Sync>;
    constructor(file: string) {
      this.inner = new Sync(file);
      // `seedDefaults`-style helpers call `.transaction()`, which node:sqlite
      // does not have; the two constructors behave the same for our purposes.
      this.transaction = (fn: (...args: never[]) => unknown) =>
        ((...args: never[]) => {
          this.inner.exec('BEGIN');
          try {
            const out = fn(...args);
            this.inner.exec('COMMIT');
            return out;
          } catch (error) {
            this.inner.exec('ROLLBACK');
            throw error;
          }
        }) as never;
    }
    transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
    exec(sql: string) { this.inner.exec(sql); }
    pragma() { /* WAL is an Electron-runtime concern, not an assertion here */ }
    prepare(sql: string) { return this.inner.prepare(sql); }
    close() { this.inner.close(); }
  }
  return { default: Shim };
});

const { initDatabase } = await import('./database');
type Db = ReturnType<typeof initDatabase>;

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'henry-fresh-'));
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function count(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function settingsOf(db: Db): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
describe('a brand-new database', () => {
  // One real init for the whole block: every assertion here reads, none writes,
  // and re-running the schema per test costs ~7s each for no extra coverage.
  let db: Db;
  beforeAll(() => { db = initDatabase(dataDir); }, 60_000);
  afterAll(() => { try { db.close(); } catch { /* already closed */ } });

  it('holds no settings rows at all, so nothing can look configured', () => {
    expect(settingsOf(db)).toEqual({});
  });

  it('does not claim setup is complete, or that no provider is selected, by writing a row', () => {
    // The explicit form: these two keys are what the first-launch gate reads.
    const settings = settingsOf(db);
    expect(settings.setup_complete).toBeUndefined();
    expect(settings.companion_provider).toBeUndefined();
    expect(settings.companion_model).toBeUndefined();
  });

  it('holds no provider rows, and therefore no credentials', () => {
    expect(count(db, 'providers')).toBe(0);
  });

  it('holds no conversations, tasks, memories or approvals', () => {
    for (const table of ['conversations', 'messages', 'tasks', 'memory_facts', 'approvals']) {
      expect(count(db, table)).toBe(0);
    }
  });

  it('holds nobody else\'s projects', () => {
    const rows = db.prepare('SELECT name FROM projects').all() as Array<{ name: string }>;
    expect(rows).toEqual([]);
  });

  it('carries no credential of any kind in any table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          expect(String(value), `${name}.${column}`).not.toMatch(/\b(sk-|gsk_|sk-or-|AIza)/);
        }
      }
    }
  });
});

describe('an existing database', () => {
  it('keeps its configuration when the schema is re-applied on the next launch', () => {
    // A second, separate profile: the existing-user path must be untouched by
    // removing the seeds, or every real user loses their settings on upgrade.
    const existingDir = mkdtempSync(path.join(tmpdir(), 'henry-existing-'));
    try {
      const first = initDatabase(existingDir);
      first.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('setup_complete', 'true');
      first.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('companion_provider', 'opencode-zen');
      first
        .prepare('INSERT INTO providers (id, name, api_key, enabled, models) VALUES (?, ?, ?, 1, ?)')
        .run('opencode-zen', 'OpenCode Zen', 'enc:v1:not-a-real-secret', '[]');
      first.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run('p1', 'My project', 'work');
      first.close();

      const second = initDatabase(existingDir);

      expect(settingsOf(second).setup_complete).toBe('true');
      expect(settingsOf(second).companion_provider).toBe('opencode-zen');
      expect(count(second, 'providers')).toBe(1);
      expect(count(second, 'projects')).toBe(1);
      second.close();
    } finally {
      rmSync(existingDir, { recursive: true, force: true });
    }
  }, 60_000);
});