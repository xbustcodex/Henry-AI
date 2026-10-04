/**
 * The selected model's tool capability, read from the one authoritative source
 * that already exists: the discovered-model catalogue (`ollamaModels()` →
 * `/api/tags` + `/api/show`). No second catalogue, no name matching, no
 * per-feature guessing.
 *
 * Results are cached per (base URL, model id) because a model manifest cannot
 * change while the app is running, and the chat send path needs the answer
 * synchronously on every turn.
 */

import type { LocalModelInfo } from '../../electron/ipc/ollamaCapabilities';
import { OLLAMA_PROVIDER_ID } from '../../electron/providers/classification';
import type { ToolCapability } from './agentRouting';

export type { ToolCapability };

/** The capability Ollama reports for a model that can call tools. */
const TOOLS_CAPABILITY = 'tools';

const cache = new Map<string, ToolCapability>();

/** Drop the cache — used by tests and when the base URL or model set changes. */
export function clearToolCapabilityCache(): void {
  cache.clear();
}

function cacheKey(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, '')}|${model}`;
}

/**
 * What one discovered model record says. Pure, so the mapping is testable
 * without a runtime, a fetch, or a bridge.
 *
 * A `fallback`/`assumed` capability list is NOT a runtime answer — it is the
 * last-resort list in `ollamaCapabilities.ts`, derived from the model name.
 * Routing on it would reintroduce exactly the name-based inference this exists
 * to remove, so an assumed list reads as `unknown` and the toggle decides.
 */
export function toolCapabilityFor(model: LocalModelInfo | null | undefined): ToolCapability {
  if (!model) return 'unknown';
  if (model.capabilitySource !== 'runtime') return 'unknown';
  return model.capabilities.includes(TOOLS_CAPABILITY) ? 'tool-capable' : 'not-tool-capable';
}

/** The slice of the preload bridge this module needs. */
interface CapabilityBridge {
  ollamaModels?: (
    baseUrl?: string
  ) => Promise<{ models?: LocalModelInfo[]; baseUrl?: string } | undefined>;
}

function bridge(): CapabilityBridge | undefined {
  // Narrowed to the two members used here, so this module is exercisable with
  // a two-key stub instead of the whole bridge.
  return typeof window === 'undefined' ? undefined : (window.henryAPI as CapabilityBridge);
}

/**
 * Store what discovery reported, for every model it covered. Models absent from
 * the catalogue (mid-pull, or the runtime just changed) are left uncached so the
 * next lookup asks again.
 */
export function rememberDiscoveredCapabilities(
  models: readonly LocalModelInfo[],
  baseUrl: string
): void {
  for (const model of models) cache.set(cacheKey(baseUrl, model.id), toolCapabilityFor(model));
}

/** The cached answer for one selection, or `undefined` if nobody has asked yet. */
export function cachedToolCapability(
  provider: string | null | undefined,
  model: string | null | undefined,
  baseUrl: string
): ToolCapability | undefined {
  if (!model) return undefined;
  if (provider !== OLLAMA_PROVIDER_ID) return 'unknown';
  return cache.get(cacheKey(baseUrl, model));
}

/**
 * Ask the runtime about the selected model and cache the answer.
 *
 * Providers other than Ollama have no per-model capability channel at all, so
 * they resolve to `unknown` without a call — the honest answer, not a guess.
 */
export async function loadToolCapability(
  provider: string | null | undefined,
  model: string | null | undefined,
  baseUrl: string
): Promise<ToolCapability> {
  if (!model) return 'unknown';
  if (provider !== OLLAMA_PROVIDER_ID) return 'unknown';

  const hit = cache.get(cacheKey(baseUrl, model));
  if (hit) return hit;

  const api = bridge();
  if (!api?.ollamaModels) return 'unknown';
  try {
    const catalogue = await api.ollamaModels(baseUrl);
    const models = catalogue?.models ?? [];
    rememberDiscoveredCapabilities(models, catalogue?.baseUrl || baseUrl);
    return cache.get(cacheKey(baseUrl, model)) ?? 'unknown';
  } catch {
    // An unreachable runtime is not a capability answer. Say so and let the
    // caller's own rules decide.
    return 'unknown';
  }
}