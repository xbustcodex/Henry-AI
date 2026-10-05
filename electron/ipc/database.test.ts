import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// better-sqlite3 in node_modules is rebuilt against Electron's ABI and will not
// dlopen under plain Node. node:sqlite is the same SQL engine and is what the other
// real-database tests in this repo use.
import { DatabaseSync } from 'node:sqlite';

/**
 * Deleting a credential row must actually remove the credential.
 *
 * SQLite does NOT overwrite content on DELETE unless told to, so a provider row holding a
 * key — a retired one removed during migration, or any row a user deletes — leaves the
 * plaintext sitting in freed pages of the database file.
 *
 * Found on a real upgrade profile: `migrateRetiredProviders` removed the Groq row from
 * every live table, but the key string was still readable in `henry.db` itself. A row
 * deletion that leaves the secret recoverable does not satisfy "remove obsolete credential
 * storage", so `initDatabase` now sets `PRAGMA secure_delete = ON`.
 */
describe('credential bytes do not survive deletion', () => {
  it('zeroes deleted content so a removed key is not recoverable from the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-securedel-'));
    const file = path.join(dir, 'henry.db');
    const SECRET = 'gsk_planted_retired_credential_0123456789';
    try {
      const db = new DatabaseSync(file);
      db.exec('PRAGMA secure_delete = ON');
      db.exec('CREATE TABLE providers (id TEXT PRIMARY KEY, api_key TEXT)');
      db.prepare('INSERT INTO providers VALUES (?, ?)').run('groq', SECRET);
      db.prepare('DELETE FROM providers WHERE id = ?').run('groq');
      db.close();

      expect(fs.readFileSync(file).includes(Buffer.from(SECRET, 'utf8'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proves the guard is load-bearing: without secure_delete the secret survives', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-securedel-guard-'));
    const file = path.join(dir, 'henry.db');
    const SECRET = 'gsk_planted_retired_credential_guard_9876543210';
    try {
      const db = new DatabaseSync(file);
      // Deliberately NOT setting secure_delete — this is the default Henry would have had.
      db.exec('CREATE TABLE providers (id TEXT PRIMARY KEY, api_key TEXT)');
      db.prepare('INSERT INTO providers VALUES (?, ?)').run('groq', SECRET);
      db.prepare('DELETE FROM providers WHERE id = ?').run('groq');
      db.close();

      // If this ever becomes false the default changed and the pragma above is no longer
      // what is protecting the file — the regression test would then pass vacuously.
      expect(fs.readFileSync(file).includes(Buffer.from(SECRET, 'utf8'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});