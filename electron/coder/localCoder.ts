/**
 * Coder Engine — free local fallback via Ollama (qwen2.5-coder).
 *
 * Used when the Claude Code CLI is missing/offline or the user picks the
 * "Local" coder in settings. Reuses the same Ollama HTTP endpoints the
 * existing ollama:* IPC handlers hit (/api/version, /api/tags, /api/chat)
 * and emits the same normalized CoderStreamEvents as the Claude Code runner,
 * so the renderer treats both engines identically.
 *
 * The local coder is chat-only (it writes code in the reply — it does not
 * edit files on disk), which is exactly what a free offline fallback should
 * be: useful and safe.
 */

import type { CoderStreamEvent } from './streamJson';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const PREFERRED_LOCAL_CODER_MODEL = 'qwen2.5-coder:7b';
export const LOCAL_CODER_PULL_HINT = `run: ollama pull ${PREFERRED_LOCAL_CODER_MODEL}`;

// ── Status / model pick ───────────────────────────────────────────────────

export interface LocalCoderStatus {
  ollamaRunning: boolean;
  /** Best installed coder model tag, or null if none is installed. */
  model: string | null;
  /** Actionable next step when model is null. */
  hint?: string;
}

/**
 * Choose the best installed coder tag: exact qwen2.5-coder:7b first, then any
 * other qwen2.5-coder tag, then any qwen*-coder tag (e.g. qwen3-coder:30b) so
 * an already-installed newer coder model isn't ignored.
 */
export function pickLocalCoderModel(installed: string[]): string | null {
  if (installed.includes(PREFERRED_LOCAL_CODER_MODEL)) return PREFERRED_LOCAL_CODER_MODEL;
  const qwen25 = installed.find((n) => n.startsWith('qwen2.5-coder'));
  if (qwen25) return qwen25;
  const anyQwenCoder = installed.find((n) => /^qwen[\w.]*-coder/i.test(n));
  return anyQwenCoder ?? null;
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: init?.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness + model availability for the local coder. Never throws. */
export async function getLocalCoderStatus(baseUrl?: string): Promise<LocalCoderStatus> {
  const base = (baseUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  try {
    const ping = await fetchWithTimeout(`${base}/api/version`, 2_500);
    if (!ping.ok) {
      return { ollamaRunning: false, model: null, hint: 'Ollama responded with an error — restart it.' };
    }
  } catch {
    return {
      ollamaRunning: false,
      model: null,
      hint: 'Ollama is not running — start it (ollama serve) or install from ollama.com.',
    };
  }

  try {
    const res = await fetchWithTimeout(`${base}/api/tags`, 4_000);
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    const model = pickLocalCoderModel(names);
    return model
      ? { ollamaRunning: true, model }
      : { ollamaRunning: true, model: null, hint: LOCAL_CODER_PULL_HINT };
  } catch {
    return { ollamaRunning: true, model: null, hint: LOCAL_CODER_PULL_HINT };
  }
}

// ── Run ───────────────────────────────────────────────────────────────────

function buildLocalCoderSystemPrompt(cwd?: string): string {
  return [
    "You are Henry's local coder engine (free, offline). You write production-grade code and debug existing code.",
    'Priorities: be correct, be minimal (smallest diff that solves the problem), be specific (cite files/symbols), be honest when unsure.',
    'Output style: lead with the answer, use fenced code blocks with language tags, group multi-file changes by file path, no filler.',
    'You cannot run commands or edit files directly — give the user exact code and the exact commands to run.',
    cwd ? `Target project directory: ${cwd}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface LocalCoderRunOptions {
  prompt: string;
  model: string;
  cwd?: string;
  baseUrl?: string;
  signal: AbortSignal;
  onEvent: (event: CoderStreamEvent) => void;
}

/**
 * Stream one coding answer from the local model. Emits init → text… →
 * result (or error). Resolves when the stream finishes; cancel via signal.
 */
export async function runLocalCoder(opts: LocalCoderRunOptions): Promise<void> {
  const base = (opts.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  let terminalSent = false;
  const emit = (event: CoderStreamEvent) => {
    if (terminalSent) return;
    if (event.kind === 'result' || event.kind === 'error') terminalSent = true;
    try {
      opts.onEvent(event);
    } catch {
      /* renderer gone */
    }
  };

  try {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        messages: [
          { role: 'system', content: buildLocalCoderSystemPrompt(opts.cwd) },
          { role: 'user', content: opts.prompt },
        ],
        options: { temperature: 0.2 },
      }),
      signal: opts.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        emit({
          kind: 'error',
          message: `Model "${opts.model}" is not loaded in Ollama — ${LOCAL_CODER_PULL_HINT}`,
        });
      } else {
        emit({ kind: 'error', message: `Ollama returned an error (${response.status}).` });
      }
      return;
    }
    if (!response.body) {
      emit({ kind: 'error', message: 'Ollama returned no response body.' });
      return;
    }

    emit({ kind: 'init', sessionId: '', model: opts.model });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    const handleLine = (line: string) => {
      let data: { message?: { content?: string }; done?: boolean };
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      const piece = data.message?.content;
      if (typeof piece === 'string' && piece.length > 0) {
        fullText += piece;
        emit({ kind: 'text', text: piece });
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);

    emit({ kind: 'result', ok: true, text: fullText });
  } catch (err: unknown) {
    if (opts.signal.aborted) {
      emit({ kind: 'error', message: 'Local coder run cancelled.' });
    } else {
      emit({
        kind: 'error',
        message: `Local coder failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}
