
import { getOllamaBaseUrl } from './ollamaConfig';
import { ollamaChatAdapter } from './ollamaProviderAdapter';

const OUTPUT_PREVIEW_MAX = 280;

export type OllamaLocalCheckResult =
  | {
      ok: true;
      provider: 'ollama';
      host: string;
      model: string;
      outputPreview: string;
    }
  | {
      ok: false;
      provider: string;
      host: string;
      model: string;
      error: string;
      outputPreview?: string;
    }
  | {
      ok: false;
      skipped: true;
      reason: string;
      provider: string;
      host?: string;
      model?: string;
    };

/**
 * Dev-only: verify local Ollama using current companion settings.
 * Does not run in production (`import.meta.env.PROD` → early return).
 * Attach to `window.runOllamaLocalCheck` from `main.tsx` in DEV only.
 */
export async function runOllamaLocalCheck(): Promise<OllamaLocalCheckResult> {
  if (import.meta.env.PROD) {
    console.warn('[Henry] runOllamaLocalCheck is disabled in production.');
    return {
      ok: false,
      skipped: true,
      reason: 'runOllamaLocalCheck is disabled in production builds.',
      provider: 'n/a',
    };
  }

  const api = window.henryAPI;
  if (!api?.getSettings) {
    return {
      ok: false,
      skipped: true,
      reason: 'henryAPI.getSettings is not available.',
      provider: 'unknown',
    };
  }

  let settings: Record<string, string>;
  try {
    settings = await api.getSettings();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      provider: 'unknown',
      host: '',
      model: '',
      error: `Could not read settings: ${msg}`,
    };
  }

  const companion = (settings.companion_provider || '').trim();
  const host = getOllamaBaseUrl(settings);
  const model = (settings.companion_model || '').trim();

  if (companion !== 'ollama') {
    return {
      ok: false,
      skipped: true,
      reason: `Companion provider is "${companion || '(unset)'}", not "ollama". Set the main brain to Ollama in Settings → Engines to run this check.`,
      provider: companion || '(unset)',
      host,
      model,
    };
  }

  // Ollama selected but no model chosen: report it instead of running a model
  // the user never picked.
  if (!model) {
    return {
      ok: false,
      skipped: true,
      reason:
        'Ollama is the companion provider but no model is selected. Pick a model ' +
        'the running Ollama reports in Settings → Engines.',
      provider: 'ollama',
      host,
      model: '',
    };
  }

  const r = await ollamaChatAdapter({
    host,
    model,
    messages: [{ role: 'user', content: 'Reply with exactly one word: ping' }],
    maxTokens: 64,
    temperature: 0.2,
  });

  if (!r.ok) {
    return {
      ok: false,
      provider: 'ollama',
      host,
      model,
      error: r.error,
    };
  }

  const text = r.outputText;
  const outputPreview =
    text.length > OUTPUT_PREVIEW_MAX ? `${text.slice(0, OUTPUT_PREVIEW_MAX)}…` : text;

  return {
    ok: true,
    provider: 'ollama',
    host,
    model,
    outputPreview,
  };
}
