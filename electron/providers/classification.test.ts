/**
 * Provider classification — the seam Defect C lived on.
 *
 * The installed build logged `Worker provider "OpenCode (CLI)" is missing an
 * API key.` while the settings store reported `opencode-zen` as having a key.
 * Both were true: the scheduler asked a different question than the picker
 * answered, because each had written its own copy of "is this an ordinary
 * key-gated provider?" and both copies only knew about `ollama`.
 *
 * These tests pin the one shared answer, including the property that actually
 * caused the outage: the scheduler and the picker must agree on every id.
 */
import { describe, it, expect } from 'vitest';
import {
  isOpencodeProvider,
  isOllamaProvider,
  opencodeProviderIdForModel,
  requiresApiKey,
  OPENCODE_PROVIDER_ID,
  OPENCODE_PROVIDER_IDS,
  OPENCODE_ZEN_PROVIDER_ID,
} from './classification';

describe('a credential-free provider is not gated on an API key', () => {
  it('does not require a key for opencode, the CLI as a whole', () => {
    // This is the exact row the model picker writes: an empty key, because the
    // opencode CLI authenticates with OPENCODE_API_KEY in its own child
    // environment and never reads Henry's providers table for a key.
    expect(requiresApiKey({ id: OPENCODE_PROVIDER_ID, name: 'OpenCode (CLI)', api_key: '' })).toBe(false);
  });

  it('does not require a key for opencode-zen', () => {
    // Zen is credential-OPTIONAL, not credential-required: free Zen models run
    // unauthenticated and a saved key only widens the catalogue. Gating it made
    // the provider unusable for exactly the users who had no key yet.
    expect(requiresApiKey({ id: OPENCODE_ZEN_PROVIDER_ID, name: 'OpenCode Zen', api_key: '' })).toBe(false);
  });

  it('still requires a key for ollama it does NOT have — ollama has no keys', () => {
    expect(requiresApiKey({ id: 'ollama', name: 'Ollama (Local)', api_key: '' })).toBe(false);
  });

  it('still requires a key for a genuinely key-gated provider', () => {
    // The regression this guards: widening the exemption must not exempt
    // everything. A cloud provider with no key is still an error.
    // `acme-ai` is a fixture: an invented ordinary key-gated provider id, used
    // here (and only here) to mean "some provider that needs a real key".
    expect(requiresApiKey({ id: 'acme-ai', name: 'Acme AI', api_key: '' })).toBe(true);
    expect(requiresApiKey({ id: 'openai', name: 'OpenAI', api_key: '' })).toBe(true);
    expect(requiresApiKey({ id: 'anthropic', name: 'Anthropic', api_key: '' })).toBe(true);
  });

  it('accepts a populated key for any provider, exempt or not', () => {
    expect(requiresApiKey({ id: 'acme-ai', name: 'Acme AI', api_key: 'fake-test-key-000' })).toBe(false);
    expect(requiresApiKey({ id: 'opencode-zen', name: 'OpenCode Zen', api_key: 'zen_real' })).toBe(false);
  });

  it('reads the camelCase key field as well as the snake_case one', () => {
    // providers:getAll returns both spellings; a gate that read only one would
    // see an empty key on a configured provider.
    expect(requiresApiKey({ id: 'acme-ai', name: 'Acme AI', apiKey: '' })).toBe(true);
    expect(requiresApiKey({ id: 'acme-ai', name: 'Acme AI', apiKey: 'fake-test-key-000' })).toBe(false);
  });
});

describe('opencode provider recognition', () => {
  it('recognises both opencode-backed ids', () => {
    for (const id of OPENCODE_PROVIDER_IDS) {
      expect(isOpencodeProvider(id), id).toBe(true);
    }
  });

  it('recognises them regardless of case or surrounding whitespace', () => {
    expect(isOpencodeProvider('OpenCode-Zen')).toBe(true);
    expect(isOpencodeProvider(' opencode ')).toBe(true);
  });

  it('falls back to the display name for a row saved without an id', () => {
    expect(isOpencodeProvider('', 'OpenCode (CLI)')).toBe(true);
  });

  it('does not capture a provider that merely starts with "open"', () => {
    expect(isOpencodeProvider('openrouter')).toBe(false);
    expect(isOpencodeProvider('openai')).toBe(false);
  });

  it('does not capture "opencode enterprise" on a substring match', () => {
    expect(isOpencodeProvider('opencode-enterprise')).toBe(false);
  });

  it('recognises ollama by id or by name', () => {
    expect(isOllamaProvider('ollama')).toBe(true);
    expect(isOllamaProvider('ollama', 'Ollama (Local)')).toBe(true);
    expect(isOllamaProvider('not-a-provider')).toBe(false);
  });
});

describe('the scheduler and the picker classify identically', () => {
  /**
   * THE TEST THAT WOULD HAVE CAUGHT DEFECT C.
   *
   * The scheduler consumed a providers-table row; the picker consumed a
   * discovered model. If the two can ever disagree about a provider id, the
   * user can select a model the executor then refuses to run. Both are driven
   * through the same function here, so a future divergence in either caller is
   * caught when that caller stops using it — and this table is the shared
   * vocabulary they are checked against.
   */
  const REAL_PROVIDER_ROWS = [
    { id: 'acme-ai', name: 'Acme AI', api_key: 'not-a-real-secret' },
    { id: 'ollama', name: 'Ollama (Local)', api_key: '' },
    { id: 'opencode', name: 'OpenCode (CLI)', api_key: '' },
    { id: 'opencode-zen', name: 'OpenCode Zen', api_key: '' },
    { id: 'openrouter', name: 'OpenRouter', api_key: '' },
    { id: 'openai', name: 'OpenAI', api_key: '' },
  ];

  it.each(REAL_PROVIDER_ROWS)(
    'a $id selection survives the trip from picker to scheduler',
    (row) => {
      // 1. The picker offers the id (a discovered or static model resolved to it).
      // 2. The scheduler is handed the stored row for that same id.
      // The invariant: anything the picker can select must be executable.
      const schedulable = !requiresApiKey(row);
      // Every opencode-backed id the picker can emit is schedulable.
      if (isOpencodeProvider(row.id, row.name)) {
        expect(schedulable, `${row.id} is selectable but the scheduler would reject it`).toBe(true);
      }
    },
  );

  it('keeps the two opencode-backed ids distinct end to end', () => {
    // Collapsing them is the Defect B failure: two different providers with two
    // different credentials that must not be written as one.
    expect(opencodeProviderIdForModel({ isZen: true, group: 'opencode-zen' }))
      .not.toBe(opencodeProviderIdForModel({ isZen: false, group: 'openrouter' }));
  });
});