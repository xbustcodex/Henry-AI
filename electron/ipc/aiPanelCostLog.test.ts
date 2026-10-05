/**
 * Panel AI has to be countable.
 *
 * Nine features across six panels used to reach a provider by fetching a
 * Cloudflare worker URL from the renderer. Those calls produced no row in
 * `cost_log`, and neither did the panel turns that used `ai:send` — cost logging
 * lived only in `messages:save`, which a panel turn never touches. So the one
 * number Henry claims to measure accurately about its own AI spend was blind to
 * every panel feature.
 *
 * `ai:send` and `ai:stream` now write a row when the caller supplies a
 * `logPurpose`. These tests pin the three properties that matter:
 *
 *   - a panel turn that declares a purpose is recorded, with its real tokens
 *     and real cost, attributed to that purpose;
 *   - a 0-cost local turn is still recorded, because the row is the usage record
 *     and not just the bill;
 *   - a chat turn with no purpose writes nothing extra, so the existing
 *     `messages:save` accounting is not double-counted.
 *
 * The database is a real in-memory SQLite one — `node:sqlite`, the same engine
 * `better-sqlite3` wraps and the convention the other main-process tests here
 * use — because the claim under test is about what lands in a table. A mock
 * `prepare` would only prove the mock was called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
  BrowserWindow: class {},
}));

import { registerAIHandlers } from './ai';

type Db = Database.Database;

interface CostRow {
  provider: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
  cost: number;
  task_id: string | null;
}

let db: Db;
let transportCalls = 0;

/** Usage the stubbed OpenAI-compatible endpoint reports back. */
let stubUsage = { prompt_tokens: 120, completion_tokens: 45 };

function createDb(): Db {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      conversation_id TEXT,
      task_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return database as unknown as Db;
}

function send(params: Record<string, unknown>): Promise<{ content: string; cost: number }> {
  const handler = ipcHandlers.get('ai:send');
  if (!handler) throw new Error('ai:send is not registered');
  return handler({}, params) as Promise<{ content: string; cost: number }>;
}

function costRows(): CostRow[] {
  return db
    .prepare('SELECT provider, model, tokens_input, tokens_output, cost, task_id FROM cost_log')
    .all() as CostRow[];
}

beforeEach(() => {
  transportCalls = 0;
  stubUsage = { prompt_tokens: 120, completion_tokens: 45 };
  db = createDb();

  vi.stubGlobal('fetch', async (input: unknown) => {
    transportCalls += 1;
    const url = String(input);

    // Ollama has its own dialect and its own usage counters, so a stub that
    // only spoke OpenAI would report phantom usage for a local turn.
    if (url.includes(':11434')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { role: 'assistant', content: 'a summary' },
          prompt_eval_count: 90,
          eval_count: 30,
        }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ index: 0, message: { role: 'assistant', content: 'a summary' }, finish_reason: 'stop' }],
        usage: stubUsage,
      }),
    };
  });

  registerAIHandlers(db, () => null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  (db as unknown as { close: () => void }).close();
});

const MESSAGES = [{ role: 'user', content: "Sam's finances for October: Income $5000, Expenses $4200." }];

describe('ai:send accounts for a panel turn', () => {
  it('writes one cost_log row attributed to the feature, with real tokens and cost', async () => {
    const result = await send({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-panel-cost-test-key-000',
      logPurpose: 'finance.pl-summary',
      messages: MESSAGES,
      maxTokens: 250,
    });

    expect(transportCalls).toBe(1);
    const rows = costRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe('finance.pl-summary');
    expect(rows[0].provider).toBe('openai');
    expect(rows[0].model).toBe('gpt-4o');
    expect(rows[0].tokens_input).toBe(120);
    expect(rows[0].tokens_output).toBe(45);

    // The logged cost is the price the transport computed, not a restatement of
    // it from the renderer — one number, computed in one place.
    expect(rows[0].cost).toBe(result.cost);
    expect(rows[0].cost).toBeGreaterThan(0);
  });

  it('records a 0-cost local turn, because the row is usage and not just the bill', async () => {
    const result = await send({
      provider: 'ollama',
      model: 'llama3.2:3b',
      apiKey: '',
      logPurpose: 'tasks.triage',
      messages: MESSAGES,
    });

    // Ollama is Henry's only cost-free AI path, so this is the common case for a
    // local install. Logging only when `cost > 0` would make every panel feature
    // invisible on exactly the install that pays nothing — the usage row is the
    // point, not the bill.
    const rows = costRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe('tasks.triage');
    expect(rows[0].provider).toBe('ollama');
    expect(rows[0].tokens_input).toBe(90);
    expect(rows[0].tokens_output).toBe(30);
    expect(rows[0].cost).toBe(0);
    expect(result.cost).toBe(0);
  });

  it('writes nothing when the caller declares no purpose', async () => {
    await send({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-panel-cost-test-key-000',
      messages: MESSAGES,
    });

    // Chat turns are accounted by `messages:save` against their conversation.
    // Logging here too would double-count every chat turn.
    expect(costRows()).toHaveLength(0);
  });

  it('accumulates a row per call, so a feature that runs twice costs twice', async () => {
    await send({ provider: 'openai', model: 'gpt-4o', apiKey: 'k-000', logPurpose: 'finance.insight', messages: MESSAGES });
    stubUsage = { prompt_tokens: 200, completion_tokens: 60 };
    await send({ provider: 'openai', model: 'gpt-4o', apiKey: 'k-000', logPurpose: 'finance.insight', messages: MESSAGES });

    const rows = costRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tokens_input)).toEqual([120, 200]);
  });

  it('logs no row when the call fails, because no tokens were spent', async () => {
    vi.stubGlobal('fetch', async () => {
      transportCalls += 1;
      return { ok: false, status: 401, text: async () => 'bad key' };
    });

    await expect(
      send({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'k-000',
        logPurpose: 'goals.coach',
        messages: MESSAGES,
      }),
    ).rejects.toThrow();

    expect(costRows()).toHaveLength(0);
  });

  it('still returns the answer when the cost row cannot be written', async () => {
    // The user is waiting on an answer; a logging failure must not swallow it.
    const broken = {
      prepare: () => {
        throw new Error('cost_log unavailable');
      },
    } as unknown as Db;
    registerAIHandlers(broken, () => null);

    const result = await send({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'k-000',
      logPurpose: 'weekly.review',
      messages: MESSAGES,
    });

    expect(result.content).toBe('a summary');
  });
});