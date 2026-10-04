// @vitest-environment jsdom
/**
 * The seam between a provider being CHOSEN and a message being SENT.
 *
 * The owner-observed defect was one screen saying three things at once:
 *
 *     ⚠ No AI provider configured — Henry AI won't respond without one.
 *     Local AI · moondream:latest
 *     Ollama · moondream:latest
 *
 * Each line was true according to a different reader. The notice read the
 * `henry:providers` localStorage mirror; the pills read
 * `settings.companion_provider`; Chat read the router. A selection persisted
 * through onboarding was therefore invisible to the notice whenever the mirror
 * had been lost — which `App.enterApp` did on its own whenever a providers read
 * failed, by writing `[]` over a good mirror.
 *
 * This file drives the REAL surfaces with a REAL profile behind them and
 * asserts the one property that closes the class of bug: **there is one verdict,
 * and the banner, both status pills, the chat resolver and the actual inference
 * request all render it.** It also pins the two ends of the range — nothing
 * configured still warns and still navigates to Settings, and a retired provider
 * is named and refused rather than silently swapped for something live.
 *
 * Only the preload bridge is stubbed. The onboarding persistence below is the
 * real sequence the provider step performs, and inference is checked at the
 * transport (the HTTP request that leaves for Ollama), not by inspecting a
 * return value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import App from '../App';
import { useStore } from '../store';
import { chatPreflight } from './chatPreflight';
import { callHenryAI, NoBackendAvailableError } from './henryAI';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no `matchMedia`, and both the title bar and the chat input read
// it on mount. Stubbed here so the shell can actually render.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

interface ProviderRecord {
  id: string;
  name?: string;
  api_key?: string;
  apiKey?: string;
  enabled?: number | boolean;
  models?: string;
}

interface Profile {
  settings?: Record<string, string>;
  providers?: ProviderRecord[];
  conversations?: Array<{ id: string; title?: string }>;
}

/**
 * Exactly what `ProviderStep`'s local-Ollama branch persists: one provider row
 * (no credential — Ollama has no account) and the engine keys that choose it.
 */
function persistLocalSelectionViaOnboarding(model: string): Profile {
  return {
    settings: {
      ollama_base_url: 'http://127.0.0.1:11434',
      companion_provider: 'ollama',
      companion_model: model,
      worker_provider: 'ollama',
      worker_model: model,
    },
    providers: [
      { id: 'ollama', name: 'Ollama', api_key: '', apiKey: '', enabled: 1, models: JSON.stringify([model]) },
    ],
    conversations: [{ id: 'c1', title: 'Hello' }],
  };
}

function stubBridge(profile: Profile) {
  const noop = () => undefined;
  const resolved = () => Promise.resolve(undefined);
  return new Proxy(
    {
      getSettings: () => Promise.resolve(profile.settings ?? {}),
      getProviders: () => Promise.resolve(profile.providers ?? []),
      getConversations: () => Promise.resolve(profile.conversations ?? []),
      platform: () => 'linux',
      capabilities: () => Promise.resolve({}),
      saveSetting: resolved,
      saveMessage: resolved,
      createConversation: () => Promise.resolve({ id: 'c1' }),
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        // Every `on*` bridge member hands back an unsubscribe. Returning a
        // promise there is what turns an effect cleanup into "destroy is not a
        // function" and takes the whole shell down mid-render.
        if (prop.startsWith('on')) return () => noop;
        return resolved;
      },
    },
  );
}

function mountApp(profile: Profile) {
  (window as unknown as { henryAPI: unknown }).henryAPI = stubBridge(profile);
  return render(createElement(App));
}

const NO_PROVIDER_NOTICE = /No AI provider configured/;
const RETIRED_NOTICE = /Groq is no longer a supported provider/;

function noticeText(): string {
  return document.body.textContent ?? '';
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useStore.setState({ setupComplete: false, conversations: [], providers: [], settings: {}, currentView: 'chat' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a selection persisted through onboarding is one consistent story', () => {
  it('shows no notice, both pills agree, Chat resolves it, and the request goes to Ollama', async () => {
    const profile = persistLocalSelectionViaOnboarding('moondream:latest');
    mountApp(profile);

    // The shell is up (an existing profile is not re-gated behind setup).
    await waitFor(() => expect(noticeText()).not.toMatch(SETUP_FLOW_ENTRY));

    // 1. No "no AI provider" notice anywhere on screen.
    await waitFor(() => expect(screen.getAllByText(/Local AI · moondream:latest/).length).toBeGreaterThan(0));
    expect(noticeText()).not.toMatch(NO_PROVIDER_NOTICE);

    // 2. Both status pills name the same engine the router resolved — the
    // presence bar's "Local AI · model" and the title bar's "Ollama · model"
    // (capitalised by CSS, so the DOM text is lower-case).
    expect(noticeText()).toMatch(/Local AI · moondream:latest/);
    expect(noticeText()).toMatch(/ollama · moondream:latest/i);

    // 3. Chat's resolver reaches the identical provider and model — with no key.
    const preflight = chatPreflight({
      content: 'hello',
      settings: profile.settings!,
      providers: profile.providers!,
    });
    expect(preflight.kind).toBe('ready');
    if (preflight.kind !== 'ready') throw new Error('unreachable');
    expect(preflight.route.provider).toBe('ollama');
    expect(preflight.route.model).toBe('moondream:latest');
    expect(preflight.route.apiKey).toBe('');

    // 4. And the inference request actually leaves for that local runtime.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'hi from moondream' } }),
    } as Response);

    await expect(
      callHenryAI({ messages: [{ role: 'user', content: 'hello' }] }),
    ).resolves.toBe('hi from moondream');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(JSON.parse(String(init.body)).model).toBe('moondream:latest');
  });

  it('keeps the notice off even when the localStorage provider mirror is gone', async () => {
    // The exact owner-observed state: the selection is in the store, the
    // `henry:providers` mirror the old notice read has been lost.
    localStorage.setItem('henry:providers', JSON.stringify([]));
    mountApp(persistLocalSelectionViaOnboarding('moondream:latest'));

    await waitFor(() => expect(noticeText()).not.toMatch(SETUP_FLOW_ENTRY));
    expect(noticeText()).not.toMatch(NO_PROVIDER_NOTICE);
    await waitFor(() => expect(noticeText()).toMatch(/Local AI · moondream:latest/));
    expect(noticeText()).toMatch(/ollama · moondream:latest/i);
  });
});

describe('a genuinely unconfigured install still warns, and the warning navigates', () => {
  it('shows the no-provider notice and its action opens Settings', async () => {
    mountApp({ settings: {}, providers: [], conversations: [{ id: 'c1' }] });

    // The profile has a conversation but no engine at all, so it is not fresh
    // enough to be re-gated behind setup — it lands in the app with no provider.
    await waitFor(() => expect(noticeText()).toMatch(/No AI provider configured/));

    const action = screen.getByRole('button', { name: /Add a provider in Settings/ });
    action.click();
    await waitFor(() => expect(useStore.getState().currentView).toBe('settings'));
  });

  it('refuses to send anywhere, rather than picking a provider for the user', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      callHenryAI({ messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toBeInstanceOf(NoBackendAvailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a retired provider is named, refused, and never substituted', () => {
  it('names Groq on the notice, in chat, and at the transport — and sends nothing', async () => {
    const profile: Profile = {
      settings: { companion_provider: 'groq', companion_model: 'llama-3.3-70b-versatile' },
      providers: [
        { id: 'openai', name: 'OpenAI', api_key: 'sk-a-real-looking-key', enabled: 1, models: '[]' },
      ],
      conversations: [{ id: 'c1' }],
    };
    mountApp(profile);

    await waitFor(() => expect(noticeText()).not.toMatch(SETUP_FLOW_ENTRY));
    await waitFor(() => expect(noticeText()).toMatch(RETIRED_NOTICE));
    // No pill claims a working engine while the notice names the retired one.
    expect(noticeText()).not.toMatch(/Local AI ·/);
    expect(noticeText()).not.toMatch(/Cloud AI ·/);

    const preflight = chatPreflight({
      content: 'hello',
      settings: profile.settings!,
      providers: profile.providers!,
    });
    expect(preflight.kind).toBe('provider-unavailable');
    expect('route' in preflight).toBe(false);

    // A live OpenAI key is sitting right there. It is never used.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const err = await callHenryAI({ messages: [{ role: 'user', content: 'hello' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoBackendAvailableError);
    if (!(err instanceof NoBackendAvailableError)) throw new Error('unreachable');
    expect(err.userFacingMessage).toMatch(/groq|no longer available/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/** The setup flow's own entry control — a reliable tell that setup is mounted. */
const SETUP_FLOW_ENTRY = /Set up AI/;