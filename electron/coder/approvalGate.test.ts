/**
 * The coder-run approval gate — the boundary around the one Henry operation
 * that hands a coding agent the filesystem.
 *
 * `coder:run` spawns Claude Code / OpenCode / a local coder, and a spawned
 * coding agent reads and modifies files. So a run is confirm-tier: it does not
 * spawn until the user has approved THAT run, and it does not spawn at all when
 * the answer never comes.
 *
 * The gate is the agent runner's own `requestConfirmation` — not a second one.
 * These tests therefore drive it the way the product does: a fake renderer
 * receives `agent:confirm-required` and answers on `agent:confirm-response`
 * via `resolveConfirmation`. Nothing here stubs the gate itself.
 *
 * What each case pins:
 *   - no renderer / refusal / timeout  → no spawn, and a queue row that says so
 *   - approval                          → spawn, plus queue row + audit line
 *   - an edit made in the modal         → the edited prompt is what runs
 *   - a second run                      → asks again; one approval is not a licence
 *
 * The Approval Queue writes sit behind a lazy dynamic import inside the gate,
 * so the database is mocked UNDERNEATH it (as electron/agent/sandboxGate.test.ts
 * does) rather than stubbing `recordApproval*`: the real SQL runs and is read
 * back out of the log, which proves the decision reaches the queue instead of
 * proving a mock was called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A hand-rolled ipcMain, so the real handler can be registered and invoked the
// way ipcMain would: (event, ...args).
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sqlLog: [] as Array<{ sql: string; params: unknown[] }>,
  claudeRuns: [] as Array<Record<string, unknown>>,
  localRuns: [] as Array<Record<string, unknown>>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, listener);
    },
    on: vi.fn(),
  },
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock('better-sqlite3', () => ({ default: class FakeDb {} }));

/** The fake store both the approvals queue and the app log write through. */
function fakeDb() {
  return {
    exec: () => undefined,
    prepare: (sql: string) => ({
      run: (...params: unknown[]) => {
        h.sqlLog.push({ sql, params });
        return { changes: 1 };
      },
      get: () => undefined,
      all: () => [],
    }),
  };
}

vi.mock('../ipc/database', () => ({
  getDb: () => fakeDb(),
  getDbFilePath: () => '/tmp/henry-test.db',
}));

// The spawn seams. Only the spawn is swapped: which engine is chosen, and the
// arguments the approved run is launched with, stay the real code's decision.
vi.mock('./claudeCode', () => ({
  CODER_WORKSPACE_DIR: '/tmp/henry-coder',
  detectClaudeCli: vi.fn(async () => ({ available: true, path: '/usr/bin/claude', version: '1.0.0' })),
  ensureCoderWorkspace: () => '/tmp/henry-coder',
  runClaudeCode: vi.fn((opts: Record<string, unknown>) => {
    h.claudeRuns.push(opts);
    return { kill: vi.fn() };
  }),
}));

vi.mock('./localCoder', () => ({
  LOCAL_CODER_PULL_HINT: 'run: ollama pull qwen2.5-coder:7b',
  getLocalCoderStatus: vi.fn(async () => ({
    ollamaRunning: true,
    model: 'qwen2.5-coder:7b',
    models: ['qwen2.5-coder:7b'],
    hint: null,
  })),
  runLocalCoder: vi.fn(async (opts: Record<string, unknown>) => {
    h.localRuns.push(opts);
  }),
}));

vi.mock('../runtimes/registry', () => ({
  runtimeForLegacyEngineSetting: () => null,
}));

import { registerCoderHandlers } from './index';
import { detectClaudeCli } from './claudeCode';
import { resolveConfirmation } from '../agent/toolRunner';
import { initAppLog } from '../ipc/appLog';

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

// ── Harness ────────────────────────────────────────────────────────────────

interface ConfirmPayload {
  id: string;
  toolName: string;
  description: string;
  args: Record<string, unknown>;
  safetyLevel: string;
}

interface Harness {
  /** Invoke `coder:run` the way ipcMain would. */
  run: (params: Record<string, unknown>) => Promise<{ started: boolean; engine?: string; error?: string }>;
  confirmations: ConfirmPayload[];
  /** Everything the main process pushed to the renderer. */
  sent: Array<{ channel: string; payload: Record<string, unknown> }>;
  /** Every `agent:confirm-required` id, in order. */
  confirmIds: string[];
}

interface HarnessOpts {
  /** `false` models an unattended run with no window up. */
  window?: boolean;
  /** Answers each `agent:confirm-required`; return nothing to leave it pending. */
  answer?: (id: string, payload: ConfirmPayload) => void;
  /** Rows the settings table answers with. Absent = the shipped defaults. */
  settings?: Record<string, string>;
}

function harness(opts: HarnessOpts = {}): Harness {
  const hasWindow = opts.window !== false;
  const sent: Harness['sent'] = [];
  const confirmations: ConfirmPayload[] = [];
  const confirmIds: string[] = [];
  let destroyed = false;

  const win = {
    isDestroyed: () => destroyed,
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => {
        sent.push({ channel, payload });
        if (channel === 'agent:confirm-required') {
          const p = payload as unknown as ConfirmPayload;
          confirmations.push(p);
          confirmIds.push(p.id);
          opts.answer?.(p.id, p);
        }
      },
    },
  };

  // With no settings rows the engine setting is the default 'auto' and a
  // detected Claude CLI wins — the shipped path.
  const db = {
    prepare: () => ({
      get: (key?: string) =>
        key && opts.settings?.[key] !== undefined ? { value: opts.settings[key] } : undefined,
    }),
  };
  registerCoderHandlers(db as never, () =>
    hasWindow ? (win as never) : null,
  );

  const handler = h.handlers.get('coder:run');
  if (!handler) throw new Error('coder:run was not registered');

  return {
    run: (params) => handler({ sender: 'test' }, params) as Promise<{ started: boolean }>,
    confirmations,
    sent,
    confirmIds,
  };
}

/** The approval-queue status recorded for `id`, read from the real SQL. */
async function queueStatus(id: string): Promise<string> {
  let status = '';
  await vi.waitFor(() => {
    const decision = h.sqlLog.find((q) => /UPDATE approvals/i.test(q.sql) && q.params[2] === id);
    if (!decision) throw new Error('no approval decision recorded yet');
    status = String(decision.params[0]);
  });
  return status;
}

/** The app-log lines the run wrote, newest last. */
function auditLines(): string[] {
  return h.sqlLog
    .filter((q) => /INSERT INTO app_logs/i.test(q.sql))
    .map((q) => String(q.params[3]));
}

/** Drive a fake-timer run past the confirm deadline. */
async function expireConfirm(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 1);
}

beforeEach(() => {
  h.sqlLog.length = 0;
  h.claudeRuns.length = 0;
  h.localRuns.length = 0;
  h.handlers.clear();
  // Pinned per test rather than once: a leaked `mockResolvedValueOnce` would
  // make one case depend on the order the cases happen to run in.
  vi.mocked(detectClaudeCli).mockResolvedValue({
    available: true,
    path: '/usr/bin/claude',
    version: '1.0.0',
  } as never);
  // The real app log, pointed at the fake store: the audit line these tests
  // assert on is written by the shipped `capture`, not by a spy.
  initAppLog(fakeDb() as never);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── The gate ───────────────────────────────────────────────────────────────

describe('coder:run — approval gate', () => {
  it('refuses and spawns nothing when there is no renderer to ask', async () => {
    const h2 = harness({ window: false });

    const res = await h2.run({ prompt: 'delete the fixtures', channelId: 'c1' });

    expect(res.started).toBe(false);
    expect(res.error).toMatch(/not approved/i);
    expect(h.claudeRuns).toHaveLength(0);
    expect(h.localRuns).toHaveLength(0);
    // No renderer means no prompt was even emitted, and the refusal is
    // recorded rather than silently dropped.
    expect(h2.confirmations).toHaveLength(0);
    await vi.waitFor(() => expect(auditLines().join('\n')).toMatch(/no-renderer/));
  });

  it('refuses and spawns nothing when the user declines', async () => {
    const h2 = harness({ answer: (id) => { resolveConfirmation(id, false); } });

    const res = await h2.run({ prompt: 'rewrite the auth module', channelId: 'c2' });

    expect(res.started).toBe(false);
    expect(h.claudeRuns).toHaveLength(0);
    expect(await queueStatus(h2.confirmIds[0])).toBe('rejected');
    await vi.waitFor(() => expect(auditLines().join('\n')).toMatch(/declined/));
    // The renderer is told, so the run ends instead of hanging.
    expect(h2.sent.some((s) => s.channel === 'coder:event')).toBe(true);
  });

  it('spawns only after approval, and records the queue row and the audit line', async () => {
    const h2 = harness({ answer: (id) => { resolveConfirmation(id, true); } });

    const res = await h2.run({ prompt: 'fix the flaky test', channelId: 'c3', cwd: '/repo' });

    expect(res).toMatchObject({ started: true, engine: 'claude-code' });
    expect(h.claudeRuns).toHaveLength(1);
    expect(h.claudeRuns[0]).toMatchObject({ prompt: 'fix the flaky test', cwd: '/repo' });
    const id = h2.confirmIds[0];
    // Pending row written when the question was asked, decided when answered.
    // Both sit behind the gate's lazy import of the queue, so they land a tick
    // or more later.
    await vi.waitFor(() => {
      expect(h.sqlLog.some((q) => /INSERT OR REPLACE INTO approvals/i.test(q.sql))).toBe(true);
    });
    const request = h.sqlLog.find((q) => /INSERT OR REPLACE INTO approvals/i.test(q.sql));
    expect(request?.params[0]).toBe(id);
    expect(request?.params[1]).toBe('coder_run');
    expect(await queueStatus(id)).toBe('approved');
    await vi.waitFor(() => expect(auditLines().join('\n')).toMatch(/coder run approved/));
  });

  it('runs the prompt the user edited in the modal, not the one that was sent', async () => {
    const h2 = harness({
      answer: (id, payload) => {
        resolveConfirmation(id, true, { ...payload.args, prompt: 'fix the flaky test, gently' });
      },
    });

    await h2.run({ prompt: 'fix the flaky test', channelId: 'c4', cwd: '/repo' });

    expect(h.claudeRuns[0]).toMatchObject({ prompt: 'fix the flaky test, gently' });
  });

  it('refuses, records expiry, and spawns nothing when nobody answers in time', async () => {
    vi.useFakeTimers();
    const h2 = harness();

    const run = h2.run({ prompt: 'upgrade every dependency', channelId: 'c5', cwd: '/repo' });
    await expireConfirm();
    const res = await run;

    expect(res.started).toBe(false);
    expect(res.error).toMatch(/not approved/i);
    expect(h.claudeRuns).toHaveLength(0);
    expect(await queueStatus(h2.confirmIds[0])).toBe('expired');
    await vi.waitFor(() => expect(auditLines().join('\n')).toMatch(/coder run expired/));
  });

  it('asks again for the next run — one approval is not a licence', async () => {
    const seen: string[] = [];
    const h2 = harness({
      answer: (id) => {
        seen.push(id);
        resolveConfirmation(id, true);
      },
    });

    await h2.run({ prompt: 'first task', channelId: 'c6', cwd: '/repo' });
    await h2.run({ prompt: 'second task', channelId: 'c7', cwd: '/repo' });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(h.claudeRuns).toHaveLength(2);
  });

  it('shows the modal what it is authorising: the engine and the directory', async () => {
    const h2 = harness({ answer: (id) => { resolveConfirmation(id, false); } });

    await h2.run({ prompt: 'port this to Bun', channelId: 'c8', cwd: '/repo' });

    const payload = h2.confirmations[0];
    expect(payload.safetyLevel).toBe('confirm');
    expect(payload.toolName).toBe('coder_run');
    expect(payload.description).toContain('/repo');
    expect(payload.args).toMatchObject({ engine: 'claude-code', cwd: '/repo', prompt: 'port this to Bun' });
  });

  it('never asks about a run it cannot start — no engine, no prompt, no spawn', async () => {
    // The engine is pinned to one CLI that is not installed, so the run cannot
    // start at all. Asking for approval on it would spend the user's attention
    // on a run that cannot happen.
    vi.mocked(detectClaudeCli).mockResolvedValueOnce({ available: false } as never);
    const h2 = harness({
      settings: { coder_engine: 'claude-code' },
      answer: (id) => { resolveConfirmation(id, true); },
    });

    const res = await h2.run({ prompt: 'anything', channelId: 'c9' });
    expect(res.started).toBe(false);
    expect(h2.confirmations).toHaveLength(0);
    expect(h.claudeRuns).toHaveLength(0);
  });


  it('gates the local engine the same way — a refusal runs nothing', async () => {
    vi.mocked(detectClaudeCli).mockResolvedValue({ available: false } as never);
    const h2 = harness({ answer: (id) => { resolveConfirmation(id, false); } });

    const res = await h2.run({ prompt: 'refactor this', channelId: 'c10' });

    expect(res.started).toBe(false);
    expect(h.localRuns).toHaveLength(0);
    expect(await queueStatus(h2.confirmIds[0])).toBe('rejected');
  });

  it('runs the local engine once approved, against the project directory', async () => {
    vi.mocked(detectClaudeCli).mockResolvedValue({ available: false } as never);
    const h2 = harness({ answer: (id) => { resolveConfirmation(id, true); } });

    const res = await h2.run({ prompt: 'refactor this', channelId: 'c11', cwd: '/repo' });

    expect(res).toMatchObject({ started: true, engine: 'local' });
    expect(h.localRuns[0]).toMatchObject({ prompt: 'refactor this', cwd: '/repo' });
  });
});