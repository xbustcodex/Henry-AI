/**
 * Local Ollama connection helpers.
 *
 * Henry never picks Ollama, a provider, or a model on the user's behalf. What
 * runs locally is discovered from the running runtime (`/api/tags`) and then
 * chosen by the user; nothing here may write a provider selection, a model
 * id, or a fabricated provider row. A machine with Ollama installed and no
 * model chosen is an UNCONFIGURED install, and the UI must say so.
 *
 * Settings key: the app's own `ollama_base_url` setting (or the caller's
 * settings object). There is no second, legacy place an endpoint is kept.
 */

import { ollamaChatAdapter } from './ollamaProviderAdapter';

/** The standard local Ollama endpoint. An address, not a provider choice. */
export const OLLAMA_DEFAULT_HOST = 'http://localhost:11434';



export type OllamaConnectionTestResult =
  | { ok: true; model: string; host: string }
  | { ok: false; error: string; host: string };

/** Effective Ollama API base (no trailing slash). */
export function getOllamaBaseUrl(settings?: Record<string, string>): string {
  const fromSettings = settings?.ollama_base_url?.trim();
  if (fromSettings) return fromSettings.replace(/\/$/, '');
  return OLLAMA_DEFAULT_HOST.replace(/\/$/, '');
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
 *
 * The caller names the model. There is no default: probing with a model the
 * user never chose would report "connected" for a machine that has no such
 * model installed.
 */

export async function testOllamaConnection(
  opts: { baseUrl?: string; model: string }
): Promise<OllamaConnectionTestResult> {
  const host = (opts.baseUrl || getOllamaBaseUrl()).replace(/\/$/, '');
  const model = opts.model.trim();
  if (!model) {
    return {
      ok: false,
      host,
      error:
        'No Ollama model given. Pick a model that the running Ollama reports ' +
        '(Settings → AI Providers → Ollama) — Henry will not pick one for you.',
    };
  }
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
