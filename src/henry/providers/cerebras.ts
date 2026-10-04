/**
 * Cerebras provider — OpenAI-compatible client used as a silent fallback
 * when Groq returns 429. Cerebras hosts Qwen Coder and Llama at very high
 * throughput, and their free tier absorbs Groq's rate-limit spikes.
 *
 * API docs: https://inference-docs.cerebras.ai/
 */

const CEREBRAS_BASE = 'https://api.cerebras.ai/v1';

export interface CerebrasMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CerebrasChatOptions {
  apiKey: string;
  model: string;
  messages: CerebrasMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export const CEREBRAS_MODEL_MAP: Record<string, string> = {
  'qwen-2.5-coder-32b': 'qwen-2.5-coder-32b',
  'llama-3.3-70b-versatile': 'llama3.3-70b',
  'llama-3.1-8b-instant': 'llama3.1-8b',
};

function mapModel(groqModelId: string): string {
  return CEREBRAS_MODEL_MAP[groqModelId] || groqModelId;
}

export async function cerebrasChat(opts: CerebrasChatOptions): Promise<{
  ok: boolean; text: string; error?: string; status?: number;
}> {
  if (!opts.apiKey) return { ok: false, text: '', error: 'No Cerebras API key configured' };
  try {
    const res = await fetch(`${CEREBRAS_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: mapModel(opts.model),
        messages: opts.messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1024,
        stream: false,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, text: '', status: res.status, error: `Cerebras ${res.status}: ${body.slice(0, 200)}` };
    }
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { ok: true, text: json?.choices?.[0]?.message?.content || '' };
  } catch (e) {
    return { ok: false, text: '', error: e instanceof Error ? e.message : String(e) };
  }
}

export async function tryCerebrasFallback(args: {
  cerebrasApiKey?: string;
  model: string;
  messages: CerebrasMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; text: string; error?: string } | null> {
  if (!args.cerebrasApiKey || args.cerebrasApiKey.length < 10) return null;
  return cerebrasChat({
    apiKey: args.cerebrasApiKey,
    model: args.model,
    messages: args.messages,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    signal: args.signal,
  });
}

export function isGroqRateLimit(errOrStatus: unknown): boolean {
  if (typeof errOrStatus === 'number') return errOrStatus === 429;
  if (typeof errOrStatus === 'string') return /\b429\b|rate.?limit|too many requests/i.test(errOrStatus);
  if (errOrStatus && typeof errOrStatus === 'object') {
    const e = errOrStatus as { status?: number; message?: string };
    if (e.status === 429) return true;
    if (e.message && /\b429\b|rate.?limit|too many requests/i.test(e.message)) return true;
  }
  return false;
}
