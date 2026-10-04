/**
 * Henry AI — the single front door for any panel that needs to call an LLM.
 *
 * Every panel that does AI work (journal reflection, task suggestions, etc.)
 * should call `callHenryAI()` instead of hitting providers directly.
 *
 * Routing rule — there is exactly one, and it is the user's own:
 *
 *   Use the companion engine they configured (`companion_provider` +
 *   `companion_model`) and nothing else. If it is unset, or cannot be
 *   resolved, say so and stop. Henry does not scan for "some provider that
 *   happens to have a key", does not fill in a default model, does not fall
 *   through to the next provider, and has no hosted tier to fall back to.
 *
 * A panel that cannot be answered shows the setup path instead of answering
 * from somewhere the user never chose.
 */

import {
  isProviderRoutingError,
  resolveChat,
  CHAT_PROVIDER_SETTING,
  CHAT_MODEL_SETTING,
} from './modelRouter';
import type { ModelRoute } from './modelRouter';

export interface HenryAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallHenryAIOptions {
  messages: HenryAIMessage[];
  /** Max tokens to generate. Keep this tight — 200 is enough for most reflections. */
  maxTokens?: number;
  /** Temperature. 0.7 is the default; lower for factual, higher for creative. */
  temperature?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Whether the panel is OK with no backend (returns null instead of throwing). */
  allowNoBackend?: boolean;
}

export class NoBackendAvailableError extends Error {
  readonly userFacingMessage: string;
  constructor(detail?: string) {
    super(detail || 'No AI backend available. User needs to configure a supported provider.');
    this.name = 'NoBackendAvailableError';
    this.userFacingMessage = detail
      ? detail
      : "Henry needs an AI provider to answer that. Open **Settings → AI Providers** and add one — " +
        "OpenRouter and Google have free tiers, OpenCode Zen runs through the opencode bridge, " +
        "and **Ollama** runs fully local and fully free.";
  }
}

interface ResolvedBackend {
  kind: 'ollama' | 'openai' | 'anthropic' | 'google';
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

interface HenryApi {
  getSettings?: () => Promise<Record<string, string>>;
  getProviders?: () => Promise<unknown[]>;
}

function henryApi(): HenryApi | null {
  return typeof window !== 'undefined'
    ? ((window as unknown as { henryAPI?: HenryApi }).henryAPI ?? null)
    : null;
}

async function readSettings(): Promise<Record<string, string>> {
  const api = henryApi();
  if (api?.getSettings) {
    try {
      return (await api.getSettings()) as Record<string, string>;
    } catch {
      /* fall through to the renderer mirror */
    }
  }
  try {
    return JSON.parse(localStorage.getItem('henry:settings') || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Resolve the engine the user configured — or report exactly what is missing.
 *
 * Deliberately absent: any "first provider with a key wins" scan, any default
 * model, any local-runtime first-model pick, any license-gated hosted tier.
 * Those are the silent substitutions this module used to perform.
 */
async function resolveBackend(opts: CallHenryAIOptions): Promise<ResolvedBackend> {
  const settings = await readSettings();
  const providerId = (settings[CHAT_PROVIDER_SETTING] ?? '').trim();
  const model = (settings[CHAT_MODEL_SETTING] ?? '').trim();

  if (!providerId || !model) {
    throw new NoBackendAvailableError(
      'No AI engine is selected. Pick a provider and model in **Settings → AI Providers** — ' +
      'Henry will not choose one for you.',
    );
  }

  const api = henryApi();
  let rows: unknown[] = [];
  if (api?.getProviders) {
    try {
      rows = await api.getProviders();
    } catch {
      rows = [];
    }
  }

  // Same router Chat uses, so a panel and the chat surface can never disagree
  // about whether the selected engine is usable. It throws naming the exact
  // unresolved setting; it never resolves to a substitute.
  let route: ModelRoute;
  try {
    route = resolveChat(opts.messages.map((m) => m.content).join('\n'), settings, rows as never);
  } catch (err) {
    if (isProviderRoutingError(err)) throw new NoBackendAvailableError(err.detail);
    throw err;
  }

  const row = rows.find((p) => (p as { id?: string })?.id === route.provider) as
    | { id: string; name?: string; api_key?: string; apiKey?: string }
    | undefined;

  const apiKey = (row?.api_key || row?.apiKey || '').trim();

  switch (route.provider) {
    case 'ollama':
      return { kind: 'ollama', baseUrl: (settings.ollama_base_url || '').trim() || 'http://localhost:11434', model: route.model };
    case 'openai':
      return { kind: 'openai', apiKey, model: route.model };
    case 'anthropic':
      return { kind: 'anthropic', apiKey, model: route.model };
    case 'google':
      return { kind: 'google', apiKey, model: route.model };
    default:
      // Every other supported engine (the opencode bridge, Zen, a user's own
      // relay) is reached through Chat's own transport, not through this
      // panel-level HTTP path. Saying so is the honest answer; answering from
      // a different engine would be the silent substitution.
      throw new NoBackendAvailableError(
        `Provider \`${route.provider}\` is selected, but panels cannot reach it over this path. ` +
        'Ask Henry in Chat, or choose a provider with its own API key in **Settings → AI Providers**.',
      );
  }
}


/**
 * Call an LLM using the engine the user configured.
 *
 * Returns the text response, or `null` when `allowNoBackend: true` and no
 * engine is configured. Throws `NoBackendAvailableError` — carrying the
 * setup-path message — otherwise. Throws on network/HTTP errors after
 * attempting the configured engine.
 */
export async function callHenryAI(opts: CallHenryAIOptions): Promise<string | null> {
  let backend: ResolvedBackend;
  try {
    backend = await resolveBackend(opts);
  } catch (err) {
    if (opts.allowNoBackend && err instanceof NoBackendAvailableError) return null;
    throw err;
  }

  const maxTokens = opts.maxTokens ?? 500;
  const temperature = opts.temperature ?? 0.7;
  const signal = opts.signal ?? AbortSignal.timeout(30_000);

  // ── Ollama (local) ──────────────────────────────────────────────────────
  if (backend.kind === 'ollama') {
    const r = await fetch((backend.baseUrl || 'http://localhost:11434') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: backend.model, messages: opts.messages, stream: false, options: { temperature, num_predict: maxTokens } }),
      signal,
    });
    if (!r.ok) throw new Error(`Ollama error ${r.status}`);
    const data = await r.json() as { message?: { content?: string } };
    return data.message?.content?.trim() ?? '';
  }

  // ── OpenAI ──────────────────────────────────────────────────────────────
  if (backend.kind === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${backend.apiKey}` },
      body: JSON.stringify({ model: backend.model, messages: opts.messages, max_tokens: maxTokens, temperature }),
      signal,
    });
    if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  }

  // ── Anthropic ───────────────────────────────────────────────────────────
  if (backend.kind === 'anthropic') {
    // Convert OpenAI-style messages to Anthropic system + messages
    const sys = opts.messages.find((m) => m.role === 'system')?.content;
    const turns = opts.messages.filter((m) => m.role !== 'system');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': backend.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: backend.model,
        max_tokens: maxTokens,
        temperature,
        ...(sys ? { system: sys } : {}),
        messages: turns.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal,
    });
    if (!r.ok) throw new Error(`Anthropic error ${r.status}`);
    const data = await r.json() as { content?: Array<{ text?: string }> };
    return data.content?.map((c) => c.text || '').join('').trim() ?? '';
  }

  // ── Google Gemini ───────────────────────────────────────────────────────
  if (backend.kind === 'google') {
    const sys = opts.messages.find((m) => m.role === 'system')?.content;
    const turns = opts.messages.filter((m) => m.role !== 'system');
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${backend.model}:generateContent?key=${backend.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
        contents: turns.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
      signal,
    });
    if (!r.ok) throw new Error(`Gemini error ${r.status}`);
    const data = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim() ?? '';
  }

  // Unreachable: `resolveBackend` throws naming the provider for every engine
  // without a branch above, instead of letting the caller get `null`.
  return null;
}

/**
 * Convenience: is the configured engine usable right now? Panels use this to
 * disable an AI button and show the setup path instead of calling.
 */
export async function hasAIBackend(): Promise<boolean> {
  try {
    await resolveBackend({ messages: [] });
    return true;
  } catch {
    return false;
  }
}

/**
 * A one-line description of the engine that would be used, for diagnostic UI.
 * Never guesses: an unconfigured install reads "None — set up an AI provider".
 */
export async function describeActiveBackend(): Promise<string> {
  let b: ResolvedBackend;
  try {
    b = await resolveBackend({ messages: [] });
  } catch (err) {
    return err instanceof NoBackendAvailableError
      ? `None — ${err.userFacingMessage}`
      : 'None — set up an AI provider';
  }
  switch (b.kind) {
    case 'ollama':    return `Local Ollama (${b.model})`;
    case 'openai':    return `Your OpenAI key (${b.model})`;
    case 'anthropic': return `Your Anthropic key (${b.model})`;
    case 'google':    return `Your Google key (${b.model})`;
  }
}
