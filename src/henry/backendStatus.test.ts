/**
 * Backend status — the cheap synchronous "can Henry answer right now?" probe.
 *
 * Two things this file exists to protect:
 *
 *  1. OpenCode Zen counts as a usable backend WITH NO KEY. Zen's free models run
 *     unauthenticated through the local opencode bridge, so requiring a key
 *     here is wrong. Not counting opencode at all is worse: it made every fully
 *     configured Zen install read as "no AI provider", and ChatView's gate then
 *     returned the setup card before the router was ever reached — which is why
 *     sending a message with a working Zen selection did nothing.
 *
 *  2. Zen stays a DISTINCT provider id. A Zen install is not an `opencode`
 *     install; the UI labels them differently and only Zen carries the Zen
 *     catalogue and its own optional key.
 *
 * Local Ollama must keep counting too — it needs no key and needs no license.
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getBackendStatus, hasUsableBackend } from './backendStatus';

function seedProviders(rows: Array<Record<string, unknown>>): void {
  localStorage.setItem('henry:providers', JSON.stringify(rows));
}

beforeEach(() => {
  localStorage.clear();
});

describe('getBackendStatus — OpenCode Zen without a key', () => {
  it('counts a Zen row that carries no credential', () => {
    seedProviders([{ id: 'opencode-zen', name: 'OpenCode Zen', enabled: true }]);

    const status = getBackendStatus();
    expect(status.kinds).toContain('opencode-zen');
    expect(status.hasAny).toBe(true);
    expect(status.primaryLabel).toBe('OpenCode Zen');
  });

  it('counts Zen selected in settings when the row was never mirrored', () => {
    // App.tsx mirrors SQLite → localStorage, but a row saved before that sync
    // runs is only visible through settings. The probe must still see it.
    seedProviders([]);
    const status = getBackendStatus({
      companion_provider: 'opencode-zen',
      companion_model: 'some-zen-model-id',
    });
    expect(status.kinds).toContain('opencode-zen');
    expect(hasUsableBackend({ companion_provider: 'opencode-zen' })).toBe(true);
  });

  it('keeps Zen distinct from the plain opencode group', () => {
    seedProviders([{ id: 'opencode-zen', name: 'OpenCode Zen', enabled: true }]);
    expect(getBackendStatus().kinds).not.toContain('opencode');

    seedProviders([{ id: 'opencode', name: 'OpenCode', enabled: true }]);
    const plain = getBackendStatus();
    expect(plain.kinds).toContain('opencode');
    expect(plain.kinds).not.toContain('opencode-zen');
    expect(plain.primaryLabel).toBe('OpenCode');
  });

  it('prefers the Zen row when both opencode groups are configured', () => {
    seedProviders([
      { id: 'opencode', name: 'OpenCode', enabled: true },
      { id: 'opencode-zen', name: 'OpenCode Zen', enabled: true },
    ]);
    const status = getBackendStatus();
    expect(status.kinds).toContain('opencode-zen');
    expect(status.primaryLabel).toBe('OpenCode Zen');
  });
});

describe('getBackendStatus — local and cloud still work', () => {
  it('counts local Ollama with no key at all', () => {
    seedProviders([{ id: 'ollama', name: 'Ollama', enabled: true }]);
    const status = getBackendStatus();
    expect(status.kinds).toContain('ollama');
    expect(status.hasAny).toBe(true);
  });

  it('counts Ollama selected purely through settings', () => {
    seedProviders([]);
    expect(getBackendStatus({ companion_provider: 'ollama' }).kinds).toContain('ollama');
  });

  it('counts a real cloud key', () => {
    seedProviders([{ id: 'openrouter', api_key: 'sk-or-a-real-looking-key' }]);
    expect(getBackendStatus().kinds).toContain('openrouter');
  });

  it('reports nothing usable on a bare install', () => {
    seedProviders([]);
    const status = getBackendStatus();
    expect(status.hasAny).toBe(false);
    expect(status.kinds).toEqual([]);
    expect(status.primaryLabel).toBe('No AI provider');
  });

  it('never counts a license key as an AI backend — no hosted AI is enabled', () => {
    localStorage.setItem('henry:license_key', 'lic_abc');
    const status = getBackendStatus();
    expect(status.hasAny).toBe(false);
    expect(status.kinds).toEqual([]);
    expect(status.primaryLabel).toBe('No AI provider');
    expect(hasUsableBackend()).toBe(false);
  });

  it('never counts a relay URL as an AI backend — it is not an engine selection', () => {
    localStorage.setItem('henry:providers', JSON.stringify([]));
    const status = getBackendStatus({ relay_base_url: 'https://relay.example.com/v1' });
    expect(status.hasAny).toBe(false);
    expect(status.kinds).toEqual([]);
  });
});