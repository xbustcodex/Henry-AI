/**
 * Renderer-side view of runtime-discovered local models.
 *
 * `AVAILABLE_MODELS` used to hold 19 hard-written Ollama entries. This module is
 * their replacement: it projects whatever `discoverOllamaModels` reports into
 * the same `AIModel` shape every other provider already uses, so the picker,
 * the cost calculator and the scheduler need no special case for local models.
 *
 * Nothing here infers anything from a name. Capability, context length,
 * parameter size and family are copied from what Ollama reported — see
 * `electron/ipc/ollamaCapabilities.ts`. The only string Henry composes is the
 * label the user reads, which routes nothing.
 */

import type { AIModel } from '../types';
import { OLLAMA_PROVIDER_ID } from '../../electron/providers/classification';
import type { LocalModelInfo } from '../../electron/ipc/ollamaCapabilities';

export { OLLAMA_PROVIDER_ID };

/**
 * Ollama's vocabulary → the one the rest of Henry already speaks. This is a
 * translation of runtime terms, not a guess: "completion" means this model can
 * do a text generation turn, which is what `chat` means everywhere else.
 */
const PICKER_CAPABILITY_BY_OLLAMA: Record<string, string> = {
  completion: 'chat',
  tools: 'tools',
  vision: 'vision',
  insert: 'insert',
  embedding: 'embedding',
  thinking: 'reasoning',
};

export function localModelCapabilities(model: LocalModelInfo): string[] {
  return model.capabilities
    .map((c) => PICKER_CAPABILITY_BY_OLLAMA[c] ?? c)
    .filter((c, i, all) => all.indexOf(c) === i);
}

/**
 * One discovered model as a picker entry.
 *
 * `id` is the runtime's own id, because that is what `/api/chat` will accept;
 * `contextWindow` is what the runtime reported, not a number typed in next to
 * the model's name; and `requiresApiKey: false` is carried through so no caller
 * can gate a local model behind a key it will never need.
 */
export function localModelToAIModel(model: LocalModelInfo): AIModel {
  return {
    id: model.id,
    name: model.displayName,
    provider: model.provider,
    // A model whose context length the runtime did not report gets 0, which the
    // UI already reads as "unknown" — not a plausible invented default.
    contextWindow: model.contextLength ?? 0,
    inputPricePer1M: 0,
    outputPricePer1M: 0,
    capabilities: localModelCapabilities(model),
    local: true,
  };
}

export function localModelsToAIModels(models: readonly LocalModelInfo[]): AIModel[] {
  return models.map(localModelToAIModel);
}

/**
 * The text the user reads on one `<option>`.
 *
 * It states the facts that decide whether a model is usable for the job in
 * front of them — size, what it can do, how much context it has — and marks
 * anything Henry had to assume rather than confirm. The "(assumed)" suffix is
 * the whole point of `capabilitySource`: an unconfirmed capability must never
 * render like a confirmed one.
 */
export function localModelLabel(model: LocalModelInfo): string {
  const facts: string[] = [];
  if (model.parameterSize) facts.push(model.parameterSize);
  if (model.capabilities.length > 0) facts.push(model.capabilities.join(', '));
  if (model.contextLength) facts.push(`${Math.round(model.contextLength / 1000)}k ctx`);
  const suffix = model.capabilitySource === 'fallback' ? ' · capabilities assumed' : '';
  const detail = facts.length > 0 ? ` — ${facts.join(' · ')}` : '';
  return `Ollama (Local) — ${model.displayName}${detail}${suffix}`;
}

/**
 * What to tell the user when the local catalogue is not simply "here are your
 * models". Each case is something they can do something about — never a spinner
 * that never resolves, and never a silent empty list that reads as "you own no
 * models" when in fact Ollama is not running.
 */
export interface LocalCatalogState {
  kind: 'ok' | 'unreachable' | 'empty' | 'degraded';
  message?: string;
}

export function localCatalogState(
  models: readonly LocalModelInfo[],
  error?: string
): LocalCatalogState {
  if (models.length === 0) {
    return {
      kind: 'unreachable',
      message:
        error ??
        'No local models found. Start Ollama and pull one — e.g. ollama pull llama3.2:3b',
    };
  }
  const degraded = models.filter((m) => m.warning);
  if (degraded.length > 0) {
    return {
      kind: 'degraded',
      message: degraded.map((m) => m.warning).join(' '),
    };
  }
  return { kind: 'ok' };
}