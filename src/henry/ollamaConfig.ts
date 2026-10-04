/**
 * Local Ollama defaults for Henry's primary brain (no cloud API key required).
 * Settings keys: henry_provider, henry_ollama_host, henry_ollama_model (localStorage)
 * plus henry:settings companion_* and ollama_base_url (existing app settings).
 */

import { ollamaChatAdapter } from './ollamaProviderAdapter';

export const OLLAMA_DEFAULT_HOST = 'http://localhost:11434';
export const OLLAMA_DEFAULT_MODEL = 'llama3.2';

export const LS_HENRY_PROVIDER = 'henry_provider';
export const LS_HENRY_OLLAMA_HOST = 'henry_ollama_host';
export const LS_HENRY_OLLAMA_MODEL = 'henry_ollama_model';

export type OllamaConnectionTestResult =
  | { ok: true; model: string; host: string }
  | { ok: false; error: string; host: string };

/** Effective Ollama API base (no trailing slash). */
export function getOllamaBaseUrl(settings?: Record<string, string>): string {
  try {
    const fromLs = localStorage.getItem(LS_HENRY_OLLAMA_HOST)?.trim();
    if (fromLs) return fromLs.replace(/\/$/, '');
  } catch {
    /* ignore */
  }
  const fromSettings = settings?.ollama_base_url?.trim();
  if (fromSettings) return fromSettings.replace(/\/$/, '');
  return OLLAMA_DEFAULT_HOST.replace(/\/$/, '');
}

/**
 * One-time / idempotent defaults: when no companion provider is set, use local Ollama.
 * When companion is already ollama, sync host/model from henry_* keys.
 * Does not replace explicit cloud providers (e.g. user chose groq + key).
 */
export function applyOllamaBrainDefaultsIfNeeded(): void {
  try {
    const raw = localStorage.getItem('henry:settings') || '{}';
    const s = JSON.parse(raw) as Record<string, string>;
    const companion = (s.companion_provider || '').trim();

    const host =
      localStorage.getItem(LS_HENRY_OLLAMA_HOST)?.trim() ||
      s.ollama_base_url?.trim() ||
      OLLAMA_DEFAULT_HOST;
    const model =
      localStorage.getItem(LS_HENRY_OLLAMA_MODEL)?.trim() || s.companion_model?.trim() || OLLAMA_DEFAULT_MODEL;

    if (!companion) {
      if (!localStorage.getItem(LS_HENRY_PROVIDER)) {
        localStorage.setItem(LS_HENRY_PROVIDER, 'ollama');
      }
      if (!localStorage.getItem(LS_HENRY_OLLAMA_HOST)) {
        localStorage.setItem(LS_HENRY_OLLAMA_HOST, host);
      }
      if (!localStorage.getItem(LS_HENRY_OLLAMA_MODEL)) {
        localStorage.setItem(LS_HENRY_OLLAMA_MODEL, model);
      }

      s.companion_provider = 'ollama';
      s.companion_model = localStorage.getItem(LS_HENRY_OLLAMA_MODEL) || model;
      s.ollama_base_url = localStorage.getItem(LS_HENRY_OLLAMA_HOST) || host;
      if (!s.worker_provider?.trim()) {
        s.worker_provider = 'ollama';
        s.worker_model = s.companion_model;
      }

      localStorage.setItem('henry:settings', JSON.stringify(s));

      const provs: Array<Record<string, unknown>> = (() => {
        try {
          return JSON.parse(localStorage.getItem('henry:providers') || '[]');
        } catch {
          return [];
        }
      })();
      const o = provs.find((p) => p.id === 'ollama');
      const modelsJson = JSON.stringify([model, 'llama3.1', 'mistral']);
      if (!o) {
        provs.push({
          id: 'ollama',
          name: 'Ollama (local)',
          api_key: '',
          apiKey: '',
          enabled: 1,
          models: modelsJson,
        });
      } else {
        o.enabled = 1;
        if (!o.models) o.models = modelsJson;
      }
      localStorage.setItem('henry:providers', JSON.stringify(provs));
      return;
    }

    if (companion === 'ollama') {
      if (!localStorage.getItem(LS_HENRY_PROVIDER)) {
        localStorage.setItem(LS_HENRY_PROVIDER, 'ollama');
      }
      s.ollama_base_url = getOllamaBaseUrl(s);
      s.companion_model = localStorage.getItem(LS_HENRY_OLLAMA_MODEL) || s.companion_model || OLLAMA_DEFAULT_MODEL;
      localStorage.setItem('henry:settings', JSON.stringify(s));
    }
  } catch (e) {
    console.warn('[Henry] applyOllamaBrainDefaultsIfNeeded:', e);
  }
}

export function buildOllamaChatRequestBody(params: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}): Record<string, unknown> {
  const stream = params.stream ?? false;
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    stream,
    keep_alive: '5m',
  };
  body.options = {
    temperature: params.temperature ?? 0.7,
    num_predict: params.maxTokens ?? 4096,
  };
  return body;
}

export function parseOllamaChatJson(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as { message?: { content?: string }; error?: string };
  if (typeof d.error === 'string' && d.error) {
    throw new Error(d.error);
  }
  const text = d.message?.content;
  return typeof text === 'string' ? text : '';
}

/**
 * Lightweight connection check — never throws; safe for Settings / diagnostics.
 */
/**
 * Ensures localStorage defaults, then syncs Ollama as primary brain into `henryAPI` when
 * `companion_provider` is unset (web + Electron).
 */
export async function syncOllamaDefaultsToBackendIfNeeded(): Promise<void> {
  applyOllamaBrainDefaultsIfNeeded();
  const api = window.henryAPI;
  if (!api?.getSettings || !api.saveSetting || !api.getProviders || !api.saveProvider) return;
  try {
    const s = await api.getSettings();
    if (s.companion_provider?.trim()) return;

    const model = localStorage.getItem(LS_HENRY_OLLAMA_MODEL)?.trim() || OLLAMA_DEFAULT_MODEL;
    const host = localStorage.getItem(LS_HENRY_OLLAMA_HOST)?.trim() || OLLAMA_DEFAULT_HOST;
    if (!localStorage.getItem(LS_HENRY_PROVIDER)) {
      localStorage.setItem(LS_HENRY_PROVIDER, 'ollama');
    }
    await api.saveSetting('companion_provider', 'ollama');
    await api.saveSetting('companion_model', model);
    await api.saveSetting('ollama_base_url', host);
    if (!s.worker_provider?.trim()) {
      await api.saveSetting('worker_provider', 'ollama');
      await api.saveSetting('worker_model', model);
    }

    const providers = await api.getProviders();
    if (!providers.some((p) => p.id === 'ollama')) {
      await api.saveProvider({
        id: 'ollama',
        name: 'Ollama (local)',
        apiKey: '',
        enabled: true,
        models: JSON.stringify([model, 'llama3.1', 'mistral']),
      } as Parameters<typeof api.saveProvider>[0]);
    }
  } catch (e) {
    console.warn('[Henry] syncOllamaDefaultsToBackendIfNeeded:', e);
  }
}

export async function testOllamaConnection(
  opts?: { baseUrl?: string; model?: string }
): Promise<OllamaConnectionTestResult> {
  const host = (opts?.baseUrl || getOllamaBaseUrl()).replace(/\/$/, '');
  const model = opts?.model?.trim() || localStorage.getItem(LS_HENRY_OLLAMA_MODEL)?.trim() || OLLAMA_DEFAULT_MODEL;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12_000);
  const r = await ollamaChatAdapter({
    host,
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    maxTokens: 32,
    signal: controller.signal,
  });
  clearTimeout(t);
  if (r.ok) {
    return { ok: true, model: r.model, host };
  }
  return { ok: false, error: r.error, host };
}
