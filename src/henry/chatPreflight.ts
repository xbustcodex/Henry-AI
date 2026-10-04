/**
 * Chat preflight — the one decision that stands between "the user pressed send"
 * and "a message is dispatched to a provider".
 *
 * It exists as its own module, separate from the chat surface, because the rule
 * it encodes is the load-bearing one: **with no AI engine configured, Chat
 * surfaces the setup path and dispatches nothing.** Not a default provider, not
 * a default model, not the first key that happens to be on the machine.
 *
 * Every terminal outcome (`setup-required`, `provider-unavailable`,
 * `unresolved`) carries the message to show and NO `route`. A caller that only
 * dispatches on `kind === 'ready'` therefore cannot dispatch without an engine
 * the user chose.
 */

import { retiredProviderName } from '../providers/models';
import { getBackendStatus, hasUsableBackend, type BackendKind } from './backendStatus';
import {
  isProviderRoutingError,
  resolveChat,
  type ModelRoute,
  type ProviderRow,
  type RoutingErrorCode,
} from './modelRouter';

export type ChatPreflight =
  | { kind: 'ready'; route: ModelRoute }
  /** The user has a provider selected, but no AI engine at all is configured. */
  | { kind: 'setup-required'; message: string }
  /** The selected provider no longer exists. Never swapped for another one. */
  | { kind: 'provider-unavailable'; message: string }
  /** The selection cannot be resolved. `code` is the router's own verdict. */
  | { kind: 'unresolved'; code: RoutingErrorCode; message: string };

/** The setup card shown when this install has no AI backend configured. */
export function buildSetupRequiredMessage(kinds: readonly BackendKind[]): string {
  const availableOptions: string[] = [];
  if (!kinds.includes('ollama')) {
    availableOptions.push(
      '**Local Ollama (fully private, fully free)** — Install from [ollama.com](https://ollama.com/download), then pick one of the models it reports in **Settings → AI Providers**.',
    );
  }
  if (!kinds.includes('openrouter')) {
    availableOptions.push(
      '**OpenRouter (free models available)** — Get a key at [openrouter.ai/keys](https://openrouter.ai/keys), then paste it in **Settings → AI Providers**.',
    );
  }
  if (!kinds.includes('opencode-zen')) {
    availableOptions.push(
      '**OpenCode Zen** — Free Zen models run through the local opencode bridge with no key at all. Add **Settings → AI Providers → OpenCode Zen** to pick one.',
    );
  }
  if (!kinds.includes('openai')) {
    availableOptions.push('**OpenAI API key** — Add in **Settings → AI Providers → OpenAI**.');
  }
  if (!kinds.includes('anthropic')) {
    availableOptions.push('**Anthropic API key** — Add in **Settings → AI Providers → Anthropic**.');
  }
  if (!kinds.includes('google')) {
    availableOptions.push(
      '**Google Gemini API key (free tier available)** — Get one at [aistudio.google.com](https://aistudio.google.com), then paste it in **Settings → AI Providers → Google**.',
    );
  }

  return [
    '**Henry needs an AI provider to answer.**',
    '',
    availableOptions.length > 0
      ? `You have ${availableOptions.length} option${availableOptions.length === 1 ? '' : 's'}:`
      : 'No providers configured.',
    '',
    ...availableOptions.map((opt, i) => `${i + 1}. ${opt}`),
    '',
    '_Henry will not pick one of these for you. Once you choose, your selection is saved and used from then on._',
  ].join('\n');
}

/**
 * Decide whether this message may be dispatched, and to where.
 *
 * A retired selection, an unconfigured install and an unresolvable selection all
 * come back as terminal outcomes carrying the message to show — never as a
 * substituted provider and never as a filled-in default model.
 */
export function chatPreflight(input: {
  content: string;
  settings: Record<string, string>;
  providers: ProviderRow[];
}): ChatPreflight {
  const { content, settings, providers } = input;
  const selectedProviderId = (settings.companion_provider ?? '').trim();

  const retired = retiredProviderName(selectedProviderId);
  if (retired) {
    return {
      kind: 'provider-unavailable',
      message:
        `⚠️ **${retired} is no longer a supported provider.** Henry will not route to another provider in its place. ` +
        'Pick a supported provider in **Settings → AI Providers** and set it as your companion engine.',
    };
  }

  // Only when NOTHING is configured do we offer the setup card. When a backend
  // exists but no engine is selected, the router's own "pick one" message is
  // the more accurate answer, and it is what the user is really being told.
  if (!selectedProviderId && !hasUsableBackend(settings)) {
    return {
      kind: 'setup-required',
      message: buildSetupRequiredMessage(getBackendStatus(settings).kinds),
    };
  }

  try {
    return { kind: 'ready', route: resolveChat(content, settings, providers) };
  } catch (err) {
    if (isProviderRoutingError(err)) {
      return { kind: 'unresolved', code: err.code, message: `⚠️ ${err.detail}` };
    }
    throw err;
  }
}
