/**
 * Henry AI — TTS Service
 * Handles text-to-speech via the browser Web Speech API.
 * (Desktop uses the native/local voice ladder in voice.ts; this module is the web path.)
 * Emits 'henry_tts_done' when speech finishes — ambient mode listens for this to auto-start mic.
 */

let currentAudio: HTMLAudioElement | null = null;

/** Strip Markdown and clean text before sending to TTS. */
function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, 'code block')
    .replace(/`[^`]+`/g, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/>\s+/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Cancel any currently playing speech. */
export function cancelTTS(): void {
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  if (currentAudio) {
    currentAudio.pause();
    try { URL.revokeObjectURL(currentAudio.src); } catch { /* ignore */ }
    currentAudio = null;
  }
}

function emitTTSDone() {
  window.dispatchEvent(new CustomEvent('henry_tts_done'));
}

/** Speak text using the configured TTS provider. */
export async function speak(text: string): Promise<void> {
  cancelTTS();
  speakBrowser(cleanForSpeech(text));
}

/** Web Speech API TTS — always available in browsers, no API key needed. */
function speakBrowser(text: string): void {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.92;
  utterance.pitch = 1.05;

  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(
    (v) =>
      v.name === 'Samantha' ||
      v.name === 'Daniel' ||
      v.name.includes('Google') ||
      v.lang.startsWith('en'),
  );
  if (preferred) utterance.voice = preferred;

  utterance.onend = () => emitTTSDone();
  utterance.onerror = () => emitTTSDone();

  window.speechSynthesis.speak(utterance);
}
