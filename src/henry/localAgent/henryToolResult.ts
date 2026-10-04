/**
 * Normalized tool execution result for the local agent — single shape for model + logs.
 */
export type HenryToolExecutionResult = {
  ok: boolean;
  tool: string;
  outputText: string;
  data?: unknown;
  error?: string;
};

export function normalizeHenryToolResult(r: HenryToolExecutionResult): HenryToolExecutionResult {
  const out: HenryToolExecutionResult = {
    ok: r.ok,
    tool: r.tool,
    outputText: r.outputText,
  };
  if (r.data !== undefined) out.data = r.data;
  if (r.error !== undefined && r.error !== '') out.error = r.error;
  if (!r.ok && out.error === undefined) out.error = 'failed';
  return out;
}
