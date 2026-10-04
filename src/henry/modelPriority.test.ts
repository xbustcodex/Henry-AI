/**
 * Tests for the Ollama model selection + fallback logic (provider fallback
 * danger path, build plan Phase 0). Pure logic — no Electron, no network.
 *
 * Why this matters: if `selectBestModel` mis-matches a quantized tag or
 * `autoSelectModels` picks the same model for primary and fallback, Henry
 * either runs the wrong local brain or has no real standby when one fails.
 */

import { describe, it, expect } from 'vitest';
import {
  selectBestModel,
  autoSelectModels,
  COMPANION_MODEL_PRIORITY,
  WORKER_MODEL_PRIORITY,
} from './modelPriority';

describe('selectBestModel', () => {
  it('matches an exact installed model id', () => {
    const r = selectBestModel(['qwen2.5:7b'], COMPANION_MODEL_PRIORITY);
    expect(r?.id).toBe('qwen2.5:7b');
  });

  it('matches a quantized / suffixed variant to its base priority entry', () => {
    // installed has an instruct + quant suffix; priority lists the plain base.
    const r = selectBestModel(['llama3.3:70b-instruct-q4_K_M'], COMPANION_MODEL_PRIORITY);
    expect(r?.id).toBe('llama3.3:70b-instruct-q4_K_M');
  });

  it('returns the HIGHEST-priority model when several are installed', () => {
    // qwen2.5:32b outranks llama3.2:3b in the companion list.
    const r = selectBestModel(['llama3.2:3b', 'qwen2.5:32b'], COMPANION_MODEL_PRIORITY);
    expect(r?.id).toBe('qwen2.5:32b');
  });

  it('is case- and whitespace-insensitive', () => {
    const r = selectBestModel(['  Qwen2.5:7B '], COMPANION_MODEL_PRIORITY);
    expect(r).not.toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(selectBestModel(['some-unknown-model:1b'], COMPANION_MODEL_PRIORITY)).toBeNull();
  });

  it('returns null for an empty installed list', () => {
    expect(selectBestModel([], WORKER_MODEL_PRIORITY)).toBeNull();
  });
});

describe('autoSelectModels', () => {
  it('selects a companion and a worker model from what is installed', () => {
    const r = autoSelectModels(['qwen2.5:32b', 'deepseek-r1:14b']);
    expect(r.companion?.id).toBe('qwen2.5:32b');
    expect(r.worker?.id).toBe('deepseek-r1:14b');
  });

  it('picks a fallback model from a DIFFERENT family than the primary', () => {
    // Both qwen 32b and a llama are installed; fallback must not be the qwen family.
    const r = autoSelectModels(['qwen2.5:32b', 'llama3.2:3b']);
    expect(r.companion?.id).toBe('qwen2.5:32b');
    if (r.companionFallback) {
      expect(r.companionFallback.id.startsWith('qwen')).toBe(false);
    }
  });

  it('returns nulls for every brain when nothing is installed', () => {
    const r = autoSelectModels([]);
    expect(r.companion).toBeNull();
    expect(r.companionFallback).toBeNull();
    expect(r.worker).toBeNull();
  });
});
