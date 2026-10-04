/**
 * _sayVoices.ts — Pure parser for macOS `say -v ?` output.
 *
 * Each line looks like:
 *   "Samantha            en_US    # Hello! My name is Samantha."
 *   "Bad News            en_US    # The light you see..."
 *   "Eddy (English (UK)) en_GB    # Hello! My name is Eddy."  (single space!)
 *   "Fiona               en-scotland # Hello..."              (older macOS)
 *
 * Voice names can contain spaces and parentheses — and long names are followed
 * by only ONE space before the language code — so the name is parsed lazily up
 * to the last token before the `#` sample. Pure module (no Electron imports)
 * so it's unit-testable.
 */

export interface SayVoice {
  name: string;
  lang: string;
  sample: string;
}

/** Parse `say -v ?` output into a structured voice list. */
export function parseSayVoices(raw: string): SayVoice[] {
  const voices: SayVoice[] = [];
  for (const line of (raw || '').split('\n')) {
    const m = line.match(/^(.+?)\s+([A-Za-z]{2,3}[_-][A-Za-z][\w-]*)\s*#\s?(.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    voices.push({ name, lang: m[2], sample: m[3].trim() });
  }
  return voices;
}

/** English-language voices only (for the default settings dropdown). */
export function englishSayVoices(voices: SayVoice[]): SayVoice[] {
  return voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
}
