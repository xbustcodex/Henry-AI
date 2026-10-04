/**
 * Agent routing — the ONE rule for "may this chat turn reach the agent tool
 * runner, and may its text reach the action interceptor?"
 *
 * Why this exists: the send path used to attach `tools: [{ name: 'henry-agent' }]`
 * whenever `agentMode` was on, and `agentMode` defaulted ON for every install. So
 * an ordinary "what's the weather" prompt on a model that cannot call tools was
 * pushed down the agent route, the model answered in tool-call syntax, and the
 * action interceptor executed it. The flag being on was never evidence that the
 * model could run tools.
 *
 * The only acceptable evidence is what the runtime reported about the SELECTED
 * model (`/api/show` capabilities, surfaced through `ollamaModels()`). A model
 * id is never evidence — `llama3.2:3b`, `qwen2.5-coder:7b` and
 * `deepseek-coder:6.7b` all look tool-shaped and only the first two are.
 */

/** What the runtime says about the selected model's ability to call tools. */
export type ToolCapability =
  /** The runtime confirmed this model can call tools. */
  | 'tool-capable'
  /** The runtime confirmed this model cannot call tools. Never route to the agent. */
  | 'not-tool-capable'
  /** Nobody has asked the runtime (cloud provider, discovery not finished, unreachable). */
  | 'unknown';

export interface AgentRoutingInput {
  /**
   * The user's persisted choice: `true`/`false` once they have used the toggle,
   * `null` when they never have. `null` is what makes the default conditional on
   * capability instead of a silent "on for everybody".
   */
  agentModePreference: boolean | null;
  /** What the runtime reported for the model this turn will actually use. */
  capability: ToolCapability;
  /** Henry's operating mode for this turn (`computer` is an explicit opt-in to
   *  operating the machine, so the text interceptor still runs there). */
  mode: string;
}

export interface AgentRouting {
  /** The effective agent-mode state for this turn (what the toggle renders). */
  agentMode: boolean;
  /** Attach `tools` to the request → main process runs the ToolRunner. */
  attachTools: boolean;
  /** Let the response text reach `interceptAndExecute`. */
  runActionInterceptor: boolean;
}

/**
 * The routing rule.
 *
 * - Default agent mode is "on for a model the runtime says can use tools, off
 *   otherwise". The old unconditional default is what put ordinary chat on the
 *   agent route; making it conditional keeps the agent available out of the box
 *   for exactly the models that can actually serve it, and stops it for the rest.
 * - A runtime-confirmed `not-tool-capable` is a hard veto: no setting, default
 *   or explicit, can put such a model on the agent route, because it cannot
 *   emit a tool call at all.
 * - `unknown` is not a veto. Cloud providers report no per-model capability, so
 *   the user's toggle stays the deciding signal there.
 * - Computer mode keeps the interceptor: it is an explicit request to operate the
 *   machine, and that mode's prompt teaches the `computer:` syntax by design.
 */
export function resolveAgentRouting(input: AgentRoutingInput): AgentRouting {
  const { agentModePreference, capability, mode } = input;
  const agentMode = agentModePreference ?? capability === 'tool-capable';
  const attachTools = agentMode && capability !== 'not-tool-capable';
  return {
    agentMode,
    attachTools,
    runActionInterceptor: attachTools || mode === 'computer',
  };
}

/**
 * The request payload, with the agent marker attached only when the route allows
 * it. A tool-less payload must not carry a `tools` key at all: the main process
 * treats "non-empty `tools`" as "run the ToolRunner", so `tools: []` would be
 * fine but a leftover key is one edit away from being wrong again.
 */
export function applyAgentRoute<T extends object>(
  params: T,
  routing: AgentRouting,
  sessionId?: string
): T & { tools?: unknown[]; sessionId?: string } {
  if (!routing.attachTools) return params as T & { tools?: unknown[]; sessionId?: string };
  return {
    ...params,
    // Agent mode: a non-empty `tools` array tells the main process to route this
    // turn through the agent ToolRunner. The real tool schemas come from the
    // main-process registry, so the marker array is sufficient.
    // `sessionId` ties the run's tool-call audit trail to this conversation.
    tools: [{ name: 'henry-agent' }],
    ...(sessionId ? { sessionId } : {}),
  };
}

/** The shape `interceptAndExecute` returns. Structural, so the caller injects it. */
export interface ActionResultLike {
  output: string;
  screenshotUrl?: string;
}

/**
 * Parse Henry's reply for computer actions and append the real results.
 *
 * The gate is the router's verdict, not a flag re-derived here: an ordinary turn
 * on a model that cannot call tools must never have its prose parsed for
 * commands. `execute` is injected so this is testable without a window, a
 * bridge, or a machine to operate.
 */
export async function applyActionResults(
  text: string,
  routing: AgentRouting,
  execute: (candidate: string) => Promise<readonly ActionResultLike[]>
): Promise<string> {
  if (!routing.runActionInterceptor || !text.trim()) return text;
  try {
    const results = await execute(text);
    if (results.length === 0) return text;
    return (
      text +
      results
        .map((r) => {
          let line = '\n\n**Execution result:** ' + r.output;
          if (r.screenshotUrl) line += '\n\n![Screenshot](' + r.screenshotUrl + ')';
          return line;
        })
        .join('')
    );
  } catch {
    // An action that failed must never cost the user the answer.
    return text;
  }
}