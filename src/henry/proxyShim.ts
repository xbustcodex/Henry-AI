/**
 * Henry Proxy Shim — one place that decides where a panel's AI call goes.
 *
 * What it does:
 *   Monkey-patches window.fetch on app start. Any panel call aimed at the
 *   hosted proxy endpoint is intercepted and answered from the engine the user
 *   configured (`callHenryAI`). There is no hosted tier to fall through to: a
 *   panel with no configured engine gets the setup-path message back, not an
 *   answer from somewhere the user never chose.
 *
 * Why a shim instead of refactoring every panel:
 *   ~15 panels each call the proxy URL directly (JournalPanel reflections,
 *   TodayPanel "Henry's word", goal nudges, weekly review summaries, …).
 *   Refactoring all of them is risky and expands the diff. A single shim
 *   gives exhaustive coverage with one source of truth.
 *
 * What it does NOT touch:
 *   - Direct API calls to OpenAI / Anthropic / Ollama — those go
 *     straight through to the real provider with the user's own key.
 *   - Streaming requests: they are answered through the same configured
 *     engine (non-streaming) so a panel can never reach the hosted proxy by
 *     setting `stream: true`.
 *
 * How to use:
 *   Call `installProxyShim()` once in main.tsx, before React renders.
 */

import { callHenryAI, NoBackendAvailableError, type HenryAIMessage } from './henryAI';

/**
 * The hosted proxy endpoint panels still address. Henry itself never calls it
 * for a model: the shim intercepts these requests and answers them from the
 * engine the user configured. Kept as one constant so the match below cannot
 * drift from the URL panels use.
 */
const HENRY_PROXY_URL = 'https://henry-proxy.henryai.workers.dev';

let installed = false;

/** Installs the global fetch shim. Idempotent. */
export function installProxyShim(): void {
  if (installed || typeof window === 'undefined' || !window.fetch) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);
  const proxyHostMatch = new URL(HENRY_PROXY_URL).host;

  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Step 1 — figure out the URL of the request
    let url: string;
    try {
      url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    } catch {
      return originalFetch(input, init);
    }

    // Step 2 — only intercept proxy chat completions
    if (!url.includes(proxyHostMatch) || !url.includes('/v1/chat')) {
      return originalFetch(input, init);
    }

    // Step 3 — parse the body. The panel's `model` is deliberately ignored:
    // the engine and model are the user's configured ones, so no panel can
    // route a call to a model the user never chose. `stream` is ignored too —
    // the reply comes back whole, so a panel cannot reach the hosted proxy by
    // asking to stream.
    let body: {
      messages?: HenryAIMessage[];
      max_tokens?: number;
      temperature?: number;
    } = {};
    try {
      const raw = init?.body;
      if (typeof raw === 'string') body = JSON.parse(raw);
    } catch { /* malformed body — fall through to error response */ }

    // Step 4 — answer from the engine the user configured
    try {
      const reply = await callHenryAI({
        messages: body.messages ?? [],
        maxTokens: body.max_tokens ?? 500,
        temperature: body.temperature ?? 0.7,
        signal: init?.signal ?? undefined,
      });

      // Mimic the OpenAI-style response shape every panel expects
      const fake = {
        id: `henry-shim-${Date.now()}`,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply ?? '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        // Marker so the chat dashboards can attribute the call correctly
        _henry_routed_via: 'shim',
      };
      return new Response(JSON.stringify(fake), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      const userMsg = e instanceof NoBackendAvailableError
        ? e.userFacingMessage
        : (e instanceof Error ? e.message : 'Henry could not reach an AI backend.');

      // Return the friendly message in the same shape panels parse, so they
      // render it gracefully. No 4xx/5xx — that would trigger error-only paths
      // and the user wouldn't see the helpful text.
      const fake = {
        id: `henry-shim-error-${Date.now()}`,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: userMsg },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        _henry_routed_via: 'shim-error',
      };
      return new Response(JSON.stringify(fake), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };
}

/** Returns true if the shim is currently installed. Useful for diagnostics. */
export function isProxyShimInstalled(): boolean {
  return installed;
}
