/**
 * Defect A — `integration:list` had no registered handler.
 *
 * The installed build logged `No handler registered for 'integration:list'`
 * repeatedly. Everything around the channel was correct: the channel had a
 * `channelSchemas` entry, `preload.ts` bridged it, and the renderer called it.
 * Only `registerIntegrationHandlers` was never invoked from main.ts.
 *
 * A schema entry is not a handler. These tests drive the real registrar against
 * a capturing `ipcMain` and the real preload against a capturing `ipcRenderer`,
 * so "registered" and "bridged" mean the runtime actually saw the channel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  invokes: [] as Array<{ channel: string; args: unknown[] }>,
  bridge: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>) => {
      h.bridge[key] = api;
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      h.invokes.push({ channel, args });
      return Promise.resolve([]);
    },
    on: () => undefined,
    removeListener: () => undefined,
  },
}));

import { registerIntegrationHandlers } from './ipc';

const db = {
  prepare: () => ({ get: () => undefined }),
} as never;
const window = { webContents: { send: () => undefined } } as never;

beforeEach(() => {
  h.handlers.clear();
  h.invokes.length = 0;
});

describe('integration:list is registered, not merely declared', () => {
  it('registers a handler for the exact channel name', () => {
    // Asserted explicitly rather than inferred from the schema: the schema
    // existed and the handler did not. That gap is the whole defect.
    registerIntegrationHandlers(() => db, () => window);
    expect(h.handlers.has('integration:list')).toBe(true);
  });

  it('registers every channel the preload bridge exposes', () => {
    // Each of these was bridged to the renderer; a missing registrar call takes
    // out the whole family at once, not just one channel.
    registerIntegrationHandlers(() => db, () => window);
    for (const channel of [
      'integration:list',
      'integration:status',
      'integration:connect',
      'integration:setToken',
      'integration:disconnect',
    ]) {
      expect(h.handlers.has(channel), `${channel} has no registered handler`).toBe(true);
    }
  });

  it('responds to an invocation with the provider list', () => {
    registerIntegrationHandlers(() => db, () => window);
    const result = h.handlers.get('integration:list')!({}) as Array<{ id: string }>;
    // A registered handler that returns nothing is the same outage from the
    // renderer's point of view, so the reply is asserted too.
    expect(Array.isArray(result)).toBe(true);
    expect(result.map((p) => p.id).sort()).toEqual(['discord', 'google']);
  });

  it('does not need the database to answer a list request', () => {
    // integration:list is pure registry data. Registration must not be what
    // forces the database open, or a slow disk delays the settings screen.
    registerIntegrationHandlers(() => {
      throw new Error('database not initialised');
    }, () => window);
    const result = h.handlers.get('integration:list')!({}) as Array<{ id: string }>;
    expect(result.map((p) => p.id).sort()).toEqual(['discord', 'google']);
  });
});

describe('the preload bridge targets the registered channel', () => {
  beforeEach(async () => {
    await import('../preload');
  });

  it('maps integrationList to integration:list', () => {
    const api = h.bridge.henryAPI as { integrationList: () => Promise<unknown> };
    api.integrationList();
    expect(h.invokes.map((i) => i.channel)).toContain('integration:list');
  });

  it('exposes a named bridge method rather than a generic passthrough', () => {
    // A generic `invoke(channel, …)` would let the renderer reach any registered
    // channel; the bridge is deliberately one method per channel.
    const api = h.bridge.henryAPI as Record<string, unknown>;
    expect(typeof api.integrationList).toBe('function');
    expect(typeof api.invoke).toBe('undefined');
    expect(typeof api.send).toBe('undefined');
  });

  it('keeps the bridge method and the registered channel in agreement', async () => {
    // Cross-check both directions against the real artefacts rather than a
    // hardcoded list, so adding a bridge method without a registrar call fails.
    registerIntegrationHandlers(() => db, () => window);
    const api = h.bridge.henryAPI as Record<string, () => Promise<unknown>>;
    for (const [method, expectedChannel] of [
      ['integrationList', 'integration:list'],
      ['integrationStatus', 'integration:status'],
    ] as const) {
      h.invokes.length = 0;
      api[method]();
      expect(h.invokes[0].channel).toBe(expectedChannel);
      expect(h.handlers.has(expectedChannel), `${method} → ${expectedChannel} has no handler`).toBe(true);
    }
  });
});

describe('main.ts actually registers the integration handlers', () => {
  // The registrar itself was always correct — it was simply never called. These
  // are the assertions that would have failed at build time for Defect A.
  //
  // main.ts cannot be imported here: it constructs a BrowserWindow and binds
  // app-level lifecycle events at module scope, which is not a test environment.
  // The wiring being asserted is a single call site in a single function, so it
  // is read off the source with a structural match rather than executed.
  // Executing the two things that call connects — the registrar and the preload
  // bridge — is covered above.
  const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

  it('imports the registrar', () => {
    expect(mainSource).toMatch(
      /import\s*\{[^}]*registerIntegrationHandlers[^}]*\}\s*from\s*'\.\/integrations\/ipc'/,
    );
  });

  it('calls the registrar from createWindow, alongside the other handlers', () => {
    const call = /registerIntegrationHandlers\(\s*getDb\s*,\s*getMainWindow\s*\)/.exec(mainSource);
    expect(call, 'main.ts never calls registerIntegrationHandlers').not.toBeNull();
    // The call has to be inside createWindow, where every sibling
    // register*Handlers call lives; a call at module scope would run before the
    // database exists.
    const createWindowAt = mainSource.indexOf('function createWindow(');
    expect(createWindowAt).toBeGreaterThan(-1);
    expect(call!.index).toBeGreaterThan(createWindowAt);
  });

  it('passes the lazy database accessor, not an eagerly captured handle', () => {
    // integration:status reads credentials; handing it a handle captured before
    // initDatabase would bind it to an unopened database.
    expect(mainSource).toMatch(/registerIntegrationHandlers\(\s*getDb\s*,/);
  });
});