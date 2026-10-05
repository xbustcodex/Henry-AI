/**
 * One authoritative classification of a provider, shared by every caller.
 *
 * Four subsystems used to decide "is this provider a normal HTTP API-key
 * provider, or something Henry reaches another way?" independently, and they
 * disagreed:
 *
 *   - the Routine scheduler  (electron/agent/scheduler.ts)
 *   - the background broker  (electron/ipc/taskBroker.ts)
 *   - the model picker       (src/components/settings/SettingsView.tsx)
 *   - provider metadata      (src/providers/models.ts, `local: true`)
 * Each wrote its own check, all of them reduced to "is the id literally
 * `ollama`". OpenCode-backed providers therefore looked key-required to the
 * scheduler even though a missing Henry-side key cannot make their call fail,
 * so a Routine on an OpenCode model failed at the gate before a single model
 * call was made. A fifth caller now lives here too.
 *
 * The two questions are deliberately separate:
 *
 *   isOpencodeProvider()  — reached through the local opencode CLI, so the
 *                           engine is `opencode`, not an HTTP provider.
 *   requiresApiKey()      — whether a missing `api_key` must block the call.
 *                           Ollama and OpenCode both answer false, and `false`
 *                           means ONE thing only: "a missing Henry-stored key is
 *                           not this provider's problem". It does NOT mean the
 *                           provider is free, and nothing may read it as a
 *                           price claim. Ollama is free because it is a local
 *                           HTTP server on the user's own machine; OpenCode is
 *                           free of a Henry-side key because it authenticates
 *                           inside its own CLI (OPENCODE_API_KEY in the child
 *                           environment, injected by the OpenCode runtime
 *                           adapter) against a remote service that bills the
 *                           user's own account.
 *
 * COST POLICY (owner-ruled, enforced here):
 *
 *   {@link isOllamaProvider} is true for Ollama and NOTHING else. Ollama is
 *   Henry's only free AI path, and that is the only question this module
 *   answers about money. Every other provider — opencode, OpenCode Zen, the
 *   models a Prime Pi install can reach, every cloud API — needs the user's own
 *   account, credential, subscription or credits. Runtime discovery is
 *   automatic and credential-free; using the models a discovered runtime can
 *   reach is a separate, user-selected configuration step. A model whose name
 *   contains "free" is a name, not a price.
 *
 * This module is deliberately dependency-free so the renderer can import it.
 */

/** Henry provider id for the opencode CLI as a whole (any group it can reach). */
export const OPENCODE_PROVIDER_ID = 'opencode';

/**
 * Henry provider id for opencode's own hosted "Zen" catalogue. It is a distinct
 * provider id because it is configured with its own credential (OPENCODE_API_KEY)
 * even though both share one local engine.
 */
export const OPENCODE_ZEN_PROVIDER_ID = 'opencode-zen';

/** Every provider id Henry reaches through the opencode CLI. */
export const OPENCODE_PROVIDER_IDS: readonly string[] = [
  OPENCODE_PROVIDER_ID,
  OPENCODE_ZEN_PROVIDER_ID,
];

/** Ollama runs on the user's own machine, so it is a provider id like any other. */
export const OLLAMA_PROVIDER_ID = 'ollama';

function normalise(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Reduce a display name to its provider identity.
 *
 * Saved rows carry a qualified display name — "OpenCode (CLI)", "Ollama
 * (Local)" — so matching a name verbatim would never match, which is why the
 * old inline ollama check only ever worked through the id. The parenthetical
 * is a qualifier, not part of the identity, and is dropped here; matching stays
 * exact afterwards so a future "OpenRouter Enterprise" is not captured.
 */
function normaliseName(value: string | null | undefined): string {
  return normalise(value).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Matches on id first. The display name is only a fallback for a row whose id
 * is missing or blank.
 */
export function isOpencodeProvider(
  id: string | null | undefined,
  name?: string | null,
): boolean {
  if (OPENCODE_PROVIDER_IDS.includes(normalise(id))) return true;
  const nameLower = normaliseName(name);
  return nameLower === OPENCODE_PROVIDER_ID || nameLower === OPENCODE_ZEN_PROVIDER_ID;
}

/**
 * Ollama runs a local HTTP server on the user's own machine and has no account
 * of any kind — so it is also Henry's ONLY cost-free AI path. Every caller that
 * has to say whether something is free asks here.
 */
export function isOllamaProvider(
  id: string | null | undefined,
  name?: string | null,
): boolean {
  return normalise(id) === OLLAMA_PROVIDER_ID || normaliseName(name) === OLLAMA_PROVIDER_ID;
}

/**
 * Is this a provider that authenticates as an ordinary HTTP API-key provider?
 *
 * `false` means a missing `api_key` must NOT block the call. Use this — not an
 * inline id check — anywhere a provider is about to be executed.
 */
export function requiresApiKey(provider: {
  id?: string | null;
  name?: string | null;
  api_key?: string | null;
  apiKey?: string | null;
}): boolean {
  if (isOllamaProvider(provider.id, provider.name)) return false;
  if (isOpencodeProvider(provider.id, provider.name)) return false;
  const key = provider.api_key ?? provider.apiKey ?? '';
  return key === '';
}

/**
 * Which Henry provider id a discovered opencode model belongs to.
 *
 * Discovery reports each model with the group it was listed under. Zen is a
 * distinct provider to the user — it has its own key, its own catalogue and its
 * own entry in the provider panel — so it must keep its own id all the way
 * through to persistence. Collapsing it to plain `opencode` is what made Zen
 * models undifferentiable from the rest of the catalogue.
 */
export function opencodeProviderIdForModel(model: {
  isZen: boolean;
  group?: string | null;
}): string {
  // Segment match, not substring: `opencode-zen` and a hypothetical `zen` both
  // qualify, but a future group like `zenith` must not be captured by accident.
  if (model.isZen || normalise(model.group).split(/[._-]/).includes('zen')) {
    return OPENCODE_ZEN_PROVIDER_ID;
  }
  return OPENCODE_PROVIDER_ID;
}