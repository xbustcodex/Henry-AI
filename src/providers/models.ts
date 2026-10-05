import type { AIModel } from '../types';

// All available models with current pricing
export const AVAILABLE_MODELS: AIModel[] = [
  // ── OpenAI ──────────────────────────────────────────
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePer1M: 2.5,
    outputPricePer1M: 10.0,
    capabilities: ['chat', 'code', 'vision'],
    recommended: 'worker',
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.6,
    capabilities: ['chat', 'code', 'vision'],
    recommended: 'companion',
  },
  {
    id: 'o1',
    name: 'o1 (Reasoning)',
    provider: 'openai',
    contextWindow: 200000,
    inputPricePer1M: 15.0,
    outputPricePer1M: 60.0,
    capabilities: ['chat', 'code', 'reasoning'],
    recommended: 'worker',
  },
  {
    id: 'o1-mini',
    name: 'o1 Mini',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePer1M: 3.0,
    outputPricePer1M: 12.0,
    capabilities: ['chat', 'code', 'reasoning'],
  },

  // ── Anthropic ───────────────────────────────────────
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    contextWindow: 200000,
    inputPricePer1M: 3.0,
    outputPricePer1M: 15.0,
    capabilities: ['chat', 'code', 'reasoning', 'vision'],
    recommended: 'worker',
  },
  {
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude 3.5 Haiku',
    provider: 'anthropic',
    contextWindow: 200000,
    inputPricePer1M: 0.25,
    outputPricePer1M: 1.25,
    capabilities: ['chat', 'code'],
    recommended: 'companion',
  },
  {
    id: 'claude-opus-4-20250514',
    name: 'Claude Opus 4',
    provider: 'anthropic',
    contextWindow: 200000,
    inputPricePer1M: 15.0,
    outputPricePer1M: 75.0,
    capabilities: ['chat', 'code', 'reasoning', 'vision'],
    recommended: 'worker',
  },

  // ── Google ──────────────────────────────────────────
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    contextWindow: 1000000,
    inputPricePer1M: 0.3,
    outputPricePer1M: 2.5,
    capabilities: ['chat', 'code', 'reasoning', 'vision'],
    recommended: 'worker',
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash-Lite',
    provider: 'google',
    contextWindow: 1000000,
    inputPricePer1M: 0.1,
    outputPricePer1M: 0.4,
    capabilities: ['chat', 'code', 'vision'],
    recommended: 'companion',
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'google',
    contextWindow: 1000000,
    inputPricePer1M: 0.1,
    outputPricePer1M: 0.4,
    capabilities: ['chat', 'code', 'vision'],
    recommended: 'companion',
  },
  {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    provider: 'google',
    contextWindow: 2000000,
    inputPricePer1M: 1.25,
    outputPricePer1M: 5.0,
    capabilities: ['chat', 'code', 'reasoning', 'vision'],
    recommended: 'worker',
  },
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    provider: 'google',
    contextWindow: 1000000,
    inputPricePer1M: 0.075,
    outputPricePer1M: 0.3,
    capabilities: ['chat', 'code'],
    recommended: 'companion',
  },

  // NOTE: there are deliberately no `provider: 'ollama'` entries here.
  //
  // This file used to carry 19 hand-written local models with invented
  // `contextWindow` values and capabilities guessed from the model name. It was
  // wrong in both directions: it advertised models the user had never pulled
  // (`mistral-nemo`, `codellama:34b`, `qwen2.5:72b`) and hid the ones they had
  // (`moondream`, `gpt-oss:20b`, `deepseek-coder:6.7b`).
  //
  // Local models are discovered at runtime instead — see
  // `src/providers/localModels.ts`, which projects what Ollama reports into this
  // same `AIModel` shape so the picker needs no special case.

  // ── OpenRouter — 300+ models via single API ───────────
  {
    id: 'openrouter/auto',
    name: 'OpenRouter Auto (routes to best model)',
    provider: 'openrouter',
    contextWindow: 128000,
    inputPricePer1M: 0,
    outputPricePer1M: 0,
    capabilities: ['chat', 'code', 'reasoning'],
    recommended: 'companion',
  },
  {
    id: 'openrouter/anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 200000,
    inputPricePer1M: 3.0,
    outputPricePer1M: 15.0,
    capabilities: ['chat', 'code', 'reasoning', 'vision'],
    recommended: 'worker',
  },
  {
    id: 'openrouter/google/gemini-2.0-flash-001',
    name: 'Gemini 2.0 Flash (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 1000000,
    inputPricePer1M: 0.1,
    outputPricePer1M: 0.4,
    capabilities: ['chat', 'code', 'vision'],
    recommended: 'companion',
  },
  {
    id: 'openrouter/meta-llama/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B Instruct (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 128000,
    inputPricePer1M: 0.59,
    outputPricePer1M: 0.79,
    capabilities: ['chat', 'code', 'reasoning'],
    recommended: 'worker',
  },
  {
    id: 'openrouter/mistralai/mistral-large',
    name: 'Mistral Large (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 128000,
    inputPricePer1M: 2.0,
    outputPricePer1M: 6.0,
    capabilities: ['chat', 'code', 'reasoning'],
    recommended: 'worker',
  },
  {
    id: 'openrouter/qwen/qwen-2.5-coder-32b-instruct',
    name: 'Qwen 2.5 Coder 32B (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 32000,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.6,
    capabilities: ['code'],
    recommended: 'worker',
  },
  {
    id: 'openrouter/deepseek/deepseek-r1',
    name: 'DeepSeek R1 (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 128000,
    inputPricePer1M: 0.55,
    outputPricePer1M: 2.19,
    capabilities: ['chat', 'code', 'reasoning'],
    recommended: 'worker',
  },
];

// Provider metadata
export const PROVIDERS = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    icon: '🟢',
    description: 'GPT-4o, o1, and more. Best general-purpose AI.',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    icon: '🟠',
    description: 'Claude models. Excellent for code and long documents.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
  },
  google: {
    id: 'google',
    name: 'Google Gemini',
    icon: '🔵',
    description: 'Gemini 2.0 Flash — best free AI in 2026. 1,500 requests/day free, 1M context, no card needed. Get a key at aistudio.google.com in 30 seconds.',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPrefix: 'AI',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: '🌐',
    description: 'Access 300+ models through one API. Free tier available. Get a key at openrouter.ai/keys.',
    keyUrl: 'https://openrouter.ai/keys',
    keyPrefix: 'sk-or-',
  },
  runway: {
    id: 'runway',
    name: 'Runway',
    icon: '🎬',
    keyUrl: 'https://app.runwayml.com/settings',
    requiresKey: true,
    keyPrefix: 'rwa_',
    keyPlaceholder: 'rwa_...',
    description: 'State-of-the-art video generation (Gen-3, Gen-4)',
    models: [] as const,
  },
  relay: {
    id: 'relay',
    name: 'Your Own Relay (optional)',
    icon: '🔗',
    description:
      'Route requests through an OpenAI-compatible endpoint you control and pay for yourself — ' +
      'a self-hosted gateway or a corporate proxy. Henry hosts nothing here: this stays off ' +
      'until you set a relay URL and select it, and no plan includes hosted AI.',
    keyUrl: '',
    keyPrefix: '',
    optional: true,
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    icon: '🧩',
    description:
      'Any model the opencode CLI can reach — its own zen service and OpenRouter — ' +
      'routed through a local loopback bridge. Needs the opencode CLI installed; it is not an ' +
      'API key here. The models it reaches are external services: each one needs your own ' +
      'account and key with that provider.',
    keyUrl: 'https://opencode.ai',
    keyPrefix: '',
    local: true,
  },
  'opencode-zen': {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    icon: '✨',
    description:
      'OpenCode Zen — tested models from the OpenCode team, reached through the local opencode ' +
      'bridge. Zen is an external service that runs on your own OpenCode account: add your Zen ' +
      'key to use it.',
    keyUrl: 'https://opencode.ai/docs/zen/',
    keyPrefix: '',
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    icon: '🏠',
    description:
      "Run models locally on your machine. Free — Henry's only cost-free AI path, and nothing " +
      'leaves this computer.',
    keyUrl: 'https://ollama.ai',
    keyPrefix: '',
    local: true,
  },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

/**
 * Provider ids Henry used to ship that are no longer supported at all — there
 * is no transport, no key, and no model catalogue behind them.
 *
 * An install that still has one of these selected must be told the provider is
 * gone. It must NOT be silently swapped for a different provider: that is the
 * silent fallback this list exists to prevent.
 */
export const RETIRED_PROVIDERS: Record<string, string> = {
  groq: 'Groq',
};

/** Display name for a retired provider, or null if the id is still supported. */
export function retiredProviderName(providerId: string | null | undefined): string | null {
  const id = (providerId ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RETIRED_PROVIDERS, id) ? RETIRED_PROVIDERS[id] : null;
}

export function isRetiredProvider(providerId: string | null | undefined): boolean {
  return retiredProviderName(providerId) !== null;
}

export function getModelsForProvider(providerId: string): AIModel[] {
  return AVAILABLE_MODELS.filter((m) => m.provider === providerId);
}

export function getModel(modelId: string): AIModel | undefined {
  return AVAILABLE_MODELS.find((m) => m.id === modelId);
}

export function formatPrice(price: number): string {
  if (price === 0) return 'Free';
  if (price < 1) return `$${price.toFixed(3)}`;
  return `$${price.toFixed(2)}`;
}

export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const model = getModel(modelId);
  if (!model) return 0;
  return (
    (inputTokens / 1_000_000) * model.inputPricePer1M +
    (outputTokens / 1_000_000) * model.outputPricePer1M
  );
}
