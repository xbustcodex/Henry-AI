/**
 * Ollama `/api/chat` with optional `tools` — used by the local tool-calling agent.
 * Keeps streaming=false; does not replace the main stream path for non-tool turns.
 */

const OLLAMA_DEFAULT_HOST = 'http://localhost:11434';

export type OllamaChatMessage = {
  role: string;
  content?: string;
  tool_calls?: OllamaToolCall[];
  /** Some Ollama builds include name on tool result messages */
  name?: string;
};

export type OllamaToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type OllamaToolChatOk = {
  ok: true;
  message: OllamaChatMessage;
  raw: unknown;
};

export type OllamaToolChatErr = {
  ok: false;
  error: string;
  httpStatus?: number;
};

export type OllamaToolChatResult = OllamaToolChatOk | OllamaToolChatErr;

function buildBody(params: {
  model: string;
  messages: OllamaChatMessage[];
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    stream: false,
    keep_alive: '5m',
    options: {
      temperature: params.temperature ?? 0.7,
      num_predict: params.maxTokens ?? 4096,
    },
  };
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
  }
  return body;
}

function extractToolCalls(msg: OllamaChatMessage | undefined): OllamaToolCall[] {
  if (!msg?.tool_calls || !Array.isArray(msg.tool_calls)) return [];
  return msg.tool_calls.filter((t) => t && typeof t === 'object');
}

/**
 * Single non-streaming chat completion; returns assistant `message` including optional `tool_calls`.
 */
export async function postOllamaChatWithTools(params: {
  host?: string;
  model: string;
  messages: OllamaChatMessage[];
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<OllamaToolChatResult> {
  const base = (params.host?.trim() || OLLAMA_DEFAULT_HOST).replace(/\/$/, '');
  const model = params.model.trim();
  if (!model) {
    return { ok: false, error: 'No Ollama model specified.' };
  }

  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildBody({
          model,
          messages: params.messages,
          tools: params.tools,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
        })
      ),
      signal: params.signal,
    });

    const errText = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = errText.slice(0, 400);
      try {
        const j = JSON.parse(errText) as { error?: string };
        if (typeof j.error === 'string' && j.error) detail = j.error;
      } catch {
        /* keep text */
      }
      return {
        ok: false,
        error: `Ollama HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
        httpStatus: res.status,
      };
    }

    let data: unknown;
    try {
      data = JSON.parse(errText);
    } catch {
      return { ok: false, error: 'Ollama returned invalid JSON.' };
    }

    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'Unexpected Ollama response body.' };
    }

    const d = data as { message?: OllamaChatMessage; error?: string };
    if (typeof d.error === 'string' && d.error.trim()) {
      return { ok: false, error: d.error.trim() };
    }

    const message = d.message;
    if (!message || typeof message !== 'object') {
      return { ok: false, error: 'Ollama response missing message.' };
    }

    return { ok: true, message, raw: data };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, error: 'Request cancelled.' };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function getAssistantContent(msg: OllamaChatMessage | undefined): string {
  const c = msg?.content;
  return typeof c === 'string' ? c.trim() : '';
}

export function getNormalizedToolCalls(msg: OllamaChatMessage | undefined): Array<{
  id?: string;
  name: string;
  arguments: string;
}> {
  const out: Array<{ id?: string; name: string; arguments: string }> = [];
  for (const tc of extractToolCalls(msg)) {
    const name = tc.function?.name?.trim();
    if (!name) continue;
    const args = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '{}';
    out.push({ id: tc.id, name, arguments: args });
  }
  return out;
}

/** If the model printed a JSON tool call in plain text, extract one call (best-effort). */
export function tryParseToolCallFromText(content: string): { name: string; arguments: string } | null {
  if (!content || content.length > 50_000) return null;
  const trimmed = content.trim();

  const jsonFence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const tryParse = (s: string): { name: string; arguments: string } | null => {
    try {
      const j = JSON.parse(s) as { tool?: string; name?: string; arguments?: unknown };
      const name = (j.tool || j.name || '').trim();
      if (!name) return null;
      const argumentsStr =
        typeof j.arguments === 'string' ? j.arguments : JSON.stringify(j.arguments ?? {});
      return { name, arguments: argumentsStr };
    } catch {
      return null;
    }
  };

  if (jsonFence?.[1]) {
    const p = tryParse(jsonFence[1].trim());
    if (p) return p;
  }

  const objMatch = /\{[\s\S]*"name"\s*:\s*"([^"]+)"[\s\S]*\}/.exec(trimmed);
  if (objMatch?.[0]) {
    const p = tryParse(objMatch[0]);
    if (p) return p;
  }

  return null;
}
