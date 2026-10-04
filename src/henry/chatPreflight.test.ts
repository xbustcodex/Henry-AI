/**
 * The seam between "the user pressed send" and "a message leaves for a
 * provider".
 *
 * `modelRouter.test.ts` drives `resolveChat` and proves it throws rather than
 * substituting. `backendStatus.test.ts` proves what the cheap status probe
 * counts. Neither can see the other, and that gap is where the bug lived: the
 * panel router (`henryAI.ts`) had its own "first provider with a key wins"
 * scan, so an install with one OpenAI key and nothing selected answered from
 * OpenAI while the chat surface was still asking the user to pick an engine.
 * Two modules, two different truths, and Chat looked configured.
 *
 * This file drives the REAL preflight Chat runs on every send, and the REAL
 * panel router behind it, and asserts the one property that must hold across
 * both: **with nothing configured, the user gets the setup path and no request
 * reaches any provider.** "No dispatch" is checked at the transport, not by
 * inspecting a return value: `fetch` is spied and must stay untouched.
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chatPreflight } from './chatPreflight';
import { callHenryAI, NoBackendAvailableError } from './henryAI';

const SETTINGS_KEY = 'henry:settings';
const PROVIDERS_KEY = 'henry:providers';

/**
 * Install the same settings/providers an Electron install exposes, through the
 * same bridge the real code reads them from. Seeding localStorage alone would
 * let a regression that scans the provider store slip past: the store is
 * exactly where a silent "first key wins" pick would look.
 */
function seedInstall(settings: Record<string, string>, providers: unknown[] = []): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers));
  (window as unknown as { henryAPI: unknown }).henryAPI = {
    getSettings: async () => settings,
    getProviders: async () => providers,
  };
}

const OPENAI_ROW = { id: 'openai', name: 'OpenAI', api_key: 'sk-test-key-1234567890', enabled: true };

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as { henryAPI?: unknown }).henryAPI;
  seedInstall({}, []);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chatPreflight — a fresh install', () => {
  it('routes to provider setup and yields no route to dispatch', () => {
    const preflight = chatPreflight({ content: 'what can you do?', settings: {}, providers: [] });

    expect(preflight.kind).toBe('setup-required');
    // No `route` exists on a terminal outcome — Chat cannot dispatch.
    expect('route' in preflight).toBe(false);
    if (preflight.kind !== 'setup-required') throw new Error('unreachable');
    expect(preflight.message).toContain('Henry needs an AI provider to answer.');
    expect(preflight.message).toContain('Settings → AI Providers');
  });

  it('never answers from the provider that merely happens to have a key', () => {
    seedInstall({}, [OPENAI_ROW]);

    const preflight = chatPreflight({
      content: 'hello',
      settings: {},
      providers: [OPENAI_ROW],
    });

    // Not `ready`: a key on the machine is not a selection. The user is told to
    // pick an engine instead of being answered from a provider they never chose.
    expect(preflight.kind).toBe('unresolved');
    if (preflight.kind !== 'unresolved') throw new Error('unreachable');
    expect(preflight.code).toBe('provider_not_configured');
    expect(preflight.message).toContain('No chat engine is selected');
  });

  it('treats a license key as no backend at all — hosted AI is not enabled', () => {
    localStorage.setItem('henry:license_key', 'HENRY-FAKE-KEY');

    const preflight = chatPreflight({ content: 'hi', settings: {}, providers: [] });

    expect(preflight.kind).toBe('setup-required');
  });
});

describe('chatPreflight — a configured engine', () => {
  it('dispatches to exactly the provider and model the user configured', () => {
    const settings = { companion_provider: 'openai', companion_model: 'gpt-4o-mini' };

    const preflight = chatPreflight({ content: 'hi', settings, providers: [OPENAI_ROW] });

    expect(preflight.kind).toBe('ready');
    if (preflight.kind !== 'ready') throw new Error('unreachable');
    expect(preflight.route.provider).toBe('openai');
    expect(preflight.route.model).toBe('gpt-4o-mini');
  });

  it('reports a retired provider instead of substituting a live one', () => {
    seedInstall({ companion_provider: 'groq', companion_model: 'llama-3.3-70b' }, [OPENAI_ROW]);

    const preflight = chatPreflight({
      content: 'hi',
      settings: { companion_provider: 'groq', companion_model: 'llama-3.3-70b' },
      providers: [OPENAI_ROW],
    });

    expect(preflight.kind).toBe('provider-unavailable');
    expect('route' in preflight).toBe(false);
  });

  it('reports a selected provider that has no credential rather than reaching for another', () => {
    const settings = { companion_provider: 'anthropic', companion_model: 'claude-3-5-haiku-20241022' };

    const preflight = chatPreflight({
      content: 'hi',
      settings,
      providers: [OPENAI_ROW, { id: 'anthropic', name: 'Anthropic', api_key: '', enabled: true }],
    });

    expect(preflight.kind).toBe('unresolved');
    if (preflight.kind !== 'unresolved') throw new Error('unreachable');
    expect(preflight.code).toBe('api_key_missing');
    expect(preflight.message).toContain('anthropic');
  });
});

describe('callHenryAI — panels', () => {
  it('makes no request at all when no engine is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    seedInstall({}, [OPENAI_ROW]);

    await expect(
      callHenryAI({ messages: [{ role: 'user', content: 'summarise my day' }] }),
    ).rejects.toBeInstanceOf(NoBackendAvailableError);

    // The proof that matters: not one byte left for a provider.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tells the user where to configure a provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    seedInstall({}, []);

    const err = await callHenryAI({ messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoBackendAvailableError);
    if (!(err instanceof NoBackendAvailableError)) throw new Error('unreachable');
    expect(err.userFacingMessage).toContain('Settings → AI Providers');
    expect(err.userFacingMessage).toContain('will not choose one for you');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves the panel silent when the caller opted out of a backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    seedInstall({}, []);

    await expect(
      callHenryAI({ messages: [{ role: 'user', content: 'hi' }], allowNoBackend: true }),
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
