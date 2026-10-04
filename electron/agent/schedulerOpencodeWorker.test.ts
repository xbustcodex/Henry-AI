/**
 * Defect C — a scheduler worker on an OpenCode/Zen model.
 *
 * The installed build logged `Worker provider "OpenCode (CLI)" is missing an
 * API key.` The provider row really did have an empty key, and that is correct:
 * opencode authenticates inside its own CLI, not through Henry's providers
 * table. `resolveEngine` classified "has no key" as "unusable" using an inline
 * check that only knew about `ollama`, so every Routine on an OpenCode model
 * was refused before a single token was spent.
 *
 * This drives the real HenryScheduler over a real (in-memory) database and a
 * real Routine firing. `callAIWithTools` is stubbed because the thing under test
 * is whether the run is *allowed to happen* and *which provider id it carries* —
 * not whether a model answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { HenryScheduler } from './scheduler';
import { callAIWithTools } from '../ipc/ai';
import { OPENCODE_PROVIDER_ID, OPENCODE_ZEN_PROVIDER_ID } from '../providers/classification';

vi.mock('../ipc/ai', () => ({
  callAIWithTools: vi.fn(async () => ({ content: 'done', toolCalls: [] })),
}));
vi.mock('../ipc/sessionStore', () => ({
  createSessionRecord: vi.fn(async () => 'sess-1'),
  recordSessionMessage: vi.fn(async () => undefined),
}));
vi.mock('../ipc/_keyStorage', () => ({ decryptKey: (s: string) => s }));
vi.mock('../lib/log', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const aiCalls = vi.mocked(callAIWithTools);

type DbLike = DatabaseSync & {
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
};

function withTransaction(db: DatabaseSync): DbLike {
  const wrapped = db as DbLike;
  wrapped.transaction = ((fn: (...args: never[]) => unknown) =>
    (...args: never[]) => {
      db.exec('BEGIN');
      try {
        const out = fn(...args);
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    }) as DbLike['transaction'];
  return wrapped;
}

/**
 * The exact rows the model picker writes when an OpenCode or Zen model is
 * selected: an empty `api_key`, because the opencode CLI never reads one.
 */
function dbWithWorker(providerId: string, providerName: string, apiKey: string): DbLike {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      description    TEXT,
      cronExpression TEXT NOT NULL,
      prompt         TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      lastRunAt      TEXT,
      nextRunAt      TEXT,
      createdAt      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY, task_id TEXT, task_name TEXT, prompt TEXT,
      status TEXT, trigger TEXT, result TEXT, error TEXT, session_id TEXT,
      read_at TEXT, started_at TEXT, finished_at TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, name TEXT, api_key TEXT DEFAULT ''
    );
  `);
  db.prepare('INSERT INTO providers (id, name, api_key) VALUES (?, ?, ?)').run(providerId, providerName, apiKey);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('worker_provider', providerId);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('worker_model', 'hy3-free');
  return withTransaction(db);
}

const asDb = (db: DbLike) => db as unknown as ConstructorParameters<typeof HenryScheduler>[0];

let sched: HenryScheduler;

beforeEach(() => {
  vi.useFakeTimers();
  aiCalls.mockClear();
});

afterEach(() => {
  sched?.shutdown();
  vi.useRealTimers();
});

/**
 * Register and fire one interval Routine, then report whether the run reached
 * the model layer and, if it did not, the error that stopped it. Firing through
 * the timer is the real path: it exercises resolveEngine, session creation and
 * the tool loop exactly as a scheduled Routine does.
 */
async function fireOnce(db: DbLike): Promise<{ aiCalls: number; lastError: string }> {
  sched = new HenryScheduler(asDb(db), () => null);
  sched.init();
  sched.add({
    name: 'Zen Routine',
    prompt: 'say hello',
    trigger: { type: 'interval', everyMs: 60_000 },
    enabled: true,
  });
  await vi.advanceTimersByTimeAsync(60_000);
  const rows = db.prepare('SELECT status, error FROM automation_runs').all() as Array<{
    status: string;
    error: string | null;
  }>;
  // `aiCalls.length` would be the mock's arity, not its call count — a count
  // read from the wrong place is worse than no count at all.
  return {
    aiCalls: aiCalls.mock.calls.length,
    lastError: rows.map((r) => r.error ?? '').join(' | '),
  };
}

describe('a scheduler worker on an opencode-backed provider', () => {
  it('runs a Routine on opencode-zen with no Henry API key', async () => {
    const db = dbWithWorker(OPENCODE_ZEN_PROVIDER_ID, 'OpenCode Zen', '');
    const { aiCalls: calls, lastError } = await fireOnce(db);
    // The literal message from the installed build's log.
    expect(lastError).not.toMatch(/missing an API key/);
    expect(calls).toBe(1);
  });

  it('runs a Routine on plain opencode with no Henry API key', async () => {
    const db = dbWithWorker(OPENCODE_PROVIDER_ID, 'OpenCode (CLI)', '');
    const { aiCalls: calls, lastError } = await fireOnce(db);
    expect(lastError).not.toMatch(/missing an API key/);
    expect(calls).toBe(1);
  });

  it('dispatches the run under the provider id the picker persisted', async () => {
    // `opencode-zen` is the arm ai.ts routes to the opencode bridge. If the id
    // were rewritten to `opencode` here, the Zen credential would not be the
    // one in play and the two providers would be indistinguishable again.
    await fireOnce(dbWithWorker(OPENCODE_ZEN_PROVIDER_ID, 'OpenCode Zen', ''));
    expect(aiCalls.mock.calls[0][0].provider).toBe(OPENCODE_ZEN_PROVIDER_ID);
    expect(aiCalls.mock.calls[0][0].model).toBe('hy3-free');
  });

  it('still refuses a genuinely key-gated provider', async () => {
    // Widening the exemption must not exempt everything: a cloud provider with
    // no key is still a configuration error the user has to fix.
    const { aiCalls: calls, lastError } = await fireOnce(dbWithWorker('groq', 'Groq', ''));
    expect(lastError).toMatch(/missing an API key/);
    expect(calls).toBe(0);
  });

  it('accepts a key-gated provider once its key is present', async () => {
    const { aiCalls: calls, lastError } = await fireOnce(dbWithWorker('groq', 'Groq', 'gsk_real'));
    expect(lastError).toBe('');
    expect(calls).toBe(1);
  });

  it('still accepts ollama, which was the only exemption before', async () => {
    const { aiCalls: calls, lastError } = await fireOnce(dbWithWorker('ollama', 'Ollama (Local)', ''));
    expect(lastError).toBe('');
    expect(calls).toBe(1);
  });

  it('reports an unconfigured Worker engine differently from a missing key', async () => {
    // "not configured" and "missing a key" are different user problems; conflating
    // them sends someone to fix a credential this provider does not have.
    const db = dbWithWorker(OPENCODE_ZEN_PROVIDER_ID, 'OpenCode Zen', '');
    db.prepare("UPDATE settings SET value = '' WHERE key = 'worker_model'").run();
    const { lastError } = await fireOnce(db);
    expect(lastError).toMatch(/not configured/);
    expect(lastError).not.toMatch(/missing an API key/);
  });
});
