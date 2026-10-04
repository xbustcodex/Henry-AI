/**
 * Henry AI — Error Messages
 *
 * Centralized, human-readable error builders for AI stream failures.
 * Every error shown to the user should come through here.
 *
 * Rules:
 * - say what happened in plain English
 * - say why it happened if we know
 * - say what to do next (always)
 * - never dump raw API text directly into chat
 * - always end with a path forward
 */

// ── Error classifiers ──────────────────────────────────────────────────────

/** True if the error string looks like a network / connectivity problem. */
export function isNetworkError(error: string): boolean {
  return /load failed|failed to fetch|networkerror|network request failed|couldn't reach|could not reach|connection error|network error|econnrefused|etimedout|socket hang|fetch error/i.test(error);
}

/** True if the error is an API auth/key rejection. */
export function isAuthError(error: string): boolean {
  return /invalid.{0,10}api.?key|unauthorized|401|authentication|auth.?error|incorrect api/i.test(error);
}

/** True if the error is a rate-limit / quota problem. */
export function isRateLimitError(error: string): boolean {
  return /rate.?limit|too many requests|429|quota|token.?limit|exceeded/i.test(error);
}

/** True if the error is a context/token-too-long problem. */
export function isContextLengthError(error: string): boolean {
  return /context.{0,15}(too.long|length|exceed|window)|maximum.{0,10}token|input.{0,10}too.{0,5}long/i.test(error);
}

// ── Provider label ─────────────────────────────────────────────────────────

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google AI',
    groq: 'Groq',
    ollama: 'Ollama',
  };
  return labels[provider] ?? provider;
}

// ── Error builders ─────────────────────────────────────────────────────────

/**
 * Build a message for when the primary stream fails and we're about to retry
 * with the fallback model. This shows as a brief status update.
 */
export function buildFallbackNotice(primaryModel: string, fallbackModel: string): string {
  return `*(${primaryModel} didn't respond — switching to ${fallbackModel})*`;
}

/**
 * Build a message for when both the primary and fallback model have failed.
 * Shows what went wrong for each and gives clear next steps.
 */
export function buildBothFailedError(
  primaryProvider: string,
  primaryModel: string,
  primaryError: string,
  fallbackModel: string,
  fallbackError: string
): string {
  const primaryLabel = providerLabel(primaryProvider);
  const primaryReason = summarizeError(primaryProvider, primaryModel, primaryError);
  const fallbackReason = summarizeError(primaryProvider, fallbackModel, fallbackError);

  const lines: string[] = [
    `**Both models couldn't respond.**`,
    ``,
    `- **${primaryModel}** (primary): ${primaryReason}`,
    `- **${fallbackModel}** (backup): ${fallbackReason}`,
    ``,
  ];

  if (isAuthError(primaryError) || isAuthError(fallbackError)) {
    lines.push(
      `**Most likely cause:** Your ${primaryLabel} API key is missing or expired.`,
      `→ Check it in **Settings → AI Providers**.`
    );
  } else if (isRateLimitError(primaryError) || isRateLimitError(fallbackError)) {
    lines.push(
      `**Most likely cause:** You've hit a rate limit.`,
      `→ Wait a moment and try again, or switch to a different provider in **Settings → AI Providers**.`
    );
  } else if (isNetworkError(primaryError) || isNetworkError(fallbackError)) {
    lines.push(
      `**Most likely cause:** Network connectivity issue.`,
      `→ Check your internet connection and try again.`
    );
  } else {
    lines.push(`→ Try again in a moment, or switch providers in **Settings → AI Providers**.`);
  }

  return lines.join('\n');
}

/**
 * Build an error message for a single stream failure (after fallback is unavailable
 * or already tried). Gives a plain explanation and next step.
 */
export function buildStreamError(
  provider: string,
  model: string,
  error: string
): string {
  const label = providerLabel(provider);

  // Context too long
  if (/context.{0,20}length|too many tokens|maximum context|request too large|content too large|tokens.*exceed/i.test(error)) {
    return [
      `**${label}: message too long.**`,
      ``,
      `Henry's system prompt + your conversation exceeded the model's context window.`,
      `→ Start a **New Chat** (top of the chat panel) to clear the context, or keep messages shorter.`,
      `→ You can also switch to a model with a larger context in **Settings → AI Providers**.`,
    ].join('\n');
  }

  if (isAuthError(error)) {
    return [
      `**${label} rejected the API key.**`,
      ``,
      `The key for ${label} looks incorrect or has expired.`,
      `→ Update it in **Settings → AI Providers** and try again.`,
    ].join('\n');
  }

  // Groq token-per-minute rate limit (413 + "Limit NNNNN" pattern)
  if (/tokens per minute|token.*limit|limit.*token|request too large|tpm.*limit|tokens.*min/i.test(error)) {
    return [
      `**${label}: message too long for free tier.**`,
      ``,
      `Your conversation + Henry's context exceeded ${label}'s free tier limit (12,000 tokens/min).`,
      ``,
      `**Quick fixes:**`,
      `→ Start a **New Chat** to clear history`,
      `→ Or upgrade to a paid Groq plan at console.groq.com`,
      `→ Or add an **OpenAI** or **Anthropic** key in Settings — they have higher limits`,
    ].join('\n');
  }

  if (isRateLimitError(error)) {
    return [
      `**${label} rate limit hit.**`,
      ``,
      `You've sent too many requests too quickly.`,
      `→ Wait 30–60 seconds and try again, or switch to another provider in **Settings → AI Providers**.`,
    ].join('\n');
  }

  if (isContextLengthError(error)) {
    return [
      `**Conversation too long for ${model}.**`,
      ``,
      `This thread has grown past the model's context window.`,
      `→ Start a new conversation, or switch to a model with a longer context in **Settings → AI Providers**.`,
    ].join('\n');
  }

  if (isNetworkError(error)) {
    return [
      `**Couldn't reach ${label}.**`,
      ``,
      `The request didn't make it through — this is usually a network issue.`,
      `→ Check your connection and try again. If the problem continues, try a different provider in **Settings → AI Providers**.`,
    ].join('\n');
  }

  // Unknown / generic
  return [
    `**${label} returned an error.**`,
    ``,
    `Something went wrong with the ${model} request.`,
    `→ Try again in a moment. If this keeps happening, check **Settings → AI Providers** or switch to a different model.`,
  ].join('\n');
}

/**
 * Build a message for when `window.henryAPI.streamMessage()` itself throws
 * before any streaming starts — usually an IPC or config problem.
 */
export function buildStartError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (/no model|not configured|missing model|missing provider/i.test(msg)) {
    return [
      `**No AI model is configured.**`,
      ``,
      `→ Go to **Settings → AI Providers**, click **Auto-detect** if you have Ollama running, or add an API key for OpenAI, Anthropic, or Groq.`,
    ].join('\n');
  }

  if (isNetworkError(msg)) {
    return [
      `**Couldn't connect to the AI provider.**`,
      ``,
      `→ Check your internet connection and try again.`,
    ].join('\n');
  }

  // Fallback: show the raw message in a clean wrapper
  return [
    `**Something went wrong before the response could start.**`,
    ``,
    `_(${msg.slice(0, 200)})_`,
    ``,
    `→ Try again in a moment. If it keeps failing, restart Henry.`,
  ].join('\n');
}

/**
 * One-line reason string for embedding inside buildBothFailedError.
 * Converts a raw error into a short human phrase.
 */
function summarizeError(provider: string, _model: string, error: string): string {
  if (isAuthError(error)) return 'API key rejected';
  if (isRateLimitError(error)) return 'rate limit hit';
  if (isContextLengthError(error)) return 'conversation too long';
  if (isNetworkError(error)) return 'network error';
  if (/ollama isn'?t running|ollama not running/i.test(error)) return 'Ollama not running';
  if (/isn'?t loaded|not found in ollama/i.test(error)) return 'model not loaded';
  if (/timeout/i.test(error)) return 'request timed out';
  return error.slice(0, 80).replace(/\n/g, ' ').trim() || 'unknown error';
}

// ── Binary / garbage content guard ────────────────────────────────────────

/**
 * Returns true if a string looks like binary or heavily corrupted content
 * that would render as garbage in the chat.
 *
 * Uses a simple heuristic: if more than 15% of the first 500 chars are
 * non-printable (outside standard ASCII + common Unicode), it's probably binary.
 */
export function isBinaryContent(text: string): boolean {
  if (!text || text.length < 20) return false;
  const sample = text.slice(0, 500);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Allow: tab (9), newline (10), carriage return (13), space–tilde (32-126),
    //        and common Unicode range (128-65535 for CJK, emoji, etc.)
    if (code < 9 || (code > 13 && code < 32) || code === 127) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.15;
}

/**
 * Message to show when binary/garbage content is detected.
 */
export function buildBinaryContentError(provider: string, model: string): string {
  return [
    `**${model} returned unreadable content.**`,
    ``,
    `The response appears to contain binary data or a corrupted stream — this can happen when a file, image, or non-text response is sent through a text channel.`,
    ``,
    `→ Try rephrasing your request in plain text. If you're asking about a file, describe what you need from it instead of attaching the raw file.`,
    `→ If this keeps happening, try a different model in **Settings → AI Providers**.`,
  ].join('\n');
}
