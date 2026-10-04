// @vitest-environment jsdom
/**
 * The first-launch gate, as App.tsx actually wires it.
 *
 * ## Why this mounts App rather than testing `isFreshProfile`
 *
 * `src/firstRun.test.ts` already proves the verdict function is correct. It
 * cannot prove the verdict is USED. The failure being guarded against is
 * precisely that: App computed a freshness answer and then took the already-
 * configured branch anyway, because the branch condition was
 * `setup_complete === 'true' || providers.length > 0` and not the verdict. A
 * developer machine has provider rows from its first launch, so that condition
 * is true before the user has chosen anything, and setup was skipped for exactly
 * the reason a fresh customer needs it.
 *
 * So these cases drive the real component with a real profile behind it:
 * genuinely fresh user data must land on the setup flow; a profile with a
 * credential must not.
 *
 * ## What is stubbed
 *
 * Only the preload bridge. App reaches for 31 `window.henryAPI.*` members across
 * boot, and every one is irrelevant to which screen is rendered. The stub returns
 * the shape each caller destructures, and `getSettings` / `getProviders` /
 * `getConversations` return the profile under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import App from './App';
import { useStore } from './store';
import { FIRST_RUN_KEY } from './firstRun';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Profile {
  settings?: Record<string, string>;
  providers?: Array<{ id: string; name?: string; api_key?: string; enabled?: number; models?: string }>;
  conversations?: Array<{ id: string; title?: string }>;
}

/** Every `henryAPI` member is a no-op; the three loaders return the profile. */
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
      onEngineStatus: () => noop,
      onTaskUpdate: () => noop,
      onTaskResult: () => noop,
      onUpdateAvailable: () => noop,
      onUpdateDownloaded: () => noop,
      onNotificationOpenRequest: () => noop,
      onCompanionDeviceLinked: () => noop,
      onCompanionChatUpdate: () => noop,
      onCompanionCapture: () => noop,
      onCompanionPrompt: () => noop,
      onCompanionActionDecision: () => noop,
      onQuickExtractResult: () => noop,
      getSettings_: () => Promise.resolve({}),
      saveSetting: resolved,
      saveMessage: resolved,
      createConversation: () => Promise.resolve({ id: 'c1' }),
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        // A listener must hand back an UNSUBSCRIBE. The catch-all below returns
        // a promise, and React calls `.destroy()` on whatever a subscription
        // returns — so any `on*` member the shell subscribes to that is not
        // modelled above would take the whole tree down mid-render.
        if (prop.startsWith('on')) return () => noop;

        // Anything else is an unmodelled bridge call. Returning a resolved
        // promise keeps an unawaited call from surfacing as an unhandled
        // rejection.
        return resolved;
      },
    },
  );
}

/** `overrides` lets a case observe a specific bridge call (e.g. saveSetting). */
function mountApp(profile: Profile, overrides: Record<string, unknown> = {}) {
  const stub = stubBridge(profile);
  (globalThis as unknown as { window: Window }).window.henryAPI = new Proxy(stub, {
    get(target, prop: string) {
      return prop in overrides ? overrides[prop] : target[prop];
    },
  }) as unknown as Window['henryAPI'];
  return render(createElement(App));
}

/**
 * The setup flow's first stage is the welcome panel. Its primary action is
 * "Set up AI" — a control that exists nowhere else in the app, so it is a
 * reliable tell for which surface is mounted.
 */
const SETUP_FLOW_ENTRY = /Set up AI/;

function setupFlowIsShowing(): boolean {
  return screen.queryAllByText(SETUP_FLOW_ENTRY).length > 0;
}

// The shell reads `matchMedia` for its theme/density preferences and jsdom has
// no implementation. Without this the app shell throws into the error boundary
// the moment setup finishes — which is precisely the code path these cases
// exist to inspect, so the shell must actually render here.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useStore.setState({ setupComplete: false, conversations: [], providers: [], settings: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('first-launch gate — genuinely fresh user data', () => {
  it('shows the setup flow instead of the app', async () => {
    // No settings, no providers, no conversations, no marker: what a brand-new
    // user-data directory looks like on any platform.
    mountApp({});

    await waitFor(() => {
      expect(screen.getByText(SETUP_FLOW_ENTRY)).toBeTruthy();
    }, { timeout: 15_000 });
    expect(setupFlowIsShowing()).toBe(true);

    // The app shell must not have been entered behind it.
    expect(useStore.getState().setupComplete).toBe(false);
  });

  it('stays on the setup flow even when a provider row exists without a key', async () => {
    // A keyless row is not a decision. This is the shape that a dev machine and a
    // fresh install both used to look like, and it is why "providers exist" was
    // the wrong test.
    mountApp({
      providers: [{ id: 'ollama', name: 'Ollama', api_key: '', enabled: 1, models: '[]' }],
    });

    await waitFor(() => {
      expect(screen.getByText(SETUP_FLOW_ENTRY)).toBeTruthy();
    }, { timeout: 15_000 });
    expect(useStore.getState().setupComplete).toBe(false);
  });

  it('writes nothing to the profile while the gate is up', async () => {
    const saveSetting = vi.fn(() => Promise.resolve(undefined));
    mountApp({}, { saveSetting });

    await waitFor(() => { expect(screen.getByText(SETUP_FLOW_ENTRY)).toBeTruthy(); }, { timeout: 15_000 });

    // Completing the gate must not be a side effect of merely reaching it — a
    // fresh profile is left exactly as found until the user finishes.
    expect(saveSetting).not.toHaveBeenCalledWith('setup_complete', 'true');
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBeNull();
  });
});

describe('first-launch gate — an existing profile is preserved', () => {
  it('enters the app without the setup flow when a credential is configured', async () => {
    mountApp({
      settings: { companion_provider: 'anthropic', companion_model: 'claude-sonnet-4' },
      providers: [{ id: 'anthropic', name: 'Anthropic', api_key: 'sk-ant-user-key-value', enabled: 1, models: '[]' }],
      conversations: [{ id: 'c1', title: 'Existing work' }],
    });

    await waitFor(() => {
      expect(useStore.getState().setupComplete).toBe(true);
    }, { timeout: 15_000 });

    // Setup is not re-shown, and the profile's own state is what got loaded.
    expect(setupFlowIsShowing()).toBe(false);
    expect(useStore.getState().conversations).toHaveLength(1);
  });

  it('enters the app when setup was already completed', async () => {
    mountApp({ settings: { setup_complete: 'true' } });

    await waitFor(() => {
      expect(useStore.getState().setupComplete).toBe(true);
    }, { timeout: 15_000 });
    expect(setupFlowIsShowing()).toBe(false);
  });

  it('enters the app when the first-run marker is present', async () => {
    localStorage.setItem(FIRST_RUN_KEY, 'true');
    mountApp({});

    await waitFor(() => {
      expect(useStore.getState().setupComplete).toBe(true);
    }, { timeout: 15_000 });
    expect(setupFlowIsShowing()).toBe(false);
  });

  it('does not require a credential — a completed local setup still counts', async () => {
    // Ollama needs no key. Gating on "has a credential" alone would lock a user
    // who legitimately runs entirely local back into setup on every launch.
    mountApp({
      settings: { setup_complete: 'true', companion_provider: 'ollama', companion_model: 'deepseek-r1:7b' },
      providers: [{ id: 'ollama', name: 'Ollama', api_key: '', enabled: 1, models: '["deepseek-r1:7b"]' }],
      conversations: [{ id: 'c1' }],
    });

    await waitFor(() => {
      expect(useStore.getState().setupComplete).toBe(true);
    }, { timeout: 15_000 });
    expect(setupFlowIsShowing()).toBe(false);
  });
});

describe('one gate, not two', () => {
  /**
   * The overlay used to mount on load whenever a second, unrelated completion
   * marker was absent — so finishing the first-launch flow set `setupComplete`,
   * the shell rendered, and the overlay put a second, identical run of the same
   * machine on top of it. That was the other half of "the wizard loops".
   *
   * The overlay is the `fixed inset-0 z-[200]` frame onboarding puts around the
   * machine, and it mounts the instant its flag is set, so the frame is what to
   * watch. The selector is that exact class list rather than `z-[200]`, which
   * the toast host also uses at a different position.
   */
  it('does not drop a second copy of the flow over a configured app', async () => {
    const { container } = mountApp({ settings: { setup_complete: 'true' } });

    await waitFor(() => {
      expect(useStore.getState().setupComplete).toBe(true);
    }, { timeout: 15_000 });
    expect(container.querySelector('.fixed.inset-0.z-\\[200\\]')).toBeNull();
  }, 20_000);

  it('still opens the flow when the user asks for it', async () => {
    const { container } = mountApp({ settings: { setup_complete: 'true' } });
    await waitFor(() => {
      expect(useStore.getState().setupComplete).toBe(true);
    }, { timeout: 15_000 });
    expect(container.querySelector('.fixed.inset-0.z-\\[200\\]')).toBeNull();

    act(() => { window.dispatchEvent(new CustomEvent('henry_open_setup_wizard')); });

    await waitFor(() => {
      expect(container.querySelector('.fixed.inset-0.z-\\[200\\]')).not.toBeNull();
    }, { timeout: 15_000 });
  }, 20_000);
});