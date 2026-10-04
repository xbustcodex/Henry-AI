/**
 * Henry AI — Model Router
 *
 * Single source of truth for chat model selection.
 *
 * Two rules this module exists to enforce:
 *
 *  1. **No silent substitution.** Every routing decision names the provider the
 *     user actually chose. When that provider or model cannot be resolved the
 *     router throws a `ProviderRoutingError` that says exactly what is
 *     unresolved and which setting key fixes it. It never quietly hands the
 *     message to a different provider, and never picks a different model.
 *
 *  2. **The engine key the picker writes is the key the send path reads.** The
 *     model picker in Settings → Engines writes `companion_provider` /
 *     `companion_model` for the Companion engine. That pair — and only that pair
 *     — drives chat. `worker_provider` / `worker_model` belong to the Worker
 *     engine (queue, Routines, the scheduler) and must not hijack a chat tier,
 *     and `chat_fast_provider` / `chat_fast_model` are written by no surface in
 *     the app at all. Routing on either is what let a Companion selection be
 *     silently replaced by an unrelated row at send time.
 */

import { PROVIDERS } from '../providers/models';
import { isOpencodeProvider, isOllamaProvider } from '../../electron/providers/classification';
import { retiredProviderUnavailableMessage } from '../../electron/providers/retiredProviders';

export type QualityPreference = 'fast' | 'balanced' | 'quality';

export type ChatTier = 'fast' | 'balanced' | 'quality';

export type MessageTask = 'chat_fast' | 'chat_balanced' | 'chat_quality';

export interface ModelRoute {
  /** Provider id exactly as the user selected it. Never rewritten here. */
  provider: string;
  /** Model id exactly as the user selected it. Never substituted here. */
  model: string;
  apiKey: string;
  /** Which tier was chosen — drives the "why" shown to the user. */
  tier?: ChatTier;
  /** Plain-English reason the router picked this model (e.g. "Quick question → fast model"). */
  reason?: string;
}

/** The settings keys the model picker writes for the Companion (chat) engine. */
export const CHAT_PROVIDER_SETTING = 'companion_provider';
export const CHAT_MODEL_SETTING = 'companion_model';

/**
 * A provider row as it arrives from the store or the providers IPC. Rows are
 * written in camelCase by the renderer and read back in snake_case by the main
 * process, so both spellings are accepted and `models` may be a JSON string.
 * `AIProvider` satisfies this structurally.
 */
export interface ProviderRow {
  id?: string | null;
  name?: string | null;
  api_key?: string | null;
  apiKey?: string | null;
  models?: unknown;
}

// ── Routing errors ───────────────────────────────────────────────────────────

export type RoutingErrorCode =
  /** No provider is selected at all. */
  | 'provider_not_configured'
  /** A provider id Henry no longer supports is still selected. */
  | 'provider_unsupported'
  /** A supported provider is selected but no provider row exists for it. */
  | 'provider_row_missing'
  /** A provider is selected but no model is. */
  | 'model_not_configured'
  /** The selected model is not offered by the selected provider. */
  | 'model_unavailable'
  /** The provider row exists but carries no credential. */
  | 'api_key_missing';

export interface RoutingErrorDetails {
  code: RoutingErrorCode;
  /** The provider id that could not be resolved. `''` when nothing is selected. */
  providerId: string;
  /** The model id that could not be resolved. `''` when nothing is selected. */
  model: string;
  /** The settings key the user has to change. */
  settingKey: string;
  tier: ChatTier;
  /** One sentence naming the unresolved thing and what to do about it. */
  detail: string;
}

/**
 * Thrown by {@link resolveChat} when the configured engine cannot be resolved.
 *
 * It carries structured fields so a chat surface can render a precise message
 * ("provider `opencode-zen` has no row") rather than a generic failure, and it
 * is never caught and retried against another provider — there is nothing to
 * retry to.
 */
export class ProviderRoutingError extends Error {
  override readonly name = 'ProviderRoutingError';
  readonly code: RoutingErrorCode;
  readonly providerId: string;
  readonly model: string;
  readonly settingKey: string;
  readonly tier: ChatTier;
  readonly detail: string;

  constructor(details: RoutingErrorDetails) {
    super(details.detail);
    this.code = details.code;
    this.providerId = details.providerId;
    this.model = details.model;
    this.settingKey = details.settingKey;
    this.tier = details.tier;
    this.detail = details.detail;
  }
}

export function isProviderRoutingError(e: unknown): e is ProviderRoutingError {
  return e instanceof ProviderRoutingError;
}

/** True for provider ids Henry still supports. Everything else is retired. */
export function isSupportedProviderId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

// ── Task detection patterns ────────────────────────────────────────────────────

/** Patterns that always route to the quality model. */
const QUALITY_PATTERNS = [
  // Long summaries
  /\b(summarize|summarise|summary)\b.{20,}/i,
  /\blong.{0,10}(summary|overview|breakdown)/i,
  // Writing and rewriting
  /\b(write|draft|rewrite|revise|edit|compose|create)\b.{10,}(essay|report|proposal|document|email|letter|plan|outline|script|article|post|brief|memo|summary)/i,
  /\b(rewrite|reword|rephrase|improve|polish|refine)\b/i,
  // Multi-step planning
  /\b(roadmap|strategy|plan|blueprint|framework|phases?|milestones?)\b/i,
  /\bstep.by.step\b/i,
  /\bhow (do|should|would|can) (i|we|you).{5,}\?/i,
  // Business strategy
  /\b(business (plan|strategy|model|case)|go.to.market|competitive analysis|market research|swot|okr|kpi)\b/i,
  // Reasoning and analysis
  /\b(analyze|analyse|explain|compare|evaluate|assess|review|critique|break down|walk me through)\b.{10,}/i,
  /\b(pros and cons|trade.?offs?|decision|recommend|advise)\b/i,
  // Code tasks
  /```[\s\S]{50,}/,
  /\b(function|class|module|component|api|interface|schema)\b.{20,}/i,
  /\b(debug|fix|refactor|optimize|implement|build)\b.{15,}/i,
];

/** Patterns that always route to the fast model. */
const FAST_PATTERNS = [
  // Acknowledgments
  /^(ok|okay|got it|sure|yes|yeah|no|nope|thanks|thank you|cool|great|perfect|sounds good|alright|noted|yep|k|i see|interesting|right|understood|makes sense)\.?$/i,
  // Single-word / very short
  /^.{1,30}$/,
  // UI interactions
  /^(go back|next|previous|skip|cancel|stop|help|show me|open|close|toggle|switch|more|less)[\s\S]{0,20}$/i,
  // Quick questions
  /^(what('?s| is) (the |your |my )?\w+\??|who('?s| is) \w+\??|when ('?s| is) \w+\??|where ('?s| is) \w+\??)$/i,
  // Quick summaries (short request)
  /^(tldr|tl;dr|summarize this|give me the gist|brief me|what('?s| is) this about)[\s\S]{0,30}$/i,
];

/**
 * Detect task complexity from message content.
 * Returns the appropriate tier for balanced mode routing.
 */
export function detectTaskType(content: string): MessageTask {
  const trimmed = content.trim();
  const len = trimmed.length;

  // Very short messages → always fast
  if (len < 50) return 'chat_fast';

  // Check fast patterns first
  for (const p of FAST_PATTERNS) {
    if (p.test(trimmed)) return 'chat_fast';
  }

  // Check quality patterns
  for (const p of QUALITY_PATTERNS) {
    if (p.test(trimmed)) return 'chat_quality';
  }

  // Length-based classification
  if (len > 400) return 'chat_quality';
  if (len < 120) return 'chat_fast';

  return 'chat_balanced';
}

/**
 * Returns true if this message should use the deeper model.
 * Used by ChatView to decide whether to emit a presence phrase first.
 */
export function requiresQualityModel(
  content: string,
  settings: Record<string, string>,
): boolean {
  const preference = (settings.model_quality_preference || 'balanced') as QualityPreference;
  if (preference === 'fast') return false;
  if (preference === 'quality') return true;
  return detectTaskType(content) === 'chat_quality';
}

/** How the tier is decided, given the user's preference and the message. */
function pickTier(preference: QualityPreference, messageTask: MessageTask): ChatTier {
  if (preference === 'fast') return 'fast';
  if (preference === 'quality') return 'quality';
  return messageTask === 'chat_fast' ? 'fast'
    : messageTask === 'chat_quality' ? 'quality'
    : 'balanced';
}

/** Plain-English "why" surfaced under each reply. */
function pickReason(preference: QualityPreference, messageTask: MessageTask): string {
  if (preference === 'fast') return 'Fast mode (your setting)';
  if (preference === 'quality') return 'Quality mode (your setting)';
  if (messageTask === 'chat_fast') return 'Quick question → fast model';
  if (messageTask === 'chat_quality') return 'Heavier task → quality model';
  return 'Balanced default';
}

/** A provider row's model list, whether stored as an array or as a JSON string. */
function rowModels(row: ProviderRow): string[] {
  const m = row.models;
  if (Array.isArray(m)) return m.map(String);
  if (typeof m === 'string') {
    try {
      const parsed: unknown = JSON.parse(m);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch { return []; }
  }
  return [];
}

// ── Chat routing ──────────────────────────────────────────────────────────────

/**
 * Resolve which LLM provider+model to use for a chat message.
 *
 * There is exactly one source of truth — the Companion engine the model picker
 * writes — and exactly one failure mode: if it cannot be resolved, this throws
 * {@link ProviderRoutingError}. It never falls through to another provider, to a
 * default model, or to the first model in a provider's list.
 *
 * @throws {ProviderRoutingError}
 */
export function resolveChat(
  content: string,
  settings: Record<string, string>,
  providers: readonly ProviderRow[],
): ModelRoute {
  const preference = (settings.model_quality_preference || 'balanced') as QualityPreference;
  const messageTask = detectTaskType(content);
  const tier = pickTier(preference, messageTask);
  const providerId = (settings[CHAT_PROVIDER_SETTING] ?? '').trim();
  const model = (settings[CHAT_MODEL_SETTING] ?? '').trim();

  // Five call sites below need the same shape and the same "name what is
  // unresolved, name the key that fixes it" guarantee, so they all build the
  // error here and `throw` it inline — which is also what lets the compiler
  // narrow past each guard.
  const routingError = (code: RoutingErrorCode, settingKey: string, detail: string) =>
    new ProviderRoutingError({ code, providerId, model, settingKey, tier, detail });

  if (!providerId) {
    throw routingError(
      'provider_not_configured',
      CHAT_PROVIDER_SETTING,
      `No chat engine is selected. Pick a provider and model in Settings → Engines `
      + `(this sets \`${CHAT_PROVIDER_SETTING}\` / \`${CHAT_MODEL_SETTING}\`).`,
    );
  }

  // A retired provider is reported with the same sentence the main process
  // throws at the transport boundary, so the chat surface and the transport
  // never tell the user two different stories.
  //
  // Do not delete this branch as dead code. `migrateRetiredProviders` runs at
  // boot and blanks every setting whose value is a retired id, so a migrated
  // install reaches `provider_not_configured` above and never gets here. This
  // branch is the window *before* that migration has run on the machine — a
  // settings map still holding the old id — plus any provider retired later
  // whose id the current blanking pass has not yet seen. It is the difference
  // between "pick a provider" and "the provider you picked is gone".
  const retired = retiredProviderUnavailableMessage(providerId);
  if (retired) {
    throw routingError('provider_unsupported', CHAT_PROVIDER_SETTING, retired);
  }

  // A provider id outside the shipped registry has no adapter and no model
  // catalogue behind it. It is reported, never resolved to a substitute.
  if (!isSupportedProviderId(providerId)) {
    throw routingError(
      'provider_unsupported',
      CHAT_PROVIDER_SETTING,
      `Provider \`${providerId}\` is no longer available. Choose a supported provider `
      + `in Settings → Engines (this replaces \`${CHAT_PROVIDER_SETTING}\`).`,
    );
  }

  const row = providers.find((p) => p?.id === providerId);
  if (!row) {
    throw routingError(
      'provider_row_missing',
      CHAT_PROVIDER_SETTING,
      `Provider \`${providerId}\` is selected but has no provider record. Open `
      + `Settings → AI Providers and add \`${providerId}\`, or pick a different engine.`,
    );
  }

  if (!model) {
    throw routingError(
      'model_not_configured',
      CHAT_MODEL_SETTING,
      `No model is selected for provider \`${providerId}\`. Pick a model in `
      + `Settings → Engines (this sets \`${CHAT_MODEL_SETTING}\`).`,
    );
  }

  const offered = rowModels(row);
  if (offered.length > 0 && !offered.includes(model)) {
    throw routingError(
      'model_unavailable',
      CHAT_MODEL_SETTING,
      `Model \`${model}\` is not offered by provider \`${providerId}\` `
      + `(${offered.length} model${offered.length === 1 ? '' : 's'} available). Pick one of `
      + `them in Settings → Engines (this sets \`${CHAT_MODEL_SETTING}\`).`,
    );
  }

  const apiKey = (row.api_key ?? row.apiKey ?? '').trim();
  // Ollama and the opencode bridge read no Henry-side credential, so an empty
  // key is legitimate for them and must not be reported as a misconfiguration.
  const needsKey = !isOllamaProvider(row.id, row.name) && !isOpencodeProvider(row.id, row.name);
  if (needsKey && !apiKey) {
    throw routingError(
      'api_key_missing',
      CHAT_PROVIDER_SETTING,
      `Provider \`${providerId}\` has no API key. Add its key in Settings → AI `
      + `Providers, or pick a different engine.`,
    );
  }

  return {
    provider: providerId,
    model,
    apiKey,
    tier,
    reason: pickReason(preference, messageTask),
  };
}

/** Human-readable label for the resolved route — shown in status bar. */
export function routeLabel(route: ModelRoute): string {
  return `${route.provider} / ${modelShortName(route.model)}`;
}

/** Short display name for a model ID. */
export function modelShortName(modelId: string): string {
  if (modelId.includes('8b')) return '8B';
  if (modelId.includes('70b')) return '70B';
  if (modelId.includes('mixtral')) return 'Mixtral';
  if (modelId.includes('gemma')) return 'Gemma';
  if (modelId.includes('deepseek')) return 'DeepSeek';
  if (modelId.includes('claude-opus-4')) return 'Opus 4';
  if (modelId.includes('claude-sonnet-4')) return 'Sonnet 4';
  if (modelId.includes('claude-3-5-haiku')) return 'Haiku 3.5';
  if (modelId.includes('gpt-4o-mini')) return 'GPT-4o Mini';
  if (modelId.includes('gpt-4o')) return 'GPT-4o';
  if (modelId.includes('gemini-2')) return 'Gemini 2';
  if (modelId.includes('gemini-1.5-pro')) return 'Gemini 1.5 Pro';
  if (modelId.includes('gemini-1.5-flash')) return 'Gemini 1.5 Flash';
  return modelId.split('-').slice(-1)[0] ?? modelId;
}