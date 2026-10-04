/**
 * Dev-only: exercise the Ollama tool agent with fixed prompts and report tool selection / execution / grounding.
 * Never auto-runs; attach to `window` from `main.tsx` only when `import.meta.env.DEV`.
 */

import { getOllamaBaseUrl, OLLAMA_DEFAULT_MODEL } from '../ollamaConfig';
import { runOllamaLocalCheck } from '../runOllamaLocalCheck';
import type { HenryToolExecutionResult } from '../localAgent/henryToolResult';
import {
  runHenryOllamaToolAgent,
  type HenryToolAgentDevEvent,
} from '../henryTools/henryOllamaToolAgent';

const DEV_SYSTEM =
  'You are Henry, a helpful assistant on the user machine. When they ask for system info, organizing files, opening the terminal, opening a folder, or saving a note, use the provided tools. Be concise.';

export type HenryToolCheckCaseResult = {
  prompt: string;
  expectedTool: string;
  /** Model requested at least one tool (native or text fallback). */
  modelSelectedTool: boolean;
  /** First tool name chosen, if any. */
  selectedTool: string | null;
  /** At least one `executeHenryTool` ran. */
  toolExecuted: boolean;
  /** Last tool execution result from Henry, if any. */
  lastToolResult: HenryToolExecutionResult | null;
  /** Outcome of the tool turn. */
  turnKind: 'final' | 'fallback_stream' | 'blocked';
  /** Assistant text when `turnKind === 'final'`. */
  finalAnswer: string | null;
  /** Heuristic: final text does not obviously contradict `lastToolResult.ok`. */
  answerMatchesToolResult: boolean;
  matchRationale: string;
  error?: string;
};

export type HenryToolCheckReport = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  host?: string;
  model?: string;
  cases: HenryToolCheckCaseResult[];
};

const CASES: Array<{ prompt: string; expectedTool: string }> = [
  { prompt: 'show me system status', expectedTool: 'get_system_status' },
  { prompt: 'organize my desktop files', expectedTool: 'organize_files' },
  { prompt: 'open terminal', expectedTool: 'open_terminal' },
  { prompt: 'open my Documents folder', expectedTool: 'open_path' },
  { prompt: 'write a note called Test Note with content hello', expectedTool: 'write_note' },
];

function summarizeTrace(events: HenryToolAgentDevEvent[]): {
  modelSelectedTool: boolean;
  selectedTool: string | null;
  toolExecuted: boolean;
  lastToolResult: HenryToolExecutionResult | null;
} {
  let modelSelectedTool = false;
  let selectedTool: string | null = null;
  let toolExecuted = false;
  let lastToolResult: HenryToolExecutionResult | null = null;

  for (const e of events) {
    if (e.type === 'model_reply' && e.toolCallNames.length > 0) {
      modelSelectedTool = true;
      selectedTool = selectedTool ?? e.toolCallNames[0] ?? null;
    }
    if (e.type === 'tool_executed') {
      toolExecuted = true;
      lastToolResult = e.result;
      selectedTool = e.tool;
    }
  }

  return { modelSelectedTool, selectedTool, toolExecuted, lastToolResult };
}

function heuristicAnswerMatchesResult(
  finalAnswer: string | null,
  last: HenryToolExecutionResult | null,
  turnKind: HenryToolCheckCaseResult['turnKind']
): { matched: boolean; rationale: string } {
  if (turnKind !== 'final' || !finalAnswer) {
    return {
      matched: false,
      rationale: 'No final assistant text from tool path (fallback_stream/blocked or empty).',
    };
  }
  const fa = finalAnswer.toLowerCase();
  if (!last) {
    return {
      matched: true,
      rationale: 'No tool ran; judged on conversational reply only.',
    };
  }
  if (!last.ok) {
    const failureCue =
      /fail|didn'?t|did not|couldn'?t|could not|not (available|run|open|complete)|unable|error|stub|no files were moved|requires the henry desktop|skipped|not executed/i.test(
        fa
      );
    const tooPositive = /\ball set\b|\bdone\b|\bsuccessfully organized\b|\bopened your documents\b/i.test(fa);
    if (tooPositive && !failureCue) {
      return {
        matched: false,
        rationale: 'Tool reported ok:false but final answer sounds fully successful.',
      };
    }
    return {
      matched: true,
      rationale: 'Tool failed or stubbed; final answer includes caveats or matches failure.',
    };
  }

  const contradicts =
    /\b(failed to (open|save|get)|could not open|couldn'?t open (your )?(documents|terminal)|system status unavailable)\b/i.test(
      fa
    ) && !/\b(but|however|although|still|partial)\b/i.test(fa);
  if (contradicts) {
    return {
      matched: false,
      rationale: 'Tool reported ok:true but final answer claims failure for the same action.',
    };
  }

  const snippet = last.outputText.slice(0, 120).toLowerCase();
  const words = snippet.split(/\s+/).filter((w) => w.length > 4);
  const overlap = words.some((w) => fa.includes(w));
  return {
    matched: overlap || fa.length > 40,
    rationale: overlap
      ? 'Final answer overlaps tool output text (grounded).'
      : 'Lenient pass: no obvious contradiction with ok:true.',
  };
}

async function runOneCase(
  prompt: string,
  expectedTool: string,
  host: string,
  model: string
): Promise<HenryToolCheckCaseResult> {
  const events: HenryToolAgentDevEvent[] = [];
  let turnKind: HenryToolCheckCaseResult['turnKind'] = 'fallback_stream';
  let finalAnswer: string | null = null;
  let err: string | undefined;

  try {
    const turn = await runHenryOllamaToolAgent({
      conversationId: 'dev-henry-tool-check',
      systemPrompt: DEV_SYSTEM,
      history: [{ role: 'user', content: prompt }],
      model,
      apiUrl: host,
      temperature: 0.3,
      maxTokens: 2048,
      devHooks: {
        onEvent: (e) => {
          events.push(e);
        },
      },
    });

    turnKind = turn.kind;
    if (turn.kind === 'final') {
      finalAnswer = turn.assistantText;
    } else if (turn.kind === 'blocked') {
      finalAnswer = turn.assistantText;
    }

    const trace = summarizeTrace(events);
    const { matched, rationale } = heuristicAnswerMatchesResult(
      turn.kind === 'final' ? finalAnswer : null,
      trace.lastToolResult,
      turn.kind
    );

    return {
      prompt,
      expectedTool,
      modelSelectedTool: trace.modelSelectedTool,
      selectedTool: trace.selectedTool,
      toolExecuted: trace.toolExecuted,
      lastToolResult: trace.lastToolResult,
      turnKind,
      finalAnswer,
      answerMatchesToolResult: matched,
      matchRationale: rationale,
    };
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
    return {
      prompt,
      expectedTool,
      modelSelectedTool: false,
      selectedTool: null,
      toolExecuted: false,
      lastToolResult: null,
      turnKind: 'fallback_stream',
      finalAnswer: null,
      answerMatchesToolResult: false,
      matchRationale: 'Turn threw before completion.',
      error: err,
    };
  }
}

/**
 * Run all fixed tool-mode prompts and print a table to the console.
 */
export async function runHenryToolCheck(): Promise<HenryToolCheckReport> {
  if (import.meta.env.PROD) {
    console.warn('[Henry] runHenryToolCheck is disabled in production.');
    return {
      ok: false,
      skipped: true,
      reason: 'Disabled in production builds.',
      cases: [],
    };
  }

  const api = window.henryAPI;
  if (!api?.getSettings) {
    return {
      ok: false,
      skipped: true,
      reason: 'henryAPI.getSettings unavailable.',
      cases: [],
    };
  }

  let settings: Record<string, string>;
  try {
    settings = await api.getSettings();
  } catch (e) {
    return {
      ok: false,
      skipped: true,
      reason: e instanceof Error ? e.message : String(e),
      cases: [],
    };
  }

  const companion = (settings.companion_provider || '').trim();
  const host = getOllamaBaseUrl(settings);
  const model = (settings.companion_model || '').trim() || OLLAMA_DEFAULT_MODEL;

  if (companion !== 'ollama') {
    return {
      ok: false,
      skipped: true,
      reason: `Companion provider is "${companion || '(unset)'}", not ollama.`,
      host,
      model,
      cases: [],
    };
  }

  const cases: HenryToolCheckCaseResult[] = [];
  for (const c of CASES) {
    cases.push(await runOneCase(c.prompt, c.expectedTool, host, model));
  }

  const ok = cases.every((x) => !x.error);

  console.table(
    cases.map((c) => ({
      prompt: c.prompt.slice(0, 36) + (c.prompt.length > 36 ? '…' : ''),
      expected: c.expectedTool,
      picked: c.selectedTool ?? '—',
      modelPicked: c.modelSelectedTool,
      executed: c.toolExecuted,
      turn: c.turnKind,
      grounded: c.answerMatchesToolResult,
    }))
  );

  console.log('[Henry tool check] detail:', cases);

  return { ok, host, model, cases };
}

/**
 * Dev smoke bundle: Ollama ping + tool-mode scenarios (does not run in production).
 */
export async function runHenrySmokeTests(): Promise<{
  ollama: Awaited<ReturnType<typeof runOllamaLocalCheck>>;
  tools: HenryToolCheckReport;
}> {
  if (import.meta.env.PROD) {
    console.warn('[Henry] runHenrySmokeTests is disabled in production.');
    return {
      ollama: {
        ok: false,
        skipped: true,
        reason: 'Disabled in production builds.',
        provider: 'n/a',
      },
      tools: { ok: false, skipped: true, reason: 'Disabled in production builds.', cases: [] },
    };
  }

  const ollama = await runOllamaLocalCheck();
  const tools = await runHenryToolCheck();
  console.log('[Henry smoke]', { ollama, toolsSummary: { ok: tools.ok, caseCount: tools.cases?.length } });
  return { ollama, tools };
}
