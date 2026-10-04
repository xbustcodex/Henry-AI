/**
 * Henry Ambient Brain
 * Presence behaviors, spoken acknowledgments, and state narration.
 * Makes Henry feel continuous, present, and alive rather than transactional.
 */

import { speak, cancelTTS } from './ttsService';

// ── Presence phrase pools ──────────────────────────────────────────────────────

const ACK_PHRASES = {
  quick: ['Got it.', 'On it.', 'Sure.', 'Yep.', 'Got you.'],
  thinking: ['Let me think on that.', 'One moment.', 'Working on it.', 'On it.'],
  writing: ['Let me put that together.', 'On it.', 'Writing now.'],
  planning: ['Let me map that out.', 'Planning it now.', 'On it.'],
  strategy: ['Let me think this through.', 'On it.', 'Working through that now.'],
  searching: ['Let me look.', 'Searching now.', 'On it.'],
  done: ['Done.', 'There you go.', 'Got it.', 'All set.'],
  found: (n: number, thing: string) => `I found ${n} ${thing}.`,
  error: ['Hmm — something didn\'t work. Let me try again.', 'Hit a snag. Trying again.'],
};

type AckType = 'quick' | 'thinking' | 'writing' | 'planning' | 'strategy' | 'searching' | 'done' | 'error';

function pick(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Returns the right presence phrase for the task type.
 * Designed to be spoken BEFORE the model starts streaming on heavy tasks.
 */
export function getPresencePhrase(taskType: 'fast' | 'balanced' | 'quality', content: string): string | null {
  if (taskType !== 'quality') return null; // only narrate heavy tasks

  const lower = content.toLowerCase();
  if (/write|draft|compose|rewrite|revise|essay|letter|email|proposal|script|article/i.test(lower)) {
    return pick(ACK_PHRASES.writing);
  }
  if (/roadmap|strategy|plan|phases?|milestone|go.to.market|swot|business/i.test(lower)) {
    return pick(ACK_PHRASES.strategy);
  }
  if (/plan|outline|steps|workflow|breakdown|structure/i.test(lower)) {
    return pick(ACK_PHRASES.planning);
  }
  if (/search|find|look|fetch|check/i.test(lower)) {
    return pick(ACK_PHRASES.searching);
  }
  return pick(ACK_PHRASES.thinking);
}

/**
 * Speaks a short presence acknowledgment without triggering the ambient mode
 * auto-listen loop (does NOT emit henry_tts_done).
 *
 * Returns a promise that resolves when the phrase finishes speaking.
 */
export async function speakPresence(
  phrase: string,
  settings: Record<string, string>,
  providers: any[],
): Promise<void> {
  // Temporarily monkey-patch to suppress the ambient loop by using
  // browser speech synthesis directly for short acks (faster, no latency)
  if (typeof window === 'undefined') return;

  // Browser TTS path — fast, no API call, no event emission
  if ('speechSynthesis' in window) {
    return new Promise<void>((resolve) => {
      cancelTTS(); // stop anything currently playing
      const utt = new SpeechSynthesisUtterance(phrase);
      utt.rate = 1.1;
      utt.pitch = 1.0;
      utt.volume = 0.9;
      utt.onend = () => resolve();
      utt.onerror = () => resolve();
      window.speechSynthesis.speak(utt);
    });
  }
}

/**
 * Announces completion with an optional count.
 * Example: announceDone("file", 3) → "I found 3 files."
 */
export function announceDone(thing?: string, count?: number): string {
  if (thing && count !== undefined) {
    return ACK_PHRASES.found(count, count === 1 ? thing : `${thing}s`);
  }
  return pick(ACK_PHRASES.done);
}

/**
 * Detects the tier of a task from the content and quality preference.
 * Returns 'fast' | 'balanced' | 'quality' for use in presence decisions.
 */
export function detectPresenceTier(
  content: string,
  settings: Record<string, string>,
): 'fast' | 'balanced' | 'quality' {
  // Import inline to avoid circular dependency
  const pref = settings.model_quality_preference || 'balanced';
  if (pref === 'fast') return 'fast';
  if (pref === 'quality') return 'quality';

  const len = content.trim().length;
  if (len < 50) return 'fast';

  // Quality triggers
  const qualityMatch = [
    /\b(write|draft|rewrite|revise|compose)\b.{10,}/i,
    /\b(roadmap|strategy|plan|business plan)\b/i,
    /\b(analyze|analyse|explain|compare|evaluate)\b.{10,}/i,
    /\b(summarize|summarise)\b.{20,}/i,
  ].some((p) => p.test(content));

  if (qualityMatch || len > 400) return 'quality';
  if (len < 120) return 'fast';
  return 'balanced';
}
