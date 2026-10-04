/**
 * The Zen credential across a restart.
 *
 * `providers:save` was the only writer of the OpenCode Zen key into the CLI's
 * child environment, and it runs once — when the user presses Save. Nothing put
 * it back on the next launch, so a configured Zen setup worked until Henry was
 * restarted and then quietly fell back to the unauthenticated slice of the
 * catalogue, with no error anywhere. `rehydrateOpencodeZenCredential` is the
 * boot-side half of that fix, and because it runs on every launch for every user
 * it has to be safe when there is nothing to rehydrate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  getOpencodeZenCredential,
  rehydrateOpencodeZenCredential,
  setOpencodeZenCredential,
} from './opencode';
import { encryptKey } from '../ipc/_keyStorage';

function providersDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT)');
  return db;
}

// node:sqlite's prepare().get() is signature-compatible with the narrow shape
// rehydrateOpencodeZenCredential accepts.
const asDb = (db: DatabaseSync) => db as unknown as Parameters<typeof rehydrateOpencodeZenCredential>[0];

beforeEach(() => {
  setOpencodeZenCredential('');
});

describe('a saved Zen key is restored at launch', () => {
  it('reads the key back out of the providers table', () => {
    const db = providersDb();
    db.prepare('INSERT INTO providers VALUES (?, ?, ?)').run(
      'opencode-zen',
      'OpenCode Zen',
      // Encrypted at rest, as providers:save writes it.
      encryptKey('zen-secret-key'),
    );
    rehydrateOpencodeZenCredential(asDb(db));
    expect(getOpencodeZenCredential()).toBe('zen-secret-key');
  });

  it('clears a key whose row was deleted', () => {
    // Otherwise a removed credential keeps working from the module-level cache
    // for the rest of the session.
    setOpencodeZenCredential('previously-loaded-key');
    rehydrateOpencodeZenCredential(asDb(providersDb()));
    expect(getOpencodeZenCredential()).toBe('');
  });

  it('ignores keys stored under other providers', () => {
    const db = providersDb();
    db.prepare('INSERT INTO providers VALUES (?, ?, ?)').run('acme-ai', 'Acme AI', encryptKey('not-a-real-secret'));
    rehydrateOpencodeZenCredential(asDb(db));
    expect(getOpencodeZenCredential()).toBe('');
  });

  it('does not throw when the providers table does not exist yet', () => {
    // Boot ordering: this must never be the thing that stops Henry starting.
    const empty = new DatabaseSync(':memory:');
    expect(() => rehydrateOpencodeZenCredential(asDb(empty))).not.toThrow();
  });

  it('trims a stored key with stray whitespace', () => {
    const db = providersDb();
    db.prepare('INSERT INTO providers VALUES (?, ?, ?)').run('opencode-zen', 'OpenCode Zen', encryptKey('  padded-key  '));
    rehydrateOpencodeZenCredential(asDb(db));
    expect(getOpencodeZenCredential()).toBe('padded-key');
  });
});