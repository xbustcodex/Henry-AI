/**
 * Backend status — the ONE verdict on provider configuration.
 *
 * The defect this file protects against is a screen that says two things at
 * once. The backend notice once ran its own probe over the `henry:providers`
 * localStorage mirror while the brain pill read `settings.companion_provider`,
 * so a real install rendered "No AI provider configured — Henry AI won't respond
 * without one" directly above "Local AI · moondream:latest".
 *
 * The fix is that there is no second probe any more: the banner, the pill, the
 * chat preflight and `hasUsableBackend` all call `resolveProviderState`, which
 * is built on `resolveChat` — the function that decides where a sent message
 * actually goes. These assertions therefore pin the property that matters: what
 * the router can send to is what the UI calls configured, and nothing else.
 *
 *   - OpenCode Zen counts WITH NO KEY — its free models run unauthenticated, and
 *     demanding one is what made a working Zen install read as unconfigured.
 *   - Local Ollama counts with no key either, for the same reason.
 *   - A retired provider (Groq) counts for nothing, ever.
 *   - A provider row on disk is an inventory entry, not a selection: a key the
 *     user never chose cannot make an install look ready.
 *   - A license key counts for nothing: no hosted AI is enabled in Henry.
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  configuredBackendKinds,
  getBackendStatus,
  hasUsableBackend,
  resolveProviderState,
} from './backendStatus';

/** What the onboarding provider step writes for a chosen local model. */
const OLLAMA_ROW = {
  id: 'ollama',
  name: 'Ollama',
  api_key: '',
  apiKey: '',
  enabled: true,
  models: JSON.stringify(['moondream:latest']),
};
const OLLAMA_SELECTION = {
  companion_provider: 'ollama',
  companion_model: 'moondream:latest',
};

/** What the onboarding provider step writes for a chosen Zen model. */
const ZEN_ROW = {
  id: 'opencode-zen',
  name: 'OpenCode Zen',
  api_key: '',
  apiKey: '',
  enabled: true,
  models: JSON.stringify(['hy3-free']),
};
const ZEN_SELECTION = {
  companion_provider: 'opencode-zen',
  companion_model: 'hy3-free',
};

function seedProviders(rows: unknown[]): void {
  localStorage.setItem('henry:providers', JSON.stringify(rows));
}
function seedSettings(settings: Record<string, string>): void {
  localStorage.setItem('henry:settings', JSON.stringify(settings));
}

beforeEach(() => {
  localStorage.clear();
});

describe('a keyless selection is a configured backend', () => {
  it('counts a selected local Ollama model with no API key at all', () => {
    seedProviders([OLLAMA_ROW]);
    seedSettings(OLLAMA_SELECTION);

    const state = resolveProviderState();
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') throw new Error('unreachable');
    expect(state.route.provider).toBe('ollama');
    expect(state.route.model).toBe('moondream:latest');
    expect(state.route.apiKey).toBe('');
    expect(hasUsableBackend()).toBe(true);
    expect(getBackendStatus().primaryLabel).toBe('Local Ollama');
  });

  it('counts a selected OpenCode Zen model that carries no credential', () => {
    seedProviders([ZEN_ROW]);
    seedSettings(ZEN_SELECTION);

    const state = resolveProviderState();
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') throw new Error('unreachable');
    expect(state.route.provider).toBe('opencode-zen');
    expect(state.label).toBe('OpenCode Zen');
    expect(hasUsableBackend()).toBe(true);
  });

  it('keeps Zen a distinct provider id from the plain opencode group', () => {
    seedProviders([ZEN_ROW]);
    seedSettings(ZEN_SELECTION);
    expect(getBackendStatus().kinds).toContain('opencode-zen');
    expect(getBackendStatus().kinds).not.toContain('opencode');

    seedProviders([{ id: 'opencode', name: 'OpenCode', enabled: true }]);
    seedSettings({ companion_provider: 'opencode', companion_model: 'gpt-5-codex' });
    expect(getBackendStatus().kinds).toContain('opencode');
    expect(getBackendStatus().kinds).not.toContain('opencode-zen');
  });

  it('does not count a local row the user never selected as an engine', () => {
    seedProviders([OLLAMA_ROW]);

    expect(hasUsableBackend()).toBe(false);
    expect(resolveProviderState().kind).toBe('unresolved');
    expect(configuredBackendKinds()).toContain('ollama');
  });

  it('does not count a key on disk that the user never selected', () => {
    seedProviders([{ id: 'openai', name: 'OpenAI', api_key: 'sk-a-real-looking-key', enabled: true }]);

    const state = resolveProviderState();
    expect(state.kind).toBe('unresolved');
    if (state.kind !== 'unresolved') throw new Error('unreachable');
    expect(state.code).toBe('provider_not_configured');
    expect(hasUsableBackend()).toBe(false);
  });
});

describe('nothing configured stays nothing configured', () => {
  it('reports no backend on a bare install', () => {
    seedProviders([]);

    const status = getBackendStatus();
    expect(status.hasAny).toBe(false);
    expect(status.kinds).toEqual([]);
    expect(status.primaryLabel).toBe('No AI provider');
    expect(resolveProviderState().kind).toBe('nothing-configured');
    expect(hasUsableBackend()).toBe(false);
  });

  it('never counts a license key — no hosted AI is enabled in Henry', () => {
    localStorage.setItem('henry:license_key', 'lic_abc');
    seedProviders([]);

    expect(hasUsableBackend()).toBe(false);
    expect(getBackendStatus().primaryLabel).toBe('No AI provider');
  });

  it('never counts a relay URL — it is not an engine selection', () => {
    seedProviders([]);
    seedSettings({ relay_base_url: 'https://relay.example.com/v1' });

    expect(hasUsableBackend()).toBe(false);
    expect(getBackendStatus().kinds).toEqual([]);
  });
});

describe('a retired provider is named and refused', () => {
  it('never reports Groq as configured, whatever else is on the machine', () => {
    seedProviders([{ id: 'openai', name: 'OpenAI', api_key: 'sk-a-real-looking-key', enabled: true }]);
    seedSettings({ companion_provider: 'groq', companion_model: 'llama-3.3-70b-versatile' });

    const state = resolveProviderState();
    expect(state.kind).toBe('provider-unavailable');
    if (state.kind !== 'provider-unavailable') throw new Error('unreachable');
    expect(state.retiredName).toBe('Groq');
    expect(state.message).toContain('Groq');
    expect(state.message).toContain('will not route to another provider');
    expect(hasUsableBackend()).toBe(false);
  });
});

describe('an unresolvable selection says exactly what is missing', () => {
  it('names the provider whose row never landed', () => {
    seedProviders([]);
    seedSettings(OLLAMA_SELECTION);

    const state = resolveProviderState();
    expect(state.kind).toBe('unresolved');
    if (state.kind !== 'unresolved') throw new Error('unreachable');
    expect(state.code).toBe('provider_row_missing');
    expect(state.message).toContain('ollama');
  });

  it('names a model the selected provider does not offer', () => {
    seedProviders([OLLAMA_ROW]);
    seedSettings({ companion_provider: 'ollama', companion_model: 'a-model-nobody-pulled' });

    const state = resolveProviderState();
    expect(state.kind).toBe('unresolved');
    if (state.kind !== 'unresolved') throw new Error('unreachable');
    expect(state.code).toBe('model_unavailable');
  });

  it('demands a credential only from a provider that charges for one', () => {
    seedProviders([
      { id: 'anthropic', name: 'Anthropic', api_key: '', enabled: true, models: '[]' },
    ]);
    seedSettings({ companion_provider: 'anthropic', companion_model: 'claude-3-5-haiku-20241022' });

    const state = resolveProviderState();
    expect(state.kind).toBe('unresolved');
    if (state.kind !== 'unresolved') throw new Error('unreachable');
    expect(state.code).toBe('api_key_missing');
  });
});