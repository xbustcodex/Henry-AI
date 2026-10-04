// @vitest-environment jsdom
/**
 * The renderer half of the local-model defect.
 *
 * `AVAILABLE_MODELS` used to hold 19 hard-written Ollama entries with invented
 * context windows and capabilities guessed from the model name. These tests
 * assert the replacement: everything the picker shows about a local model comes
 * from what the runtime reported, and the fallback — if one is ever consulted —
 * is visible to the user rather than silent.
 */
import { describe, it, expect } from 'vitest';
import { AVAILABLE_MODELS, getModelsForProvider } from './models';
import {
  localModelsToAIModels,
  localModelToAIModel,
  localModelLabel,
  localModelCapabilities,
  localCatalogState,
  OLLAMA_PROVIDER_ID,
} from './localModels';
import type { LocalModelInfo } from '../../electron/ipc/ollamaCapabilities';

function discovered(over: Partial<LocalModelInfo> = {}): LocalModelInfo {
  return {
    provider: 'ollama',
    runtime: 'ollama',
    id: 'llama3.2:3b',
    name: 'llama3.2:3b',
    displayName: 'Llama3.2 3B',
    local: true,
    requiresApiKey: false,
    sizeBytes: 2_019_393_189,
    sizeGB: '2.0',
    family: 'llama',
    parameterSize: '3.2B',
    contextLength: 131072,
    capabilities: ['completion', 'tools'],
    capabilitySource: 'runtime',
    detailStatus: 'ok',
    loadable: true,
    ...over,
  };
}

describe('the static catalogue carries no local models any more', () => {
  it('has no Ollama entries to drift out of date', () => {
    // This is the defect in one assertion: every local model the picker used to
    // offer came from this array, so a stale entry is a model the user does not
    // have, or a capability nobody verified.
    expect(getModelsForProvider(OLLAMA_PROVIDER_ID)).toEqual([]);
    expect(AVAILABLE_MODELS.some((m) => m.provider === 'ollama')).toBe(false);
  });

  it('still lists the cloud providers it always did', () => {
    expect(AVAILABLE_MODELS.length).toBeGreaterThan(20);
    expect(AVAILABLE_MODELS.some((m) => m.provider === 'anthropic')).toBe(true);
  });
});

describe('a discovered model becomes a picker entry', () => {
  it('keeps the runtime id, which is what /api/chat will accept', () => {
    expect(localModelToAIModel(discovered()).id).toBe('llama3.2:3b');
  });

  it('uses the reported context length, not an invented one', () => {
    expect(localModelToAIModel(discovered({ contextLength: 2048 })).contextWindow).toBe(2048);
    expect(localModelToAIModel(discovered({ contextLength: 131072 })).contextWindow).toBe(131072);
  });

  it('shows an unreported context length as unknown rather than a default', () => {
    // The old table claimed 128000 for every local model, including a 2048-token
    // one. A user picking by context window was being told a fiction.
    expect(localModelToAIModel(discovered({ contextLength: null })).contextWindow).toBe(0);
  });

  it('is free and local, so nothing downstream prices it per token', () => {
    const model = localModelToAIModel(discovered());
    expect(model.inputPricePer1M).toBe(0);
    expect(model.outputPricePer1M).toBe(0);
    expect(model.local).toBe(true);
  });

  it('translates the runtime vocabulary, keeping every capability it reported', () => {
    expect(localModelCapabilities(discovered({ capabilities: ['completion', 'vision'] }))).toEqual(['chat', 'vision']);
    expect(localModelCapabilities(discovered({ capabilities: ['completion', 'tools', 'insert'] }))).toEqual(['chat', 'tools', 'insert']);
    expect(localModelCapabilities(discovered({ capabilities: ['embedding'] }))).toEqual(['embedding']);
    expect(localModelCapabilities(discovered({ capabilities: ['completion', 'thinking'] }))).toEqual(['chat', 'reasoning']);
  });

  it('passes an unknown capability through instead of swallowing it', () => {
    expect(localModelCapabilities(discovered({ capabilities: ['completion', 'audio'] }))).toEqual(['chat', 'audio']);
  });

  it('maps one discovered model to exactly one option — no static duplicate', () => {
    const models = localModelsToAIModels([
      discovered(),
      discovered({ id: 'moondream:latest', name: 'moondream:latest', displayName: 'Moondream' }),
    ]);
    expect(models.map((m) => m.id)).toEqual(['llama3.2:3b', 'moondream:latest']);
  });
});

describe('what the user reads next to a local model', () => {
  it('states the facts that decide whether the model is usable', () => {
    const label = localModelLabel(discovered({ capabilities: ['completion', 'vision'] }));
    expect(label).toContain('Llama3.2 3B');
    expect(label).toContain('3.2B');
    expect(label).toContain('vision');
    expect(label).toContain('131k ctx');
  });

  it('marks an assumed capability as assumed — the fallback must not read like a fact', () => {
    const label = localModelLabel(
      discovered({ capabilities: ['completion', 'vision'], capabilitySource: 'fallback', detailStatus: 'assumed' })
    );
    expect(label).toContain('assumed');
  });

  it('does not mark a runtime-confirmed capability as assumed', () => {
    expect(localModelLabel(discovered())).not.toContain('assumed');
  });
});

describe('the picker states the local situation instead of going blank', () => {
  it('says nothing when discovery worked cleanly', () => {
    expect(localCatalogState([discovered()])).toEqual({ kind: 'ok' });
  });

  it('says Ollama is not reachable rather than showing an empty list', () => {
    // An empty <select> reads as "you own no models". On this machine the user
    // owns seven; the difference between those two is whether Ollama is running.
    const state = localCatalogState([], 'Ollama at http://127.0.0.1:11434 did not respond within 8s.');
    expect(state.kind).toBe('unreachable');
    expect(state.message).toMatch(/did not respond/);
  });

  it('offers a next step when there are genuinely no models', () => {
    expect(localCatalogState([]).message).toMatch(/ollama pull/);
  });

  it('surfaces a per-model degradation without hiding the working models', () => {
    const state = localCatalogState([
      discovered(),
      discovered({ id: 'corrupt:7b', warning: 'corrupt:7b is listed by Ollama but cannot be loaded.' }),
    ]);
    expect(state.kind).toBe('degraded');
    expect(state.message).toMatch(/corrupt:7b/);
  });
});