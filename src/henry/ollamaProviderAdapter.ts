/**
 * Minimal Ollama provider adapter — POST /api/chat, non-streaming, normalized results.
 *
 * Tool-calling (structured `tools` on `/api/chat`) lives in `henryTools/ollamaToolChat.ts`
 * and is re-exported here for a single Ollama entry point.
 */

export { postOllamaChatWithTools } from './henryTools/ollamaToolChat';

const OLLAMA_DEFAULT_HOST = 'http://localhost:11434';

function buildChatBody(params: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
}): Record<string, unknown> {
  return {
    model: params.model,
    messages: params.messages,
    stream: false,
    keep_alive: '5m',
    options: {
      temperature: params.temperature ?? 0.7,
      num_predict: params.maxTokens ?? 4096,
    },
  };
}

export type OllamaAdapterSuccess = {
  ok: true;
  outputText: string;
  provider: 'ollama';
  model: string;
};

export type OllamaAdapterFailure = {
  ok: false;
  error: string;
  provider: 'ollama';
  model: string;
};

export type OllamaAdapterResult = OllamaAdapterSuccess | OllamaAdapterFailure;

function unreachableMessage(hostDisplay: string): string {
  return `Henry could not reach your local Ollama server at ${hostDisplay}. Make sure Ollama is running and the model is installed.`;
}

function modelMissingMessage(model: string): string {
  return `The model "${model}" is not available in Ollama. Install it with: ollama pull ${model}`;
}

/**
 * Single chat completion against local Ollama. Does not throw — inspect `ok`.
 * Primary assistant text: `response.message.content` from Ollama JSON.
 */
export async function ollamaChatAdapter(params: {
  messages: Array<{ role: string; content: string }>;
  model: string;
  /** Base URL, default http://localhost:11434 */
  host?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<OllamaAdapterResult> {
  const model = params.model.trim();
  if (!model) {
    return {
      ok: false,
      error: 'No Ollama model was specified.',
      provider: 'ollama',
      model: '',
    };
  }

  const base = (params.host?.trim() || OLLAMA_DEFAULT_HOST).replace(/\/$/, '');
  const hostDisplay = base;

  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildChatBody({
          model,
          messages: params.messages,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
        })
      ),
      signal: params.signal,
    });

    if (!res.ok) {
      if (res.status === 404) {
        return {
          ok: false,
          error: modelMissingMessage(model),
          provider: 'ollama',
          model,
        };
      }
      const errText = await res.text().catch(() => '');
      let detail = '';
      try {
        const j = JSON.parse(errText) as { error?: string };
        if (typeof j.error === 'string' && j.error) detail = j.error;
      } catch {
        /* not JSON */
      }
      const suffix = detail || (errText ? errText.slice(0, 400) : res.statusText);
      return {
        ok: false,
        error: `Ollama returned HTTP ${res.status}${suffix ? `: ${suffix}` : ''}.`,
        provider: 'ollama',
        model,
      };
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return {
        ok: false,
        error: 'Ollama returned a response that was not valid JSON.',
        provider: 'ollama',
        model,
      };
    }

    if (!data || typeof data !== 'object') {
      return {
        ok: false,
        error: 'Ollama returned an unexpected response body.',
        provider: 'ollama',
        model,
      };
    }

    const d = data as { message?: { content?: string }; error?: string };
    if (typeof d.error === 'string' && d.error.trim()) {
      return {
        ok: false,
        error: d.error.trim(),
        provider: 'ollama',
        model,
      };
    }

    const raw = d.message?.content;
    const outputText = typeof raw === 'string' ? raw.trim() : '';
    if (!outputText) {
      return {
        ok: false,
        error: `Ollama returned no assistant text for model "${model}". Run \`ollama pull ${model}\` and try again.`,
        provider: 'ollama',
        model,
      };
    }

    return {
      ok: true,
      outputText,
      provider: 'ollama',
      model,
    };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return {
        ok: false,
        error: 'The Ollama request was cancelled.',
        provider: 'ollama',
        model,
      };
    }
    return {
      ok: false,
      error: unreachableMessage(hostDisplay),
      provider: 'ollama',
      model,
    };
  }
}
