import { buildHenryToolDefinitions } from './definitions';
import { executeHenryTool, type HenryToolExecutionResult } from './executor';
import {
  getAssistantContent,
  getNormalizedToolCalls,
  postOllamaChatWithTools,
  tryParseToolCallFromText,
  type OllamaChatMessage,
} from './ollamaToolChat';
import { log } from '../log';

/** Max model calls per user message (request → tool passes → final text). */
const MAX_MODEL_ROUNDS = 3;

/** Appended to system prompt for Ollama tool turns only. */
const ROUTER_SYSTEM_SUFFIX =
  '\n\n[Henry tool mode]\n' +
  '- Use at most one tool per reply when you need an action. Prefer answering from context when no tool is needed.\n' +
  '- Never claim you ran an action unless you requested a tool and will receive its JSON result next.\n' +
  '- When tool results arrive, treat `"ok": true` as success and `"ok": false` as failure — never reverse them.\n' +
  '- If no tool is needed, answer in normal conversational text.\n';

/** Injected after tool results so the next model call writes a user-grounded reply. */
const POST_TOOL_USER_NUDGE =
  'Using the tool result message(s) above (JSON with ok, tool, outputText, error), write your reply to the user. ' +
  'If ok is false, say clearly that the step did not succeed and summarize outputText/error. ' +
  'If ok is true, describe what happened accurately. Do not claim success when ok is false.';

/** On the last round (no tools payload), when tools already ran — tighten final answer. */
const FINAL_ROUND_USER_NUDGE =
  '[Final reply — no more tools.] Summarize for the user using only the conversation and tool results above. ' +
  'If any tool had ok:false, state that plainly. Never claim desktop actions succeeded unless ok was true.';

function toOllamaMessages(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>
): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [
    { role: 'system', content: systemPrompt + ROUTER_SYSTEM_SUFFIX },
  ];
  for (const m of history) {
    const role = m.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    out.push({ role, content: m.content ?? '' });
  }
  return out;
}

function devLog(payload: Record<string, unknown>) {
  log.debug('[Henry tools]', payload);
}

function serializeToolResult(r: HenryToolExecutionResult): string {
  return JSON.stringify({
    ok: r.ok,
    tool: r.tool,
    outputText: r.outputText,
    data: r.data,
    error: r.error,
  });
}

/** True if the chat response is unusable (malformed / empty in a way we cannot interpret). */
function isMalformedAssistantMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return true;
  const m = msg as { role?: unknown; content?: unknown; tool_calls?: unknown };
  const hasContent = typeof m.content === 'string' && m.content.trim().length > 0;
  const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  return !hasContent && !hasCalls;
}

export type HenryOllamaToolTurnResult =
  | { kind: 'final'; assistantText: string; toolsExecuted: number }
  | { kind: 'fallback_stream' }
  | { kind: 'blocked'; assistantText: string };

/** Dev-only instrumentation for `runHenryOllamaToolAgent` (e.g. `runHenryToolCheck`). */
export type HenryToolAgentDevEvent =
  | { type: 'model_reply'; round: number; toolCallNames: string[]; contentChars: number; fromPlainTextFallback: boolean }
  | {
      type: 'tool_executed';
      tool: string;
      ok: boolean;
      outputTextPreview: string;
      result: HenryToolExecutionResult;
    }
  | { type: 'turn_end'; kind: 'final' | 'fallback_stream' | 'blocked'; toolsExecuted: number; assistantTextChars: number };

export type HenryToolAgentDevHooks = {
  onEvent?: (e: HenryToolAgentDevEvent) => void;
};

/**
 * HenryCore tool-capable turn for local Ollama: tools + validation + execution + grounded final text.
 * `fallback_stream` → caller uses normal `streamMessage` (must not throw).
 */
export async function runHenryOllamaToolAgent(params: {
  conversationId: string;
  systemPrompt: string;
  history: Array<{ role: string; content: string }>;
  model: string;
  apiUrl: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Optional dev-only trace (console / verification harness). */
  devHooks?: HenryToolAgentDevHooks;
}): Promise<HenryOllamaToolTurnResult> {
  const dev = params.devHooks?.onEvent;
  const tools = buildHenryToolDefinitions();
  const messages = toOllamaMessages(params.systemPrompt, params.history);
  let toolsExecuted = 0;

  const finish = (out: HenryOllamaToolTurnResult): HenryOllamaToolTurnResult => {
    if (dev) {
      if (out.kind === 'final') {
        dev({
          type: 'turn_end',
          kind: 'final',
          toolsExecuted: out.toolsExecuted,
          assistantTextChars: out.assistantText.length,
        });
      } else if (out.kind === 'fallback_stream') {
        dev({ type: 'turn_end', kind: 'fallback_stream', toolsExecuted: 0, assistantTextChars: 0 });
      } else {
        dev({
          type: 'turn_end',
          kind: 'blocked',
          toolsExecuted: 0,
          assistantTextChars: out.assistantText.length,
        });
      }
    }
    return out;
  };

  for (let round = 0; round < MAX_MODEL_ROUNDS; round++) {
    const isLastRound = round === MAX_MODEL_ROUNDS - 1;
    const sendTools = !isLastRound;

    if (isLastRound && toolsExecuted > 0) {
      messages.push({ role: 'user', content: FINAL_ROUND_USER_NUDGE });
    }

    const res = await postOllamaChatWithTools({
      host: params.apiUrl,
      model: params.model,
      messages,
      tools: sendTools ? tools : undefined,
      temperature: params.temperature ?? 0.7,
      maxTokens: params.maxTokens ?? 4096,
      signal: params.signal,
    });

    if (!res.ok) {
      devLog({
        path: 'ollama_tool_chat_error',
        round,
        error: res.error,
        httpStatus: 'httpStatus' in res ? res.httpStatus : undefined,
      });
      if (round === 0) {
        return finish({ kind: 'fallback_stream' });
      }
      return finish({
        kind: 'blocked',
        assistantText:
          'Henry could not safely complete the task (Ollama error after a tool step). Check the local model and try again.',
      });
    }

    const msg = res.message;
    if (isMalformedAssistantMessage(msg)) {
      devLog({ path: 'malformed_assistant_message', round });
      return finish({ kind: 'fallback_stream' });
    }

    const content = getAssistantContent(msg);
    let calls = getNormalizedToolCalls(msg);
    let toolCallFromPlainText = false;

    if (dev) {
      dev({
        type: 'model_reply',
        round,
        toolCallNames: calls.map((c) => c.name),
        contentChars: content.length,
        fromPlainTextFallback: false,
      });
    }

    if (calls.length === 0 && content) {
      const parsed = tryParseToolCallFromText(content);
      if (parsed && sendTools) {
        calls = [{ name: parsed.name, arguments: parsed.arguments, id: 'text_fallback' }];
        toolCallFromPlainText = true;
        if (dev) {
          dev({
            type: 'model_reply',
            round,
            toolCallNames: calls.map((c) => c.name),
            contentChars: content.length,
            fromPlainTextFallback: true,
          });
        }
      } else if (parsed && !sendTools) {
        return finish({ kind: 'final', assistantText: content, toolsExecuted });
      } else {
        devLog({ path: 'final_text_no_tools', round, preview: content.slice(0, 200) });
        return finish({ kind: 'final', assistantText: content, toolsExecuted });
      }
    }

    if (calls.length === 0 && !content) {
      return finish({ kind: 'fallback_stream' });
    }

    if (calls.length > 1) {
      devLog({ path: 'tool_calls_truncated', dropped: calls.length - 1 });
      calls = calls.slice(0, 1);
    }

    if (calls.length > 0 && isLastRound) {
      return finish({
        kind: 'blocked',
        assistantText:
          'Henry could not safely complete the task (tool limit reached). Try breaking the request into smaller steps.',
      });
    }

    if (calls.length > 0) {
      if (toolCallFromPlainText) {
        messages.push({ role: 'assistant', content });
      } else {
        messages.push({
          role: 'assistant',
          content: msg.content ?? '',
          tool_calls: msg.tool_calls,
        });
      }

      for (const c of calls) {
        devLog({
          path: 'tool_execute',
          tool: c.name,
          argsPreview: (c.arguments || '').slice(0, 500),
        });
        const result = await executeHenryTool(c.name, c.arguments, {
          conversationId: params.conversationId,
        });
        toolsExecuted += 1;
        devLog({
          path: 'tool_result',
          tool: result.tool,
          ok: result.ok,
          outputPreview: result.outputText.slice(0, 500),
        });
        dev?.({
          type: 'tool_executed',
          tool: result.tool,
          ok: result.ok,
          outputTextPreview: result.outputText.slice(0, 400),
          result,
        });
        messages.push({
          role: 'tool',
          content: serializeToolResult(result),
        });
      }

      messages.push({ role: 'user', content: POST_TOOL_USER_NUDGE });
    }
  }

  return finish({
    kind: 'blocked',
    assistantText:
      'Henry could not safely complete the task (maximum tool/model rounds exceeded).',
  });
}
