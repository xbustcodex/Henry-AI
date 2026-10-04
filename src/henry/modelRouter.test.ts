/**
 * Tests for the model router — task detection and the provider-fallback chain
 * (build plan Phase 0 danger path). Pure logic; no Electron, no network.
 *
 * The highest-stakes piece is `resolveChat`'s fallback: when the chosen tier's
 * provider has no API key it must fall back to the primary, and when nothing
 * has a key it must throw a clear error rather than silently returning ''.
 */

import { describe, it, expect } from 'vitest';
import {
  detectTaskType,
  requiresQualityModel,
  resolveChat,
  modelShortName,
  routeLabel,
} from './modelRouter';

describe('detectTaskType', () => {
  it('routes very short messages and acks to fast', () => {
    expect(detectTaskType('ok')).toBe('chat_fast');
    expect(detectTaskType('thanks, got it')).toBe('chat_fast');
  });

  it('routes heavy writing/strategy requests to quality', () => {
    const msg =
      'Please write a detailed business proposal for my new web design service, including a pricing strategy and a short market analysis.';
    expect(detectTaskType(msg)).toBe('chat_quality');
  });

  it('routes very long input to quality', () => {
    expect(detectTaskType('a '.repeat(220))).toBe('chat_quality'); // > 400 chars
  });

  it('routes mid-length neutral chatter to balanced', () => {
    const msg =
      'I stopped by the store earlier today and picked up a few things for the kitchen, then grabbed some snacks to keep around for later in the week.';
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
    expect(requiresQualityModel('analyze and compare these two strategies in depth for me', {})).toBe(true);
    expect(requiresQualityModel('ok', {})).toBe(false);
  });
});

describe('resolveChat — provider fallback chain', () => {
  const groqWithKey = { id: 'groq', api_key: 'gk', models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'] };

  it('uses the fast tier provider/model under a fast preference', () => {
    const r = resolveChat('hi', {
      model_quality_preference: 'fast',
      chat_fast_provider: 'groq',
      chat_fast_model: 'llama-3.1-8b-instant',
    }, [groqWithKey]);
    expect(r.provider).toBe('groq');
    expect(r.model).toBe('llama-3.1-8b-instant');
    expect(r.tier).toBe('fast');
  });

  it('falls back to the primary provider when the chosen tier provider has no key', () => {
    const r = resolveChat('write a detailed strategy plan and roadmap', {
      model_quality_preference: 'quality',
      worker_provider: 'openai',        // chosen tier provider…
      companion_provider: 'groq',       // …but primary is groq
      companion_model: 'llama-3.3-70b-versatile',
    }, [groqWithKey, { id: 'openai', api_key: '', models: [] }]);
    expect(r.provider).toBe('groq');
    expect(r.apiKey).toBe('gk');
    expect(r.reason).toMatch(/fell back/i);
  });

  it('throws a clear error when no provider has a key', () => {
    expect(() =>
      resolveChat('write a detailed strategy plan', {
        model_quality_preference: 'quality',
        worker_provider: 'openai',
        companion_provider: 'groq',
      }, [{ id: 'groq', api_key: '' }, { id: 'openai', api_key: '' }]),
    ).toThrow(/no api key/i);
  });

  it('substitutes the first available model when the chosen model is not in the provider list', () => {
    const r = resolveChat('hi', {
      model_quality_preference: 'fast',
      chat_fast_provider: 'groq',
      chat_fast_model: 'model-that-does-not-exist',
    }, [groqWithKey]);
    expect(r.model).toBe('llama-3.1-8b-instant'); // first in the provider's list
  });

  it('parses a provider whose models are stored as a JSON string', () => {
    const r = resolveChat('hi', {
      model_quality_preference: 'fast',
      chat_fast_provider: 'groq',
      chat_fast_model: 'llama-3.1-8b-instant',
    }, [{ id: 'groq', apiKey: 'gk', models: '["llama-3.1-8b-instant"]' }]);
    expect(r.model).toBe('llama-3.1-8b-instant');
    expect(r.apiKey).toBe('gk');
  });
});

describe('modelShortName + routeLabel', () => {
  it('shortens common model ids', () => {
    expect(modelShortName('llama-3.1-8b-instant')).toBe('8B');
    expect(modelShortName('llama-3.3-70b-versatile')).toBe('70B');
    expect(modelShortName('claude-sonnet-4-5')).toBe('Sonnet 4');
    expect(modelShortName('gpt-4o-mini')).toBe('GPT-4o Mini');
    expect(modelShortName('deepseek-r1:32b')).toBe('DeepSeek');
  });

  it('builds a readable route label', () => {
    expect(routeLabel({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'x' })).toBe('groq / 70b');
  });
});
