/**
 * Henry AI — TTS Service
 * Handles text-to-speech via Groq PlayAI TTS (primary) or browser Web Speech API (fallback).
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
export async function speak(
  text: string,
  settings: Record<string, string>,
  providers: any[],
): Promise<void> {
  cancelTTS();

  const provider = settings.tts_provider || 'browser';
  if (provider === 'off') return;

  const clean = cleanForSpeech(text);
  if (!clean) return;

  if (provider === 'groq') {
    // Only fall back to browser if user hasn't explicitly disabled it
    const allowFallback = (settings.tts_fallback_to_browser ?? 'true') !== 'false';
    await speakGroq(clean, settings, providers, allowFallback);
  } else {
    speakBrowser(clean);
  }
}

/** Groq PlayAI TTS — streams WAV audio back and plays it. Falls back to browser if unavailable. */
async function speakGroq(
  text: string,
  settings: Record<string, string>,
  providers: any[],
  allowBrowserFallback = true,
): Promise<void> {
  const groq = providers.find((p: any) => p.id === 'groq');
  const apiKey = groq?.api_key || groq?.apiKey || '';

  if (!apiKey) {
    if (allowBrowserFallback) speakBrowser(text);
    return;
  }

  const model = settings.tts_model_groq || 'playai-tts';
  // Validate voice against known list to avoid silent API errors
  const requestedVoice = settings.tts_voice_groq || 'Fritz-PlayAI';
  const validVoiceIds = GROQ_TTS_VOICES.map((v) => v.id);
  const voice = validVoiceIds.includes(requestedVoice) ? requestedVoice : 'Fritz-PlayAI';

  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: 'wav',
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn(`[Henry TTS] Groq returned ${res.status}${errBody ? ': ' + errBody.slice(0, 200) : ''}, falling back to browser`);
      if (allowBrowserFallback) speakBrowser(text);
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;

    audio.onended = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      emitTTSDone();
    };

    audio.onerror = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      console.warn('[Henry TTS] Audio playback error, falling back to browser');
      if (allowBrowserFallback) speakBrowser(text);
    };

    await audio.play();
  } catch (err) {
    console.warn('[Henry TTS] Groq TTS failed, falling back to browser:', err);
    if (allowBrowserFallback) speakBrowser(text);
  }
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

/** Transcribe audio blob via Groq Whisper (web-based, no Electron required). */
export async function transcribeWithGroq(
  blob: Blob,
  settings: Record<string, string>,
  providers: any[],
): Promise<string> {
  const groq = providers.find((p: any) => p.id === 'groq');
  const apiKey = groq?.api_key || groq?.apiKey || '';

  if (!apiKey) throw new Error('No Groq API key configured for transcription');

  const model = settings.stt_model || 'whisper-large-v3-turbo';

  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', model);
  form.append('response_format', 'text');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Groq Whisper error ${res.status}: ${err}`);
  }

  const text = await res.text();
  return text.trim();
}

/** Available Groq PlayAI voices for the settings dropdown. */
export const GROQ_TTS_VOICES = [
  { id: 'Fritz-PlayAI',     label: 'Fritz (Male, warm)' },
  { id: 'Celeste-PlayAI',   label: 'Celeste (Female, clear)' },
  { id: 'Calum-PlayAI',     label: 'Calum (Male, calm)' },
  { id: 'Deedee-PlayAI',    label: 'Deedee (Female, bright)' },
  { id: 'Mason-PlayAI',     label: 'Mason (Male, authoritative)' },
  { id: 'Eleanor-PlayAI',   label: 'Eleanor (Female, composed)' },
  { id: 'Atlas-PlayAI',     label: 'Atlas (Male, deep)' },
  { id: 'Nia-PlayAI',       label: 'Nia (Female, energetic)' },
  { id: 'Quinn-PlayAI',     label: 'Quinn (Neutral, clear)' },
  { id: 'George-PlayAI',    label: 'George (Male, British)' },
  { id: 'Hades-PlayAI',     label: 'Hades (Male, strong)' },
  { id: 'Thunder-PlayAI',   label: 'Thunder (Male, commanding)' },
];

/** Available STT models. */
export const GROQ_STT_MODELS = [
  { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo (fast, recommended)' },
  { id: 'whisper-large-v3',       label: 'Whisper Large v3 (highest accuracy)' },
  { id: 'distil-whisper-large-v3-en', label: 'Distil Whisper (English only, fastest)' },
];
