/**
 * Henry Proxy Shim — single-file global cost protection.
 *
 * What it does:
 *   Monkey-patches window.fetch on app start. Any fetch to the Henry Cloud
 *   Proxy is intercepted and re-routed through `callHenryAI()`, which only
 *   uses the real proxy when the user has a license key. Free users get
 *   transparently served by their OWN Groq key, OR Ollama, OR (if neither
 *   exists) a friendly error message that points them at setup.
 *
 * Why a shim instead of refactoring every panel:
 *   ~15 panels each call the proxy directly (e.g. JournalPanel reflections,
 *   TodayPanel "Henry's word", goal nudges, weekly review summaries, etc.).
 *   Refactoring all of them is risky and expands the diff. A single shim
 *   gives exhaustive coverage with one source of truth.
 *
 * What it does NOT touch:
 *   - Streaming proxy calls (ChatView's main chat loop) — those have their
 *     own license gate inside ChatView. The shim only intercepts non-stream
 *     POSTs because that's what every panel uses.
 *   - Direct API calls to Groq / OpenAI / Anthropic / Ollama — those go
 *     straight through to the real provider with the user's own key.
 *
 * How to use:
 *   Call `installProxyShim()` once in main.tsx, before React renders.
 */

import { canUseHenryProxy, HENRY_PROXY_URL } from './proxyUsage';
import { callHenryAI, NoBackendAvailableError, type HenryAIMessage } from './henryAI';

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

    // Step 3 — if user has a valid license, let the real proxy serve them
    if (canUseHenryProxy()) {
      return originalFetch(input, init);
    }

    // Step 4 — parse the body and re-route through callHenryAI
    let body: {
      model?: string;
      messages?: HenryAIMessage[];
      max_tokens?: number;
      temperature?: number;
      stream?: boolean;
    } = {};
    try {
      const raw = init?.body;
      if (typeof raw === 'string') body = JSON.parse(raw);
    } catch { /* malformed body — fall through to error response */ }

    // Streaming proxy calls: don't intercept. ChatView is the only stream
    // caller and it has its own license gate that already handles this.
    if (body.stream === true) return originalFetch(input, init);

    // Step 5 — route through the smart resolver
    try {
      const reply = await callHenryAI({
        messages: body.messages ?? [],
        maxTokens: body.max_tokens ?? 500,
        temperature: body.temperature ?? 0.7,
        preferredModel: body.model,
        signal: init?.signal ?? undefined,
      });

      // Mimic the Groq/OpenAI-style response shape every panel expects
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
