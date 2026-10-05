/**
 * Panel AI — the governed path for a panel feature that needs an answer.
 *
 * Before this module, nine features across six panels built a `fetch` to the
 * hosted Cloudflare worker by hand, with a hardcoded model, from the renderer.
 * Every one of those calls left the machine without passing provider
 * classification, the credential policy, the security and validation layer, the
 * retry/failure handling, or the cost log. A financial summary was the clearest
 * case, but the rule was not specific to finance: a panel must not be able to
 * name its own provider.
 *
 * What this module is: the thin, boring path that Henry already had. It
 * resolves the engine through the same {@link resolveConfiguredEngine} the rest
 * of the app uses, then hands the turn to `ai:send` — which means
 * `electron/ipc/ai.ts` prices it, retries it, validates it, and writes one
 * `cost_log` row under the feature's `purpose`.
 *
 * What it deliberately does NOT do:
 *   - Pick a provider. The caller's `purpose` is an accounting label, not a
 *     provider hint, and the engine is always the one the user configured.
 *   - Accept a `model` argument. A panel that could name a model could route
 *     around the user's selection, which is the defect being removed.
 *   - Fall back. If the configured engine cannot answer, the caller gets the
 *     error and shows its own message. There is no second provider to try.
 *
 * What replaced the proxy's behaviour: the proxy never served a model of its
 * own — `henry-proxy/README.md` documents its chat endpoint as answering
 * `503 provider_not_configured` with no hosted provider configured — and the
 * `proxyShim.ts` monkey-patch (since deleted) already intercepted every one of
 * these fetches and answered from the user's configured engine. So the
 * user-visible behaviour of these nine features was, in fact, the configured
 * engine all along; that is now the real path rather than a patch over a
 * hardcoded URL. See `PRIMETECH_INTEGRATION_LEDGER.md` for the owner decision on
 * the model the call sites used to declare.
 */

import { resolveConfiguredEngine, NoBackendAvailableError, type HenryAIMessage } from './henryAI';

/**
 * A panel feature's accounting label. Written to `cost_log.task_id` so the cost
 * dashboard can say which feature spent what.
 *
 * These are stable identifiers, not display strings — renaming one changes the
 * cost history it attributes.
 */
export type PanelAIPurpose =
  | 'today.henrys-word'
  | 'today.briefing'
  | 'today.focus-now'
  | 'today.daily-plan'
  | 'tasks.triage'
  | 'goals.coach'
  | 'weekly.review'
  | 'captures.review'
  | 'finance.pl-summary'
  | 'finance.insight';

export interface PanelAIRequest {
  messages: HenryAIMessage[];
  maxTokens: number;
  /** Stable accounting label for `cost_log`. */
  purpose: PanelAIPurpose;
  temperature?: number;
}

export interface PanelAIResult {
  content: string;
  provider: string;
  model: string;
  cost: number;
}

interface HenryApi {
  sendMessage?: (params: {
    provider: string;
    model: string;
    apiKey: string;
    apiUrl?: string;
    logPurpose?: string;
    messages: HenryAIMessage[];
    temperature?: number;
    maxTokens?: number;
  }) => Promise<{ content?: string; cost?: number } | null>;
}

function henryApi(): HenryApi | null {
  return typeof window !== 'undefined'
    ? ((window as unknown as { henryAPI?: HenryApi }).henryAPI ?? null)
    : null;
}

/**
 * Run one panel turn through the governed path.
 *
 * Throws {@link NoBackendAvailableError} when the configured engine cannot be
 * resolved — the message names the setting that fixes it, and nothing is sent.
 * Otherwise the transport's own error propagates.
 */
export async function runPanelAI(req: PanelAIRequest): Promise<PanelAIResult> {
  const api = henryApi();
  if (!api?.sendMessage) {
    throw new NoBackendAvailableError(
      'Henry could not reach its AI layer. Restart the app and try again.',
    );
  }

  // Resolved BEFORE dispatch, so an unconfigured install throws here and never
  // produces a request at all.
  const engine = await resolveConfiguredEngine(req.messages);

  const res = await api.sendMessage({
    provider: engine.provider,
    model: engine.model,
    apiKey: engine.apiKey,
    apiUrl: engine.apiUrl,
    logPurpose: req.purpose,
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
    maxTokens: req.maxTokens,
  });

  return {
    content: res?.content ?? '',
    provider: engine.provider,
    model: engine.model,
    cost: res?.cost ?? 0,
  };
}

/**
 * The user-facing sentence for a failed panel turn.
 *
 * A panel with no engine gets the setup path rather than a generic failure,
 * because "Could not reach Henry AI" is untrue there — nothing was sent.
 */
export function panelAIErrorMessage(e: unknown): string {
  if (e instanceof NoBackendAvailableError) return e.userFacingMessage;
  return e instanceof Error && e.message ? e.message : 'Could not reach Henry AI.';
}