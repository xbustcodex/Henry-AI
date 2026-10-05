/**
 * A selected Zen model reaches the correct execution backend.
 *
 * The chain under test is the one the acceptance run exercises live: the picker
 * persists `opencode-zen` + a Zen model id, `resolveChat` reads those settings
 * back, and the main process dispatches on the resulting provider id.
 *
 * Every hop is asserted on the value itself, never on a count. The earlier
 * acceptance pass reported "39 Zen" from a discovery endpoint and called that
 * proof; a count cannot distinguish a model that is listed from a model that can
 * actually be run, and that distinction is the whole defect.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveChat } from '../../src/henry/modelRouter';
import {
  OPENCODE_PROVIDER_ID,
  OPENCODE_ZEN_PROVIDER_ID,
  requiresApiKey,
} from '../providers/classification';

const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
  BrowserWindow: class {},
}));

/**
 * The opencode bridge is stubbed rather than really started. `callAI` for an
 * opencode provider goes out over a loopback HTTP server that then spawns the
 * `opencode` CLI — running that for real would make this an integration test
 * that hangs on a machine without the CLI installed, which is exactly what
 * happened on the first attempt. Stubbing the bridge keeps the seam where the
 * decision is actually made: which provider id reaches which transport.
 */
vi.mock('./opencodeBridge', () => ({
  ensureOpencodeBridge: async () => ({
    running: true,
    port: 11540,
    baseUrl: 'http://127.0.0.1:11540/v1',
    modelCount: 3,
  }),
  opencodeBridgeToken: () => 'test-bridge-token',
  stopOpencodeBridge: () => undefined,
  TOOLS_UNSUPPORTED_MESSAGE: 'tools unsupported',
}));

vi.mock('./database', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined }) }),
}));

/** Every URL the dispatch layer actually requested. */
let requestedUrls: string[] = [];

const jsonResponse = (body: unknown): unknown => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

beforeEach(() => {
  ipcHandlers.clear();
  requestedUrls = [];
  vi.stubGlobal('fetch', async (url: unknown) => {
    requestedUrls.push(String(url));
    return jsonResponse({ choices: [{ message: { content: 'PONG' } }] });
  });
});

/** Settings exactly as the picker persists them after a Zen pick. */
const ZEN_SETTINGS = {
  companion_provider: OPENCODE_ZEN_PROVIDER_ID,
  companion_model: 'hy3-free',
};

/** The providers row the picker writes for that pick. */
const ZEN_PROVIDER_ROW = { id: OPENCODE_ZEN_PROVIDER_ID, name: 'OpenCode Zen', api_key: '', apiKey: '' };

describe('a Zen selection survives the send-time router', () => {
  it('routes to opencode-zen with the Zen model that was selected', () => {
    const route = resolveChat('hello', ZEN_SETTINGS, [ZEN_PROVIDER_ROW]);
    expect(route.provider).toBe(OPENCODE_ZEN_PROVIDER_ID);
    expect(route.model).toBe('hy3-free');
  });

  it('does not rewrite the Zen model to an ordinary opencode one', () => {
    const route = resolveChat('hello', ZEN_SETTINGS, [ZEN_PROVIDER_ROW]);
    expect(route.model).not.toBe('opencode');
    expect(route.model).toContain('hy3-free');
  });

  it('does not fall back to another provider because the Zen row has no key', () => {
    // An empty Henry-side key is not what stops Zen, so treating it as
    // "unusable" silently rerouted the turn to a different provider: the user
    // asked Zen and got something else.
    const route = resolveChat('hello', ZEN_SETTINGS, [ZEN_PROVIDER_ROW]);
    expect(route.provider).toBe(OPENCODE_ZEN_PROVIDER_ID);
    expect(route.reason).not.toMatch(/fell back/);
  });

  it('routes an ordinary opencode selection to opencode, not to Zen', () => {
    const route = resolveChat(
      'hello',
      { companion_provider: OPENCODE_PROVIDER_ID, companion_model: 'openrouter/qwen3-235b-a22b' },
      [{ id: OPENCODE_PROVIDER_ID, name: 'OpenCode (CLI)', api_key: '', apiKey: '' }],
    );
    expect(route.provider).toBe(OPENCODE_PROVIDER_ID);
  });

  it('resolves against the model list saved on the Zen row', () => {
    // The picker saves only that provider's models on its row; if a Zen id were
    // absent from it the router would substitute providerModels[0] and the user
    // would silently be talking to a different model.
    const route = resolveChat('hello', ZEN_SETTINGS, [
      { ...ZEN_PROVIDER_ROW, models: JSON.stringify(['deepseek-v4-flash-free', 'hy3-free']) },
    ]);
    expect(route.model).toBe('hy3-free');
  });
});

describe('the dispatch layer sends a Zen turn to the opencode engine', () => {
  /**
   * `callAI` is imported lazily inside the assertion because registering the AI
   * handlers needs the mocked electron/ipcMain pair set up above.
   */
  it('accepts opencode-zen as a provider rather than rejecting it', async () => {
    const { callAI } = await import('./ai');
    await expect(
      callAI({ provider: OPENCODE_ZEN_PROVIDER_ID, model: 'hy3-free', apiKey: '', messages: [{ role: 'user', content: 'ping' }] }),
    ).resolves.toBeDefined();
  });

  it('never reports opencode-zen as an unknown provider', async () => {
    const { callAI } = await import('./ai');
    // The failure this guards is `Unknown provider: opencode-zen` from the
    // `default:` arm of the dispatch switch.
    await expect(
      callAI({ provider: OPENCODE_ZEN_PROVIDER_ID, model: 'hy3-free', apiKey: '', messages: [{ role: 'user', content: 'ping' }] }),
    ).resolves.toMatchObject({ content: expect.any(String) });
  });

  it('treats opencode and opencode-zen as the same engine', async () => {
    const { callAI } = await import('./ai');
    await callAI({ provider: OPENCODE_ZEN_PROVIDER_ID, model: 'hy3-free', apiKey: '', messages: [{ role: 'user', content: 'ping' }] });
    const zenTargets = [...requestedUrls];
    requestedUrls = [];
    await callAI({ provider: OPENCODE_PROVIDER_ID, model: 'hy3-free', apiKey: '', messages: [{ role: 'user', content: 'ping' }] });
    expect(zenTargets).toEqual(requestedUrls);
  });
});

describe('the execution gate and the router agree on a Zen provider', () => {
  it('admits exactly the provider the router produces', () => {
    const route = resolveChat('hello', ZEN_SETTINGS, [ZEN_PROVIDER_ROW]);
    const row = [ZEN_PROVIDER_ROW].find((p) => p.id === route.provider)!;
    expect(requiresApiKey(row), 'router picked a provider the executor would reject').toBe(false);
  });
});