/**
 * Coder Engine — stream-json parsing (pure functions, no Electron imports).
 *
 * The Claude Code CLI in headless mode (`claude -p … --output-format
 * stream-json --verbose`) emits one JSON object per stdout line:
 *
 *   {"type":"system","subtype":"init","session_id":"…","model":"…", …}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"},
 *                                             {"type":"tool_use","name":"Bash","input":{…}}]}, …}
 *   {"type":"user","message":{…tool_result…}}          ← ignored (tool output echo)
 *   {"type":"result","subtype":"success","result":"…","session_id":"…",
 *    "total_cost_usd":0,"duration_ms":1234,"num_turns":3,"is_error":false}
 *
 * This module turns those lines into Henry's normalized CoderStreamEvent
 * shape, which both engines (Claude Code + local Ollama coder) emit so the
 * renderer only has to understand one event vocabulary. Kept pure so it can
 * be unit-tested without spawning anything.
 */

// ── Event vocabulary ──────────────────────────────────────────────────────

export type CoderStreamEvent =
  | { kind: 'init'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | {
      kind: 'result';
      ok: boolean;
      text?: string;
      sessionId?: string;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
    }
  | { kind: 'error'; message: string };

// ── Tool-activity summaries ───────────────────────────────────────────────

const SUMMARY_KEYS = [
  'file_path',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'description',
  'prompt',
] as const;

const MAX_SUMMARY = 120;

/** One-line human summary of a tool_use input ("Edit — src/foo.ts"). */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const flat = value.replace(/\s+/g, ' ').trim();
      return flat.length > MAX_SUMMARY ? flat.slice(0, MAX_SUMMARY - 1) + '…' : flat;
    }
  }
  return '';
}

// ── Line parser ───────────────────────────────────────────────────────────

/**
 * Parse ONE stdout line of Claude Code stream-json output into zero or more
 * normalized events. Unknown/malformed lines return [] — the CLI is free to
 * add event types without breaking Henry.
 */
export function parseClaudeStreamJsonLine(line: string): CoderStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];
  const evt = obj as Record<string, unknown>;
  const events: CoderStreamEvent[] = [];

  switch (evt.type) {
    case 'system': {
      if (evt.subtype === 'init' && typeof evt.session_id === 'string') {
        events.push({
          kind: 'init',
          sessionId: evt.session_id,
          model: typeof evt.model === 'string' ? evt.model : undefined,
        });
      }
      break;
    }

    case 'assistant': {
      const message = evt.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const raw of content) {
          if (!raw || typeof raw !== 'object') continue;
          const block = raw as Record<string, unknown>;
          if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            events.push({ kind: 'text', text: block.text });
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            events.push({
              kind: 'tool',
              name: block.name,
              summary: summarizeToolInput(block.input),
            });
          }
        }
      }
      break;
    }

    case 'result': {
      const ok = evt.subtype === 'success' && evt.is_error !== true;
      const text =
        typeof evt.result === 'string'
          ? evt.result
          : typeof evt.error === 'string'
            ? evt.error
            : undefined;
      events.push({
        kind: 'result',
        ok,
        text,
        sessionId: typeof evt.session_id === 'string' ? evt.session_id : undefined,
        costUsd: typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : undefined,
        durationMs: typeof evt.duration_ms === 'number' ? evt.duration_ms : undefined,
        numTurns: typeof evt.num_turns === 'number' ? evt.num_turns : undefined,
      });
      break;
    }

    // 'user' (tool_result echoes) and anything new: ignored on purpose.
    default:
      break;
  }

  return events;
}

// ── Chunk → line buffering ────────────────────────────────────────────────

export interface LineBuffer {
  /** Feed a raw stdout chunk; complete lines are dispatched to onLine. */
  push(chunk: string): void;
  /** Flush any trailing partial line (call on stream end). */
  flush(): void;
}

/**
 * NDJSON chunk splitter — stdout chunks can split a JSON object across TCP
 * reads, so buffer until a full '\n'-terminated line is available.
 */
export function createLineBuffer(onLine: (line: string) => void): LineBuffer {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    },
    flush() {
      if (buffer.trim()) onLine(buffer);
      buffer = '';
    },
  };
}
