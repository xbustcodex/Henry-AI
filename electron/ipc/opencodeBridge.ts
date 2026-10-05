/**
 * OpenCode bridge — a loopback, OpenAI-compatible façade in front of the
 * `opencode` CLI.
 *
 * Why this exists: opencode can reach 395 models across its own "zen" service
 * and OpenRouter, but it only speaks them through its CLI, and its built-in
 * `opencode serve` did not answer on an OpenAI-shaped route here. Henry's
 * provider layer is OpenAI-compatible, so a tiny local server that translates
 * one request into one `opencode run` and the reply back into an
 * OpenAI-shaped response lets ALL of those models be selected in the normal
 * Settings model list and used by chat, with no change to the provider code.
 *
 * It runs entirely in the background on 127.0.0.1 and is started lazily, so it
 * costs nothing when unused and is never visible to the user. A per-process
 * token is required, so only Henry itself can drive it.
 */

import * as http from 'http';
import { ipcMain } from 'electron';
import crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import { mkdirSync } from 'fs';
import {
  listOmpModels,
  probeOmp,
  ompAdapter,
  readOmpError,
  type OmpModel,
} from '../runtimes/adapters/omp';
import { CODER_WORKSPACE_DIR } from '../coder/claudeCode';

const BRIDGE_PORT = 11540;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const RUN_TIMEOUT_MS = 600_000;

let server: http.Server | null = null;
let token = '';
let modelsCache: { at: number; models: OmpModel[] } | null = null;
/**
 * In-flight run cancellations, so an aborted HTTP request stops the turn.
 *
 * The adapter owns the child process; this side only holds the abort handle it
 * was given, which is the seam between the HTTP layer and the runtime.
 */
const activeRuns = new Set<AbortController>();

export interface BridgeInfo {
  running: boolean;
  port: number;
  baseUrl: string;
  modelCount: number;
  error?: string;
}

function log(msg: string): void {
  console.log(`[OpenCodeBridge] ${msg}`);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

/** One SSE frame in the shape an OpenAI client expects. */
function sse(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
}

/**
 * Why the bridge refuses a tool-bearing request, in one sentence the user can
 * act on.
 *
 * `opencode run` accepts a single prompt and drives its OWN built-in tools; it
 * has no flag, argument or environment variable for accepting a caller's tool
 * schema (verified against `opencode run --help` on omp 1.18.31). Its JSON
 * event stream reports `tool` parts only AFTER it has already executed them,
 * named after opencode's tools (`read`, `bash`, `edit`) rather than Henry's
 * registry names. Forwarding those as OpenAI `tool_calls` would double-execute
 * work and then ask the ToolRunner to look up tools that do not exist here.
 *
 * So the bridge says no instead of quietly returning a text-only answer. The
 * silence is what made this look like a model-capability problem for weeks.
 */
export const TOOLS_UNSUPPORTED_MESSAGE =
  'The OpenCode bridge cannot execute Henry\'s tools. `opencode run` takes a single ' +
  'prompt and runs its own built-in tools; it cannot be given Henry\'s tool schema. ' +
  'For agent turns use Ollama, OpenAI or Anthropic.';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Flatten a chat message list into the single prompt the CLI accepts, keeping
 * role labels so multi-turn context and system instructions survive.
 */
export function messagesToPrompt(messages: Array<{ role?: string; content?: unknown }>): string {
  const parts: string[] = [];
  for (const m of messages ?? []) {
    if (!m) continue;
    let content = '';
    const c = m.content;
    if (typeof c === 'string') content = c;
    else if (Array.isArray(c)) {
      // OpenAI content parts: [{type:'text',text}, {type:'image_url',...}]
      content = c
        .map((p: { type?: string; text?: string }) => (typeof p?.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n');
    }
    if (!content.trim()) continue;
    const role = (m.role || 'user').toUpperCase();
    parts.push(role === 'USER' ? content : `[${role}]\n${content}`);
  }
  return parts.join('\n\n').trim();
}


interface RunOutcome { content: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }


/**
 * Run one turn through the OpenCode runtime adapter and collect the answer.
 *
 * The argument vector, the child environment, the credential injection and the
 * event parsing all live inside the adapter — this function deliberately does
 * not know that the CLI is invoked as `run --mode json --cwd <dir> -p`, or even
 * that it has a `run` subcommand. That is the whole reason the adapter exists,
 * and it is why this route (which is the one `ai:send` actually takes) cannot
 * drift from the coder-engine route: both call the same adapter method.
 *
 * `onTextPart` is called with each text part the moment the CLI writes it,
 * which is what makes `stream: true` real: the HTTP response can be written
 * while the CLI is still running instead of after it exits.
 */
async function runModel(model: string, prompt: string, onTextPart?: (text: string) => void): Promise<RunOutcome> {
  // process.cwd() is wherever the app happened to be launched; use Henry's own
  // workspace so a run never depends on the launch directory.
  try { mkdirSync(CODER_WORKSPACE_DIR, { recursive: true }); } catch { /* best effort */ }

  const controller = new AbortController();
  activeRuns.add(controller);
  const timer = setTimeout(
    () => controller.abort(),
    RUN_TIMEOUT_MS,
  );
  try {
    const outcome = await ompAdapter.run({
      prompt,
      cwd: CODER_WORKSPACE_DIR,
      model,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind === 'text') onTextPart?.(event.text);
      },
    });
    if (!outcome.ok) {
      throw new Error(
        outcome.error ?? `opencode produced no text for ${model} (exit ${outcome.exitCode}).`,
      );
    }
    return {
      content: outcome.text,
      usage: outcome.usage
        ? {
            prompt_tokens: outcome.usage.promptTokens,
            completion_tokens: outcome.usage.completionTokens,
            total_tokens: outcome.usage.totalTokens,
          }
        : undefined,
    };
  } catch (e: unknown) {
    if (controller.signal.aborted) {
      throw new Error(`opencode timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s.`);
    }
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
    activeRuns.delete(controller);
  }
}
export interface BridgeChatPlan {
  model: string;
  prompt: string;
  stream: boolean;
}

export type BridgeChatCheck =
  | { ok: true; plan: BridgeChatPlan }
  | { ok: false; status: number; error: { message: string; type: string } };

/**
 * Is this field a request for tools?
 *
 * The rule is "defined, non-null, and not an empty array", NOT "is an array".
 * A shape test would let `tools: {}`, `tools: "x"` and `tools: {"a":1}` walk
 * straight past the refusal — nothing here executes them, but the caller would
 * believe its tool definitions were honoured and would report zero tool calls
 * without ever being told the bridge cannot do them. That is exactly the silent
 * gap the refusal exists to close, so the question is what the field MEANS, not
 * what shape it happens to have.
 */
function asksForTools(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Decide whether a chat-completions request can be served, before anything is
 * spawned. Pure, so the rules — especially the tools refusal — are testable
 * without a CLI, a network or a bridge process.
 */
export function checkChatRequest(body: unknown): BridgeChatCheck {
  const b = (body ?? {}) as {
    model?: unknown;
    messages?: Array<{ role?: string; content?: unknown }>;
    stream?: unknown;
    tools?: unknown;
    /** Legacy OpenAI function-calling field; same meaning as `tools`. */
    functions?: unknown;
    function_call?: unknown;
  };

  // The refusal that turns a silent capability gap into a legible one.
  // `function_call: 'none'` is the one value that is not a request for tools —
  // it is a caller explicitly opting out — so it is allowed through.
  const legacyFunctionCall = b.function_call === 'none' ? undefined : b.function_call;
  if (asksForTools(b.tools) || asksForTools(b.functions) || asksForTools(legacyFunctionCall)) {
    return {
      ok: false,
      status: 400,
      error: { message: TOOLS_UNSUPPORTED_MESSAGE, type: 'bridge_tools_unsupported' },
    };
  }

  const model = typeof b.model === 'string' ? b.model.trim() : '';
  if (!model) {
    return {
      ok: false,
      status: 400,
      error: { message: 'model is required', type: 'invalid_request_error' },
    };
  }

  const prompt = messagesToPrompt(b.messages ?? []);
  if (!prompt) {
    return {
      ok: false,
      status: 400,
      error: { message: 'messages is required', type: 'invalid_request_error' },
    };
  }

  return { ok: true, plan: { model, prompt, stream: b.stream === true } };
}

/** One OpenAI-shaped SSE chunk, so the stream and the test agree on the wire. */
export function chatCompletionChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: usage ? [] : [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // If the caller (Henry) aborts or the connection drops, kill the spawned CLI
  // rather than leaving it running for the rest of its 10-minute timeout.
  const killOnClose = () => { for (const c of activeRuns) c.abort(); };
  res.on('close', killOnClose);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // Loopback only, plus a per-process token: nothing else on the machine can
  // drive this server.
  const peer = (req.socket.remoteAddress || '').replace('::ffff:', '');
  const auth = req.headers.authorization ?? '';
  if (peer !== '127.0.0.1' && peer !== '::1') {
    return json(res, 403, { error: { message: 'loopback only', type: 'forbidden' } });
  }
  if (auth !== `Bearer ${token}`) {
    return json(res, 401, { error: { message: 'invalid bridge token', type: 'unauthorized' } });
  }

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    const models = await listOmpModels().catch(() => [] as OmpModel[]);
    return json(res, 200, {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        owned_by: m.provider,
        created: 0,
      })),
    });
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}') as unknown;
      const check = checkChatRequest(body);
      if (!check.ok) {
        return json(res, check.status, { error: check.error });
      }
      const { model, prompt, stream } = check.plan;

      if (stream) {
        // Real streaming: each text part is written the moment the CLI emits
        // it, instead of the caller waiting for the process to exit and then
        // receiving one buffered body.
        const id = `chatcmpl-${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
          sse(res, chatCompletionChunk(id, created, model, delta, finish));
        try {
          const { usage } = await runModel(model, prompt, (text) => chunk({ content: text }));
          chunk({}, 'stop');
          if (usage) sse(res, chatCompletionChunk(id, created, model, {}, null, usage));
          sse(res, '[DONE]');
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          sse(res, { error: { message, type: 'opencode_error' } });
          sse(res, '[DONE]');
        }
        res.end();
        return;
      }

      const { content, usage } = await runModel(model, prompt);
      return json(res, 200, {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
        ],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return json(res, 500, { error: { message, type: 'opencode_error' } });
    }
  }

  return json(res, 404, { error: { message: 'not found', type: 'not_found' } });
}

export async function ensureOpencodeBridge(): Promise<BridgeInfo> {
  if (server && server.listening) {
    return {
      running: true,
      port: BRIDGE_PORT,
      baseUrl: `http://127.0.0.1:${BRIDGE_PORT}/v1`,
      modelCount: modelsCache?.models.length ?? 0,
    };
  }
  try {
    token = crypto.randomBytes(24).toString('hex');
    server = http.createServer((req, res) => {
      handle(req, res).catch((e: unknown) => {
        try { json(res, 500, { error: { message: String(e), type: 'bridge_error' } }); } catch { /* gone */ }
      });
    });
    // Loopback only — this must never be reachable from the LAN.
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(BRIDGE_PORT, '127.0.0.1', () => resolve());
    });
    server.unref?.();
    log(`listening on 127.0.0.1:${BRIDGE_PORT} (loopback, token required)`);
  } catch (e: unknown) {
    return {
      running: false,
      port: BRIDGE_PORT,
      baseUrl: `http://127.0.0.1:${BRIDGE_PORT}/v1`,
      modelCount: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const models = await listOmpModels().catch(() => [] as OmpModel[]);
  return {
    running: true,
    port: BRIDGE_PORT,
    baseUrl: `http://127.0.0.1:${BRIDGE_PORT}/v1`,
    modelCount: models.length,
  };
}

export function stopOpencodeBridge(): void {
  server?.close();
  server = null;
  modelsCache = null;
}

/** Cached model list, so the settings list does not shell out on every render. */
export async function bridgeModels(maxAgeMs = 60_000): Promise<OmpModel[]> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.at < maxAgeMs) return modelsCache.models;
  const models = await listOmpModels();
  modelsCache = { at: now, models };
  return models;
}

export function opencodeBridgeToken(): string {
  return token;
}

export function _resetBridgeForTests(): void {
  stopOpencodeBridge();
  modelsCache = null;
}

/**
 * IPC for the settings panel: which models opencode can reach, and whether the
 * bridge is up. The bridge itself is started lazily on first use so it costs
 * nothing when no opencode model is selected.
 */
export function registerOpencodeBridgeHandlers(getWindow: () => BrowserWindow | null): void {
  void getWindow; // the bridge is a plain loopback server, no window needed

  ipcMain.handle('opencode:status', async () => {
    const probe = await probeOmp();
    if (!probe.available) {
      return { available: false, version: undefined, path: undefined, error: probe.unavailableReason };
    }
    return { available: true, version: probe.version, path: probe.binaryPath, error: undefined };
  });

  ipcMain.handle('opencode:models', async () => {
    try {
      return { ok: true, models: await listOmpModels(), error: undefined };
    } catch (e: unknown) {
      return { ok: false, models: [] as OmpModel[], error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('opencode:bridgeStatus', async () => ensureOpencodeBridge());

  ipcMain.handle('opencode:test', async (_e, model: string) => {
    try {
      const { ensureOpencodeBridge: ensure } = await import('./opencodeBridge') as typeof import('./opencodeBridge');
      const bridge = await ensure();
      if (!bridge.running) return { ok: false, error: bridge.error ?? 'bridge unavailable' };
      const { opencodeBridgeToken: tok } = await import('./opencodeBridge') as typeof import('./opencodeBridge');
      const res = await fetch(`${bridge.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok()}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
          max_tokens: 32,
        }),
      });
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` };
      return { ok: true, reply: data.choices?.[0]?.message?.content ?? '' };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
