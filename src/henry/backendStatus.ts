/**
 * Backend Status — synchronous answer to "does Henry have an AI backend right now?"
 *
 * The async `resolveBackend()` in henryAI.ts is the authoritative router, but
 * UI panels often need a fast synchronous answer ("show or hide this AI button
 * on first render"). This module reads localStorage + cached provider state
 * for a best-effort answer that's right 99% of the time.
 *
 * COST PROTECTION: This module never pretends the Henry proxy is available
 * without a license key. Free users see "needs setup" — never a free ride.
 */

import {
  OPENCODE_PROVIDER_ID,
  OPENCODE_PROVIDER_IDS,
  OPENCODE_ZEN_PROVIDER_ID,
  isOpencodeProvider,
} from '../../electron/providers/classification';

export type BackendKind =
  | 'ollama'
  | 'opencode-zen'
  | 'opencode'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'relay'
  | 'license';

export interface BackendStatus {
  hasAny: boolean;
  kinds: BackendKind[];
  /** Best-pick description for UI, e.g. "Your OpenAI key" or "Local Ollama" */
  primaryLabel: string;
  /** True if the only path is the paid proxy (license-gated) */
  proxyOnly: boolean;
}

interface ProviderRow {
  id: string;
  name?: string;
  api_key?: string;
  apiKey?: string;
  enabled?: boolean;
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

function hasLicense(): boolean {
  try { return ((localStorage.getItem('henry:license_key') || '').trim()).length > 0; }
  catch { return false; }
}

/**
 * Returns the best-known backend status. Cheap, synchronous, safe to call on every render.
 */
/** The hosted relay is optional and off by default. */
function relayConfigured(settings?: Record<string, string>): boolean {
  if (settings) return !!(settings['relay_base_url'] || '').trim();
  try {
    return !!(localStorage.getItem('henry:relay_base_url') || '').trim();
  } catch {
    return false;
  }
}

export function getBackendStatus(settings?: Record<string, string>): BackendStatus {
  const providers = readProviders();
  const kinds: BackendKind[] = [];

  if (ollamaConfigured(providers, settings))   kinds.push('ollama');

  // opencode / OpenCode Zen reach a real model through the local opencode
  // bridge and need no Henry-side key — the free Zen models run
  // unauthenticated. Not counting them here is what made a fully configured
  // Zen install render the "no AI provider" setup card instead of answering.
  const opencode = opencodeProviderId(providers, settings);
  if (opencode === OPENCODE_ZEN_PROVIDER_ID) kinds.push('opencode-zen');
  else if (opencode === OPENCODE_PROVIDER_ID) kinds.push('opencode');

  if (hasKey(providers, 'openai'))      kinds.push('openai');
  if (hasKey(providers, 'anthropic'))   kinds.push('anthropic');
  if (hasKey(providers, 'google'))      kinds.push('google');
  if (hasKey(providers, 'openrouter'))  kinds.push('openrouter');
  // The relay is only a usable backend once a URL is actually configured —
  // it must never make Henry look "ready" out of the box.
  if (relayConfigured(settings))          kinds.push('relay');
  if (hasLicense())                     kinds.push('license');

  const labelMap: Record<BackendKind, string> = {
    ollama:     'Local Ollama',
    'opencode-zen': 'OpenCode Zen',
    opencode:   'OpenCode',
    openai:     'Your OpenAI key',
    anthropic:  'Your Anthropic key',
    google:     'Your Google key',
    openrouter: 'Your OpenRouter key',
    relay:      'Your hosted relay',
    license:    'Henry license',
  };

  const primary = kinds[0];
  return {
    hasAny: kinds.length > 0,
    kinds,
    primaryLabel: primary ? labelMap[primary] : 'No AI provider',
    proxyOnly: kinds.length === 1 && kinds[0] === 'license',
  };
}

/**
 * Convenience: true if Henry can answer chat right now without paying anyone's bill.
 *
 * Returns true when the user has their own key OR Ollama OR a license. False
 * when they have nothing — caller should show a setup card instead of attempting
 * a chat call that will only fail.
 */
export function hasUsableBackend(settings?: Record<string, string>): boolean {
  return getBackendStatus(settings).hasAny;
}
