// @vitest-environment jsdom
/**
 * Provider surfaces — what the user can actually pick, on every screen.
 *
 * A retired provider must leave no trace a user can act on: no option row, no
 * key field, no "free key" pitch pointing at a service that does not exist.
 * Meanwhile OpenCode Zen has to survive intact as a provider IN ITS OWN RIGHT —
 * it has its own catalogue, its own key, and its own label, and flattening it
 * into plain "OpenCode" is a different bug with the same visible symptom.
 *
 * These assertions read the rendered DOM of the real components rather than
 * grepping source: copy that is never reached by a render is copy a user can
 * still be shown later.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { useStore } from '../../store';
import SettingsView from '../settings/SettingsView';
import ProviderStep from '../wizard/ProviderStep';
import MobileProviderStep from '../wizard/MobileProviderStep';
import CompleteStep from '../wizard/CompleteStep';
import { PROVIDERS, RETIRED_PROVIDERS, getModelsForProvider } from '../../providers/models';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Anything a retired provider would leave on screen, in any casing. */
const RETIRED_MARKERS = [/groq/i, /console\.groq\.com/i, /\bgsk_/];

function renderedText(): string {
  return document.body.textContent ?? '';
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('henry:providers', JSON.stringify([]));
  localStorage.setItem('henry:settings', JSON.stringify({}));
  window.henryAPI = {
    opencodeStatus: async () => ({ available: true }),
    opencodeModels: async () => ({ ok: true, models: [] }),
    saveSetting: async () => true,
    saveProvider: async () => ({ ok: true }),
    getProviders: async () => [],
    getSettings: async () => ({}),
    computerRunShell: async () => undefined,
    checkAccessibility: async () => ({ granted: false }),
    checkScreenRecording: async () => ({ granted: false }),
    onAppQuitting: () => () => {},
  } as unknown as typeof window.henryAPI;
  useStore.setState({
    providers: [{ id: 'opencode-zen', name: 'OpenCode Zen', apiKey: 'fake-test-key-000', enabled: true, models: '[]' } as never],
    settings: {},
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Settings → AI Providers', () => {
  it('renders a key row per supported cloud provider and none for a retired one', () => {
    render(createElement(SettingsView));
    const text = renderedText();

    for (const label of ['OpenCode Zen', 'OpenAI', 'Anthropic', 'Google Gemini']) {
      expect(text).toContain(label);
    }
    for (const marker of RETIRED_MARKERS) {
      expect(text).not.toMatch(marker);
    }
  });

  it('keeps OpenCode Zen a separate provider row from plain OpenCode', () => {
    render(createElement(SettingsView));
    expect(renderedText()).toContain('OpenCode Zen');
    expect(PROVIDERS['opencode-zen']).toBeDefined();
    expect(PROVIDERS.opencode).toBeDefined();
    expect(PROVIDERS['opencode-zen']).not.toBe(PROVIDERS.opencode);
  });
});

describe('onboarding provider step', () => {
  it('offers only supported providers', () => {
    render(createElement(ProviderStep, { onNext: () => {}, onBack: () => {} }));
    const text = renderedText();
    expect(text).toContain('OpenRouter');
    expect(text).toContain('Ollama');
    for (const marker of RETIRED_MARKERS) {
      expect(text).not.toMatch(marker);
    }
  });
});

describe('mobile provider step', () => {
  it('offers only supported providers', () => {
    render(createElement(MobileProviderStep, { onNext: () => {}, onBack: () => {} }));
    const text = renderedText();
    expect(text).toContain('OpenRouter');
    for (const marker of RETIRED_MARKERS) {
      expect(text).not.toMatch(marker);
    }
  });
});

describe('onboarding completion nudge', () => {
  it('lists supported providers when nothing is configured', () => {
    useStore.setState({ providers: [], settings: {} });
    render(createElement(CompleteStep, { onBack: () => {} }));
    const text = renderedText();
    expect(text).toContain('OpenCode Zen');
    expect(text).toContain('Ollama');
    for (const marker of RETIRED_MARKERS) {
      expect(text).not.toMatch(marker);
    }
  });
});

describe('provider catalogue', () => {
  it('carries no retired provider entry, model, or key prefix', () => {
    for (const retired of Object.keys(RETIRED_PROVIDERS)) {
      expect(PROVIDERS).not.toHaveProperty(retired);
      expect(getModelsForProvider(retired)).toEqual([]);
    }
  });

  it('still discovers local models dynamically — no static local table', () => {
    expect(getModelsForProvider('ollama')).toEqual([]);
  });
});