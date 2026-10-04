/**
 * What a locally-installed model can actually do — asked of the runtime, never guessed.
 *
 * THE DEFECT THIS REPLACES
 * ------------------------
 * Henry carried a hand-written model-name → capabilities table. Its failure modes
 * were all one bug wearing different clothes:
 *
 *   - a model the user installed that nobody wrote down got no capabilities;
 *   - a model the user DELETED stayed in the catalogue forever, because the table
 *     did not know Ollama had stopped holding it;
 *   - capabilities were inferred from a string, so a renamed or repointed tag
 *     silently changed what Henry thought the model could do.
 *
 * A static table cannot be correct, because the thing it describes is the user's
 * disk. The list of installed models is whatever `/api/tags` says today.
 *
 * WHAT OLLAMA ANSWERS (verified live against 0.34.4 on this machine)
 * -----------------------------------------------------------------
 *   GET  /api/tags    → every installed model: id, size, digest, details{family,
 *                       families, parameter_size, quantization_level, context_length}
 *   POST /api/show    → `capabilities[]` per model, plus `model_info`.
 *
 * `/api/show` for `moondream:latest` returns exactly `["completion","vision"]`.
 * For `llama3.2:3b` it returns `["completion","tools"]`; for `deepseek-coder:6.7b`
 * just `["completion"]`. Those three models are the whole argument for asking:
 * same family, same shape of name, three different answers.
 *
 * Why it matters: sending an image to a text-only model does not fail. Ollama
 * accepts the request, drops the image, and the model answers as though it had
 * looked. Observed live: llama3.2:3b describing a blue disc as "a square of
 * yellow". A hallucinated description is worse than a clear refusal.
 */

import { OLLAMA_PROVIDER_ID } from '../providers/classification';

/** Henry's provider id for the local Ollama runtime. Ollama is the only local
 *  chat backend Henry implements — Whisper (STT) and Piper (TTS) are not
 *  inference runtimes and are deliberately not discovered here. */
export { OLLAMA_PROVIDER_ID };

export interface OllamaShowResponse {
  capabilities?: string[];
  details?: OllamaModelDetails;
  model_info?: Record<string, unknown>;
}

export interface OllamaModelDetails {
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
  format?: string;
  context_length?: number;
}

export type OllamaFetcher = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * The capability vocabulary Ollama reports. `thinking` is included because this
 * runtime reports it (`gpt-oss:20b` → completion, tools, thinking) and dropping
 * it would lose information the user can act on.
 */
export const KNOWN_CAPABILITIES = [
  'completion',
  'tools',
  'vision',
  'insert',
  'embedding',
  'thinking',
] as const;

export type OllamaCapability = (typeof KNOWN_CAPABILITIES)[number] | (string & {});

/**
 * Where a model's capabilities came from. Rendered to the user: a capability
 * that was assumed must never look like one the runtime confirmed.
 */
export type CapabilitySource = 'runtime' | 'fallback' | 'unknown';

/** How the runtime answered when we asked what a model can do. */
export type DetailStatus = 'ok' | 'assumed' | 'missing' | 'unreachable';

/**
 * One discovered model, carrying everything needed to route it correctly.
 *
 * Deliberately a superset of what any one consumer needs: the picker shows
 * capabilities, the scheduler needs `id` + `requiresApiKey`, and the cost
 * calculator needs to know it is local (free) rather than merely cheap.
 */
export interface LocalModelInfo {
  provider: typeof OLLAMA_PROVIDER_ID;
  runtime: 'ollama';
  /** The exact id the runtime will accept in `/api/chat`. Never re-derived. */
  id: string;
  /**
   * The runtime's own name for the model. Equal to `id` today — Ollama names
   * models by tag and has nothing else to call them — but it is kept separate
   * so a future runtime that reports a friendlier name does not silently change
   * what gets persisted as an id.
   */
  name: string;
  /** Cosmetic rendering only. Never used to infer anything. */
  displayName: string;
  local: true;
  /**
   * Ollama is an unauthenticated local HTTP server: it has no accounts and reads
   * no credentials. Stated explicitly so no caller has to infer "no key needed"
   * from an empty string, and so nothing gates a local model behind a key it
   * will never need.
   */
  requiresApiKey: false;
  sizeBytes: number;
  sizeGB: string;
  digest?: string;
  modifiedAt?: string;
  family?: string;
  families?: string[];
  parameterSize?: string;
  quantization?: string;
  /** From `details.context_length` or `model_info["<arch>.context_length"]`. */
  contextLength: number | null;
  capabilities: OllamaCapability[];
  capabilitySource: CapabilitySource;
  detailStatus: DetailStatus;
  /**
   * `false` only when the runtime positively says it cannot serve this model
   * (`/api/show` → 404). `null` means we could not find out — never treat that
   * as unusable, it is the common case when a model is mid-pull.
   */
  loadable: boolean | null;
  /** Actionable, user-facing text for a degraded state. Absent when all is well. */
  warning?: string;
}

/**
 * The catalogue the renderer is handed: whatever this instance holds right now.
 *
 * Declared here rather than in `ipc/ollama.ts` so the renderer can name it
 * without importing anything that pulls in Electron.
 */
export interface OllamaModelCatalogue {
  models: LocalModelInfo[];
  baseUrl: string;
  runtime: 'ollama';
  /** Set when Ollama could not be reached — the UI renders this, never a spinner. */
  error?: string;
  /** Per-model degradation, e.g. a capability set that had to be assumed. */
  warnings?: string[];
}

export interface OllamaDiscovery {
  models: LocalModelInfo[];
  baseUrl: string;
  runtime: 'ollama';
  version?: string;
  /** Per-model degradation reasons. Non-fatal: the models are still listed. */
  warnings: string[];
}

/**
 * LAST-RESORT FALLBACK — read this before touching it.
 *
 * `capabilities` has shipped in `/api/show` since Ollama 0.3.x. If the runtime
 * answers that endpoint and omits the field, it is too old to be trusted about
 * anything else either, so these few rules buy a degraded rather than broken
 * picker. They are deliberately tiny, deliberately name-shaped (they have to
 * be — there is nothing else to go on), and every model they touch is marked
 * `capabilitySource: 'fallback'`, which the picker renders as "assumed".
 *
 * They are NOT a catalogue and MUST NOT become one. Adding an entry here is a
 * claim that a name is a capability; the discovery tests exist to make that
 * failure visible.
 */
const LEGACY_CAPABILITY_FALLBACKS: ReadonlyArray<{
  match: RegExp;
  capabilities: OllamaCapability[];
}> = [
  { match: /^(llama3\.2-vision|llava|cogv|mllama|moondream|minicpm-v)/i, capabilities: ['completion', 'vision'] },
  { match: /embed/i, capabilities: ['embedding'] },
];

export function legacyCapabilitiesFor(modelId: string): OllamaCapability[] | null {
  for (const rule of LEGACY_CAPABILITY_FALLBACKS) {
    if (rule.match.test(modelId)) return rule.capabilities;
  }
  return null;
}

/** One capability lookup per model per base URL; it cannot change at runtime. */
const cache = new Map<string, boolean>();

export function clearOllamaCapabilityCache(): void {
  cache.clear();
}

export async function ollamaSupportsVision(
  base: string,
  model: string,
  fetchImpl?: OllamaFetcher
): Promise<boolean> {
  const key = `${base}|${model}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const doFetch = (fetchImpl ?? (globalThis.fetch as unknown as OllamaFetcher));
  let supports = false;
  try {
    const res = await doFetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: timeoutSignal(6000),
    });
    if (res?.ok) {
      const data = (await res.json()) as OllamaShowResponse;
      supports = Array.isArray(data?.capabilities) && data.capabilities.includes('vision');
    }
  } catch {
    // Could not determine. Staying optimistic means Ollama's own 400 surfaces,
    // which is clearer than Henry silently pretending the model can see.
    return true;
  }
  cache.set(key, supports);
  return supports;
}

/**
 * What the model is told when it cannot see an attached image.
 *
 * It must be explicit and must forbid guessing: the failure being prevented is
 * a model confidently describing a picture it never received.
 */
export const NO_VISION_NOTE =
  '[An image is attached but this model does not support vision, so its contents cannot be shown. ' +
  'Do not describe or guess at the image; say that you cannot view it.]';

/** Build one Ollama chat message, honouring what the model can actually see. */
export function buildOllamaMessage(
  role: string,
  content: string,
  images: string[],
  canSee: boolean
): { role: string; content: string; images?: string[] } {
  if (images.length === 0) return { role, content };
  if (!canSee) return { role, content: `${content}\n${NO_VISION_NOTE}` };
  return { role, content, images };
}

// ── Discovery ───────────────────────────────────────────────────────────────

/** A hung runtime must produce a message, not an unresolved promise. */
const TAGS_TIMEOUT_MS = 8000;
/** `/api/show` reads the model manifest, which is slower than `/api/tags`. */
const SHOW_TIMEOUT_MS = 15000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  const sig = (globalThis as { AbortSignal?: { timeout?: (n: number) => AbortSignal } }).AbortSignal;
  try {
    return sig?.timeout?.(ms);
  } catch {
    return undefined;
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Cosmetic label for a model. Purely for display — nothing routes off it, and
 * `id` is what gets persisted and sent to `/api/chat`.
 *
 * A version fragment stays attached to the token it versions (`qwen2.5` →
 * "Qwen2.5"), because splitting it reads as two unrelated words: "Qwen2 5".
 */
export function displayNameFor(id: string): string {
  const [repo = id, tag] = id.split(':');
  const words: string[] = [];
  for (const part of repo.split(/[._-]+/).filter(Boolean)) {
    if (/^\d+$/.test(part) && words.length > 0) {
      words[words.length - 1] += `.${part}`;
      continue;
    }
    words.push(
      /^(gpt|llama|qwen|phi|glm|vl|ocr|oss|ai)$/i.test(part)
        ? part.toUpperCase()
        : part[0]!.toUpperCase() + part.slice(1)
    );
  }
  const base = words.join(' ') || id;
  return tag && tag !== 'latest' ? `${base} ${tag.toUpperCase()}` : base;
}

/** `model_info` keys look like `<arch>.context_length`. */
function contextLengthFrom(show: OllamaShowResponse | undefined): number | null {
  const fromDetails = show?.details?.context_length;
  if (typeof fromDetails === 'number' && fromDetails > 0) return fromDetails;
  const info = show?.model_info;
  if (info && typeof info === 'object') {
    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) return v;
    }
  }
  return null;
}

function normaliseCapabilities(raw: unknown): OllamaCapability[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const c of raw) if (typeof c === 'string' && c) seen.add(c);
  // Known capabilities first, in the documented order, then anything else the
  // runtime reported that this build has not been taught about yet.
  const ordered = KNOWN_CAPABILITIES.filter((c) => seen.has(c));
  const extra = [...seen].filter((c) => !(KNOWN_CAPABILITIES as readonly string[]).includes(c));
  return [...ordered, ...extra];
}

interface OllamaTag {
  name: string;
  model?: string;
  size?: number;
  digest?: string;
  modified_at?: string;
  details?: OllamaModelDetails;
}

/** The parts of a model record `/api/tags` gives us, whatever Henry needs. */
function baseInfoFor(tag: OllamaTag): Omit<LocalModelInfo, 'capabilities' | 'capabilitySource' | 'detailStatus' | 'loadable' | 'contextLength'> {
  const id = tag.model || tag.name;
  const details = tag.details ?? {};
  return {
    provider: OLLAMA_PROVIDER_ID,
    runtime: 'ollama',
    id,
    name: tag.name,
    displayName: displayNameFor(id),
    local: true,
    requiresApiKey: false,
    sizeBytes: tag.size ?? 0,
    sizeGB: ((tag.size ?? 0) / 1e9).toFixed(1),
    digest: tag.digest,
    modifiedAt: tag.modified_at,
    family: details.family,
    families: details.families,
    parameterSize: details.parameter_size,
    quantization: details.quantization_level,
  };
}

/**
 * The context length the runtime reported, from whichever endpoint offered one.
 *
 * `/api/tags` puts it in `details.context_length`; `/api/show` usually omits it
 * there but carries `<arch>.context_length` in `model_info`. Either is the
 * runtime's own number, so either may be used — but losing the one we already
 * have just because the other call failed would be a self-inflicted blank.
 */
function contextLengthFor(tag: OllamaTag, show: OllamaShowResponse | undefined): number | null {
  return contextLengthFrom(show) ?? (typeof tag.details?.context_length === 'number' && tag.details.context_length > 0 ? tag.details.context_length : null);
}

/**
 * Ask the runtime about one installed model.
 *
 * Returns a complete `LocalModelInfo` in every branch — including the branches
 * where the answer was "no". A model we know nothing about is still a model the
 * user has on disk, and the caller's job is to list it, marked degraded.
 */
export async function describeOllamaModel(
  base: string,
  tag: OllamaTag,
  fetchImpl: OllamaFetcher
): Promise<LocalModelInfo> {
  const id = tag.model || tag.name;

  let show: OllamaShowResponse | undefined;
  try {
    const res = await fetchImpl(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: id }),
      signal: timeoutSignal(SHOW_TIMEOUT_MS),
    });
    if (res.status === 404) {
      // The runtime positively says it cannot serve this. That is a state the
      // user can act on, so it is stated — not papered over with guesses.
      return {
        ...baseInfoFor(tag),
        contextLength: contextLengthFor(tag, undefined),
        capabilities: [],
        capabilitySource: 'unknown',
        detailStatus: 'missing',
        loadable: false,
        warning: `${id} is listed by Ollama but cannot be loaded. Re-run: ollama pull ${id}`,
      };
    }
    if (!res.ok) {
      return {
        ...baseInfoFor(tag),
        contextLength: contextLengthFor(tag, undefined),
        capabilities: [],
        capabilitySource: 'unknown',
        detailStatus: 'unreachable',
        loadable: null,
        warning: `${id}: Ollama answered HTTP ${res.status} for /api/show — capabilities unknown.`,
      };
    }
    show = (await res.json()) as OllamaShowResponse;
  } catch {
    // Timed out, refused, connection dropped. Unknown is not the same as absent.
    return {
      ...baseInfoFor(tag),
      contextLength: contextLengthFor(tag, undefined),
      capabilities: [],
      capabilitySource: 'unknown',
      detailStatus: 'unreachable',
      loadable: null,
      warning: `${id}: could not reach Ollama at ${base} — capabilities unknown.`,
    };
  }

  const runtimeCaps = normaliseCapabilities(show?.capabilities);
  if (runtimeCaps.length > 0) {
    return {
      ...baseInfoFor(tag),
      // `/api/show` omits `details.context_length` but carries it in model_info.
      contextLength: contextLengthFor(tag, show),
      capabilities: runtimeCaps,
      capabilitySource: 'runtime',
      detailStatus: 'ok',
      loadable: true,
    };
  }

  const assumed = legacyCapabilitiesFor(id);
  return {
    ...baseInfoFor(tag),
    contextLength: contextLengthFor(tag, show),
    capabilities: assumed ?? [],
    capabilitySource: assumed ? 'fallback' : 'unknown',
    detailStatus: assumed ? 'assumed' : 'ok',
    loadable: true,
    warning: assumed
      ? `${id}: this Ollama build does not report capabilities (assumed from the model name).`
      : undefined,
  };
}

/**
 * Discover every model this Ollama instance actually holds.
 *
 * The result is the runtime's, not Henry's: whatever `/api/tags` returns right
 * now, including models added or removed since the app started. Nothing here
 * consults a static list, so there is nothing to update when the user pulls
 * something new.
 *
 * An unreachable runtime resolves — it never rejects — with an empty list and
 * an error string, because every caller renders a UI and none of them should
 * have to distinguish "not installed" from "the promise hung".
 */
export async function discoverOllamaModels(
  base: string,
  fetchImpl?: OllamaFetcher,
  opts?: { concurrency?: number }
): Promise<OllamaDiscovery> {
  const url = base.replace(/\/+$/, '');
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as OllamaFetcher);

  let tags: { models?: unknown[] };
  try {
    const res = await doFetch(`${url}/api/tags`, { signal: timeoutSignal(TAGS_TIMEOUT_MS) });
    if (!res.ok) {
      return {
        models: [],
        baseUrl: url,
        runtime: 'ollama',
        warnings: [`Ollama at ${url} answered HTTP ${res.status} for /api/tags.`],
      };
    }
    tags = (await res.json()) as { models?: unknown[] };
  } catch {
    return {
      models: [],
      baseUrl: url,
      runtime: 'ollama',
      warnings: [`Ollama at ${url} did not respond within ${TAGS_TIMEOUT_MS / 1000}s. Is it running? (ollama serve)`],
    };
  }

  const raw = Array.isArray(tags?.models) ? tags.models : [];
  const usable = raw.filter(
    (m): m is OllamaTag => !!m && typeof (m as { name?: unknown }).name === 'string'
  );
  const described = await mapWithLimit(usable, opts?.concurrency ?? 4, (tag) =>
    describeOllamaModel(url, tag, doFetch)
  );

  return {
    models: described,
    baseUrl: url,
    runtime: 'ollama',
    warnings: described.map((m) => m.warning).filter((w): w is string => !!w),
  };
}