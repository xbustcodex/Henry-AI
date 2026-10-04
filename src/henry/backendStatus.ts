/**
 * Backend Status — the ONE answer to "does Henry have an AI backend right now?"
 *
 * Four surfaces used to answer that question separately and disagree: the
 * backend notice in `App.tsx`, the brain pill in `PresenceBar`/`TitleBar`, the
 * chat preflight, and a cheap localStorage probe that lived in this file. The
 * probe read only the `henry:providers` mirror while the pill read
 * `settings.companion_provider`, so an install whose selection was persisted
 * but whose mirror had been lost rendered "No AI provider configured" directly
 * above "Local AI · moondream:latest" — two truths on one screen.
 *
 * There is now one resolver, {@link resolveProviderState}, and it is built on
 * `resolveChat` — the same function that decides where a sent message actually
 * goes. Anything the router cannot send to is not reported as configured:
 *
 *   - a selected, available Ollama model IS a backend, and needs no API key;
 *   - so is an OpenCode-backed selection, whose free models run unauthenticated;
 *   - a retired provider (Groq) is named and refused, never substituted;
 *   - a provider row on disk is NOT a selection — nothing is routed from a key
 *     the user never chose;
 *   - a license key is not a backend: no hosted AI is enabled anywhere in Henry.
 *
 * The banner, the pill, the chat preflight and {@link hasUsableBackend} all read
 * this one verdict, so they cannot contradict each other or the wire.
 */

import {
  OPENCODE_PROVIDER_ID,
  OPENCODE_PROVIDER_IDS,
  OPENCODE_ZEN_PROVIDER_ID,
  isOpencodeProvider,
  isOllamaProvider,
} from '../../electron/providers/classification';
import {
  isProviderRoutingError,
  resolveChat,
  type ModelRoute,
  type ProviderRow as RoutedProviderRow,
  type RoutingErrorCode,
} from './modelRouter';
import { retiredProviderName } from '../providers/models';

export type BackendKind =
  | 'ollama'
  | 'opencode-zen'
  | 'opencode'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter';

export interface BackendStatus {
  hasAny: boolean;
  kinds: BackendKind[];
  /** Best-pick description for UI, e.g. "Your OpenAI key" or "Local Ollama" */
  primaryLabel: string;
}

/**
 * The single verdict on provider configuration.
 *
 * `ready` is the only state in which a message can be dispatched, and it names
 * the exact provider and model it will go to. Every other state names what is
 * unresolved and substitutes nothing.
 */
export type ProviderState =
  | {
      kind: 'ready';
      route: ModelRoute;
      /** Backends this profile has configured, whether selected or not. */
      kinds: BackendKind[];
      /** e.g. "Local Ollama" — the pill's headline. */
      label: string;
    }
  | { kind: 'nothing-configured'; kinds: BackendKind[] }
  | { kind: 'provider-unavailable'; providerId: string; retiredName: string; message: string }
  | {
      kind: 'unresolved';
      code: RoutingErrorCode;
      providerId: string;
      model: string;
      message: string;
      kinds: BackendKind[];
    };


/**
 * A provider row exactly as the router reads it, plus the `enabled` flag the
 * inventory uses. One shape for both: a row the router cannot match must not be
 * able to make an install look ready, and a row it CAN match must not be
 * invisible to the inventory.
 */
interface ProviderRow extends RoutedProviderRow {
  enabled?: boolean | number;
}

/**
 * Which opencode-backed provider this install is actually configured for, or
 * null. Zen stays distinct from the plain opencode group — it is its own
 * provider id with its own catalogue and its own (optional) credential.
 *
 * A row counts as configured on its own: Zen's free models run
 * unauthenticated, so demanding a key here is exactly what made a fully
 * working Zen install report "no AI provider".
 */
function opencodeProviderId(providers: ProviderRow[], settings?: Record<string, string>): string | null {
  const rows = providers.filter((p) => isOpencodeProvider(p.id, p.name));
  // A Zen row is an explicit, separately-configured provider with its own
  // catalogue, so it outranks the generic opencode row when both are present.
  const row = rows.find((p) => p.id === OPENCODE_ZEN_PROVIDER_ID && ((p.api_key || p.apiKey) ?? '').trim().length > 10)
    ?? rows.find((p) => p.id === OPENCODE_ZEN_PROVIDER_ID && p.enabled !== false)
    ?? rows.find((p) => ((p.api_key || p.apiKey) ?? '').trim().length > 10)
    ?? rows.find((p) => p.enabled !== false);
  if (row) return row.id === OPENCODE_ZEN_PROVIDER_ID ? OPENCODE_ZEN_PROVIDER_ID : OPENCODE_PROVIDER_ID;
  if (settings) {
    const selected = [settings.companion_provider, settings.worker_provider, settings.chat_fast_provider];
    const id = OPENCODE_PROVIDER_IDS.find((c) => selected.includes(c));
    if (id) return id;
  }
  return null;
}


function readProviders(): ProviderRow[] {
  try {
    const raw = localStorage.getItem('henry:providers');
    if (raw) return JSON.parse(raw) as ProviderRow[];
  } catch { /* ignore */ }
  return [];
}

function readSettings(): Record<string, string> {
  try {
    const raw = localStorage.getItem('henry:settings');
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch { /* ignore */ }
  return {};
}

function hasKey(providers: ProviderRow[], id: string): boolean {
  const p = providers.find((x) => x.id === id);
  const key = (p?.api_key || p?.apiKey || '').trim();
  return key.length > 10;
}

function ollamaConfigured(providers: ProviderRow[], settings?: Record<string, string>): boolean {
  // We can't reach the daemon synchronously — but if the user has Ollama
  // marked enabled in providers, that's a good-enough hint for the UI. The
  // async resolver will do the actual liveness check at call time.
  const providerEnabled = providers.some((p) => p.id === 'ollama' && p.enabled);
  const settingsConfigured = settings
    ? (settings.companion_provider === 'ollama' || settings.worker_provider === 'ollama')
    : false;
  return providerEnabled || settingsConfigured;
}


/**
 * Every backend this profile has CONFIGURED, selected or not.
 *
 * An inventory, not a verdict: it feeds the "you already have these" copy in
 * the setup card. Whether any of them can actually answer is
 * {@link resolveProviderState}'s question alone.
 */
export function configuredBackendKinds(
  settings?: Record<string, string>,
  providers?: readonly RoutedProviderRow[],
): BackendKind[] {
  const rows: ProviderRow[] = providers ? [...providers] : readProviders();
  const s = settings ?? readSettings();
  const kinds: BackendKind[] = [];

  if (ollamaConfigured(rows, s)) kinds.push('ollama');

  // opencode / OpenCode Zen reach a real model through the local opencode
  // bridge and need no Henry-side key — the free Zen models run
  // unauthenticated.
  const opencode = opencodeProviderId(rows, s);
  if (opencode === OPENCODE_ZEN_PROVIDER_ID) kinds.push('opencode-zen');
  else if (opencode === OPENCODE_PROVIDER_ID) kinds.push('opencode');

  if (hasKey(rows, 'openai'))      kinds.push('openai');
  if (hasKey(rows, 'anthropic'))   kinds.push('anthropic');
  if (hasKey(rows, 'google'))      kinds.push('google');
  if (hasKey(rows, 'openrouter'))  kinds.push('openrouter');
  // No license kind and no relay kind: no hosted AI backend is enabled in
  // Henry, so neither can make an install look ready.
  return kinds;
}


const LABEL_BY_KIND: Record<BackendKind, string> = {
  ollama:         'Local Ollama',
  'opencode-zen': 'OpenCode Zen',
  opencode:       'OpenCode',
  openai:         'Your OpenAI key',
  anthropic:      'Your Anthropic key',
  google:         'Your Google key',
  openrouter:     'Your OpenRouter key',
};

/** The pill headline for a provider id, e.g. "Local Ollama" / "Your OpenAI key". */
export function backendLabelFor(providerId: string): string {
  if (isOllamaProvider(providerId)) return LABEL_BY_KIND.ollama;
  if (isOpencodeProvider(providerId)) {
    return providerId === OPENCODE_ZEN_PROVIDER_ID
      ? LABEL_BY_KIND['opencode-zen']
      : LABEL_BY_KIND.opencode;
  }
  return Object.prototype.hasOwnProperty.call(LABEL_BY_KIND, providerId)
    ? LABEL_BY_KIND[providerId as BackendKind]
    : providerId;
}


/**
 * The one provider-configuration verdict every surface renders from.
 *
 * Defaults read the same localStorage mirrors the rest of the renderer uses, so
 * a caller with no live store state still gets a real answer. Callers that DO
 * have live state (the app shell, Chat) pass it in — that is what keeps the
 * banner, the pill and the wire from telling different stories.
 */
export function resolveProviderState(input: {
  content?: string;
  settings?: Record<string, string>;
  providers?: readonly RoutedProviderRow[];
} = {}): ProviderState {
  const settings = input.settings ?? readSettings();
  const providers: readonly ProviderRow[] = input.providers ?? readProviders();
  const kinds = configuredBackendKinds(settings, providers);

  const providerId = (settings.companion_provider ?? '').trim();
  const model = (settings.companion_model ?? '').trim();

  // A retired id is refused by name. It is never routed, never swapped for a
  // live provider, and never counted as configured.
  const retiredName = retiredProviderName(providerId);
  if (retiredName) {
    return {
      kind: 'provider-unavailable',
      providerId,
      retiredName,
      message:
        `⚠️ **${retiredName} is no longer a supported provider.** Henry will not route to another provider in its place. `
        + 'Pick a supported provider in **Settings → AI Providers** and set it as your companion engine.',
    };
  }

  // Nothing selected and nothing on disk: this install genuinely has no AI. A
  // provider row that exists WITHOUT a selection is not this state — there the
  // router's own "pick an engine" message is the accurate answer.
  if (!providerId && kinds.length === 0) {
    return { kind: 'nothing-configured', kinds };
  }

  try {
    const route = resolveChat(input.content ?? '', settings, providers);
    return { kind: 'ready', route, kinds, label: backendLabelFor(route.provider) };
  } catch (err) {
    if (isProviderRoutingError(err)) {
      return {
        kind: 'unresolved',
        code: err.code,
        providerId: err.providerId,
        model: err.model,
        message: `⚠ ${err.detail}`,
        kinds,
      };
    }
    throw err;
  }
}


export function getBackendStatus(settings?: Record<string, string>): BackendStatus {
  const state = resolveProviderState({ settings });
  const kinds = 'kinds' in state ? state.kinds : configuredBackendKinds(settings);
  return {
    hasAny: state.kind === 'ready',
    kinds,
    primaryLabel: state.kind === 'ready' ? state.label : 'No AI provider',
  };
}

/**
 * Convenience: true when Henry has an AI backend the user actually configured
 * AND the router can send to it — the same verdict the banner, the status pill
 * and the chat preflight render.
 *
 * False when they have nothing — the caller should show the setup path
 * instead of attempting a chat call that will only fail. A license key does
 * not flip this: nothing in Henry serves hosted AI today.
 */
export function hasUsableBackend(settings?: Record<string, string>): boolean {
  return resolveProviderState({ settings }).kind === 'ready';
}
