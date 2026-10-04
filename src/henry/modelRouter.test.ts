/**
 * Tests for the model router.
 *
 * The router's whole job is refusing to lie about where a message went. Three
 * properties are load-bearing and are pinned here:
 *
 *  1. Chat resolves the Companion engine keys the model picker writes —
 *     `companion_provider` / `companion_model` — and nothing else. The Worker
 *     engine row and the never-written `chat_fast_*` keys must not steer chat.
 *  2. An `opencode-zen` selection routes to the Zen provider row, carrying the
 *     exact Zen model that was picked.
 *  3. Anything unresolved throws a typed error naming what is unresolved. There
 *     is no substitute provider to fall through to, and nothing is dispatched.
 */

import { describe, it, expect } from 'vitest';
import {
  RETIRED_PROVIDER_IDS,
  retiredProviderUnavailableMessage,
} from '../../electron/providers/retiredProviders';
import {
  CHAT_MODEL_SETTING,
  CHAT_PROVIDER_SETTING,
  ProviderRoutingError,
  detectTaskType,
  isProviderRoutingError,
  isSupportedProviderId,
  modelShortName,
  requiresQualityModel,
  resolveChat,
  routeLabel,
  type ProviderRoutingError as RoutingError,
} from './modelRouter';

const ZEN_MODELS = ['deepseek-v4-flash-free', 'hy3-free'];
const zenRow = { id: 'opencode-zen', name: 'OpenCode Zen', apiKey: 'zen-key-abc', models: [...ZEN_MODELS] };
const openaiRow = { id: 'openai', name: 'OpenAI', apiKey: 'sk-fake-test-key-000', models: ['gpt-4o-mini'] };
const ollamaRow = { id: 'ollama', name: 'Ollama (Local)', apiKey: '', models: ['qwen2.5-coder:7b'] };
const allRows = [zenRow, openaiRow, ollamaRow];

const zenSettings = {
  [CHAT_PROVIDER_SETTING]: 'opencode-zen',
  [CHAT_MODEL_SETTING]: 'hy3-free',
};

/** Captures the routing error a call throws, failing if it does not throw one. */
function routingError(fn: () => unknown): RoutingError {
  try {
    fn();
  } catch (e: unknown) {
    if (isProviderRoutingError(e)) return e;
    throw new Error(`expected a ProviderRoutingError, got: ${String(e)}`);
  }
  throw new Error('expected resolveChat to throw a ProviderRoutingError');
}

describe('detectTaskType', () => {
  it('routes very short messages and acks to fast', () => {
    expect(detectTaskType('ok')).toBe('chat_fast');
    expect(detectTaskType('thanks, got it')).toBe('chat_fast');
  });

  it('routes heavy writing/strategy requests to quality', () => {
    const msg = 'Please write a detailed business proposal for my new web design service, '
      + 'including a pricing strategy and a short market analysis.';
    expect(detectTaskType(msg)).toBe('chat_quality');
  });

  it('routes very long input to quality', () => {
    expect(detectTaskType('a '.repeat(220))).toBe('chat_quality'); // > 400 chars
  });

  it('routes mid-length neutral chatter to balanced', () => {
    const msg = 'I stopped by the store earlier today and picked up a few things for the kitchen, '
      + 'then grabbed some snacks to keep around for later in the week.';
    expect(detectTaskType(msg)).toBe('chat_balanced');
  });
});

describe('requiresQualityModel', () => {
  it('honors an explicit fast preference regardless of content', () => {
    expect(requiresQualityModel('write a long detailed strategy plan', { model_quality_preference: 'fast' })).toBe(false);
  });

  it('honors an explicit quality preference regardless of content', () => {
    expect(requiresQualityModel('hi', { model_quality_preference: 'quality' })).toBe(true);
  });

  it('uses content detection under the balanced default', () => {
    expect(requiresQualityModel('hi', {})).toBe(false);
    expect(requiresQualityModel(
      'Please write a detailed business proposal for my new web design service, '
      + 'including a pricing strategy and a short market analysis.',
      {},
    )).toBe(true);
  });
});

describe('resolveChat — routes the engine the model picker writes', () => {
  it('routes to the provider and model named by the companion engine settings', () => {
    const r = resolveChat('hi', zenSettings, allRows);
    expect(r.provider).toBe('opencode-zen');
    expect(r.model).toBe('hy3-free');
    expect(r.apiKey).toBe('zen-key-abc');
  });

  it('routes a local engine whose provider needs no key', () => {
    const r = resolveChat('hi', {
      [CHAT_PROVIDER_SETTING]: 'ollama',
      [CHAT_MODEL_SETTING]: 'qwen2.5-coder:7b',
    }, allRows);
    expect(r.provider).toBe('ollama');
    expect(r.apiKey).toBe('');
  });

  it('parses a provider whose models are stored as a JSON string', () => {
    const r = resolveChat('hi', zenSettings, [
      { id: 'opencode-zen', name: 'OpenCode Zen', api_key: 'zen-key-abc', models: JSON.stringify(ZEN_MODELS) },
    ]);
    expect(r.model).toBe('hy3-free');
    expect(r.apiKey).toBe('zen-key-abc');
  });

  it('reports the tier and the plain-English reason without changing the route', () => {
    const r = resolveChat('hi', { ...zenSettings, model_quality_preference: 'fast' }, allRows);
    expect(r.tier).toBe('fast');
    expect(r.reason).toBe('Fast mode (your setting)');
    expect(r.provider).toBe('opencode-zen');
  });

  it('ignores the Worker engine row — it belongs to the queue, not to chat', () => {
    // A quality-tier message used to be routed through `worker_provider`, so a
    // Companion selection was replaced by whatever the Worker row held.
    const msg = 'Please write a detailed business proposal for my new web design service, '
      + 'including a pricing strategy and a short market analysis.';
    const r = resolveChat(msg, {
      ...zenSettings,
      worker_provider: 'openai',
      worker_model: 'gpt-4o-mini',
    }, allRows);
    expect(r.tier).toBe('quality');
    expect(r.provider).toBe('opencode-zen');
    expect(r.model).toBe('hy3-free');
  });

  it('ignores chat_fast_* keys, which no surface in the app writes', () => {
    const r = resolveChat('hi', {
      ...zenSettings,
      chat_fast_provider: 'openai',
      chat_fast_model: 'gpt-4o-mini',
      model_quality_preference: 'fast',
    }, allRows);
    expect(r.provider).toBe('opencode-zen');
    expect(r.model).toBe('hy3-free');
  });
});

describe('resolveChat — opencode-zen reaches the opencode transport with the selected model', () => {
  it('keeps the Zen identity and carries the exact model that was selected', () => {
    for (const modelId of ZEN_MODELS) {
      const r = resolveChat('hi', {
        [CHAT_PROVIDER_SETTING]: 'opencode-zen',
        [CHAT_MODEL_SETTING]: modelId,
      }, allRows);
      expect(r.provider).toBe('opencode-zen');
      expect(r.model).toBe(modelId);
    }
  });

  it('routes a Zen model even when other providers are configured and keyed', () => {
    const r = resolveChat('what is the status of the launch?', zenSettings, allRows);
    expect(r.provider).toBe('opencode-zen');
    expect(r.model).toBe('hy3-free');
  });

  it('accepts a Zen row with no key, because the bridge authenticates itself', () => {
    const r = resolveChat('hi', zenSettings, [
      { id: 'opencode-zen', name: 'OpenCode Zen', apiKey: '', models: [...ZEN_MODELS] },
    ]);
    expect(r.apiKey).toBe('');
    expect(r.provider).toBe('opencode-zen');
  });
});

describe('resolveChat — an unresolved engine is reported, never substituted', () => {
  it('names the provider when no engine is selected at all', () => {
    const err = routingError(() => resolveChat('hi', {}, allRows));
    expect(err.code).toBe('provider_not_configured');
    expect(err.settingKey).toBe(CHAT_PROVIDER_SETTING);
    expect(err.message).toContain(CHAT_PROVIDER_SETTING);
  });

  it('names a provider that is no longer supported, even when its row still exists', () => {
    // An existing install keeps a retired provider id in settings and in the
    // providers table. It must not be dispatched, and it must not fall through
    // to another provider — the only honest outcome is "pick a supported one".
    const retiredId = 'retired-cloud-llm';
    const rows = [...allRows, { id: retiredId, name: 'Retired', apiKey: 'not-a-real-secret', models: ['m'] }];
    const err = routingError(() => resolveChat('hi', {
      [CHAT_PROVIDER_SETTING]: retiredId,
      [CHAT_MODEL_SETTING]: 'm',
    }, rows));
    expect(err.code).toBe('provider_unsupported');
    expect(err.providerId).toBe(retiredId);
    expect(err.message).toContain(retiredId);
    expect(err.message).toContain('no longer available');
  });

  it('says exactly what the main process says for every retired provider id', () => {
    // The renderer and the transport must not tell the user two different
    // stories about the same retired selection, so the sentence is compared
    // against the shared helper rather than retyped here.
    for (const retiredId of RETIRED_PROVIDER_IDS) {
      const rows = [...allRows, { id: retiredId, name: 'Retired', apiKey: 'not-a-real-secret', models: ['m'] }];
      const err = routingError(() => resolveChat('hi', {
        [CHAT_PROVIDER_SETTING]: retiredId,
        [CHAT_MODEL_SETTING]: 'm',
      }, rows));
      expect(err.code).toBe('provider_unsupported');
      expect(err.detail).toBe(retiredProviderUnavailableMessage(retiredId));
    }
  });

  it('names a supported provider that has no row', () => {
    const err = routingError(() => resolveChat('hi', {
      [CHAT_PROVIDER_SETTING]: 'anthropic',
      [CHAT_MODEL_SETTING]: 'claude-sonnet-4-20250514',
    }, allRows));
    expect(err.code).toBe('provider_row_missing');
    expect(err.providerId).toBe('anthropic');
    expect(err.message).toContain('anthropic');
  });

  it('names the model setting when no model is selected', () => {
    const err = routingError(() => resolveChat('hi', {
      [CHAT_PROVIDER_SETTING]: 'opencode-zen',
    }, allRows));
    expect(err.code).toBe('model_not_configured');
    expect(err.settingKey).toBe(CHAT_MODEL_SETTING);
    expect(err.message).toContain(CHAT_MODEL_SETTING);
  });

  it('names the model when the selected one is not offered by that provider', () => {
    // Substituting the provider's first model is what made a Zen pick silently
    // answer with a different model than the one on screen.
    const err = routingError(() => resolveChat('hi', {
      [CHAT_PROVIDER_SETTING]: 'opencode-zen',
      [CHAT_MODEL_SETTING]: 'gpt-4o-mini',
    }, allRows));
    expect(err.code).toBe('model_unavailable');
    expect(err.providerId).toBe('opencode-zen');
    expect(err.model).toBe('gpt-4o-mini');
    expect(err.message).toContain('gpt-4o-mini');
  });

  it('names the provider whose key is missing, and does not borrow another provider key', () => {
    const err = routingError(() => resolveChat('hi', {
      [CHAT_PROVIDER_SETTING]: 'openai',
      [CHAT_MODEL_SETTING]: 'gpt-4o-mini',
    }, [zenRow, { id: 'openai', name: 'OpenAI', apiKey: '', models: ['gpt-4o-mini'] }]));
    expect(err.code).toBe('api_key_missing');
    expect(err.providerId).toBe('openai');
    expect(err.message).toContain('openai');
  });

  it('throws the router\'s own error class and returns no route', () => {
    const unresolved: Array<Record<string, string>> = [
      {},
      { [CHAT_PROVIDER_SETTING]: 'anthropic', [CHAT_MODEL_SETTING]: 'claude-sonnet-4-20250514' },
      { [CHAT_PROVIDER_SETTING]: 'opencode-zen' },
      { [CHAT_PROVIDER_SETTING]: 'opencode-zen', [CHAT_MODEL_SETTING]: 'nope' },
    ];
    for (const settings of unresolved) {
      expect(() => resolveChat('hi', settings, allRows)).toThrow(ProviderRoutingError);
    }
  });
});

describe('isSupportedProviderId', () => {
  it('accepts the providers the app still ships and rejects anything else', () => {
    expect(isSupportedProviderId('opencode-zen')).toBe(true);
    expect(isSupportedProviderId('opencode')).toBe(true);
    expect(isSupportedProviderId('ollama')).toBe(true);
    expect(isSupportedProviderId('anthropic')).toBe(true);
    expect(isSupportedProviderId('retired-cloud-llm')).toBe(false);
  });
});

describe('modelShortName + routeLabel', () => {
  it('shortens common model ids', () => {
    expect(modelShortName('llama-3.1-8b-instant')).toBe('8B');
    expect(modelShortName('llama-3.3-70b-versatile')).toBe('70B');
    expect(modelShortName('claude-sonnet-4-5')).toBe('Sonnet 4');
    expect(modelShortName('gpt-4o-mini')).toBe('GPT-4o Mini');
    expect(modelShortName('deepseek-r1:32b')).toBe('DeepSeek');
    expect(modelShortName('hy3-free')).toBe('free');
  });

  it('builds a readable route label', () => {
    expect(routeLabel({ provider: 'opencode-zen', model: 'hy3-free', apiKey: '' })).toBe('opencode-zen / free');
    expect(routeLabel({ provider: 'ollama', model: 'qwen2.5-coder:7b', apiKey: '' })).toBe('ollama / coder:7b');
  });
});