import { describe, it, expect } from 'vitest';
import { parseSayVoices, englishSayVoices } from './_sayVoices';

const SAMPLE = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Alice               it_IT    # Ciao! Mi chiamo Alice.',
  'Bad News            en_US    # The light you see at the end of the tunnel is the headlamp of a fast approaching train.',
  'Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.',
  'Fiona               en-scotland # Hello, my name is Fiona.',
  // Real macOS output: long names get only ONE space before the lang code.
  'Eddy (German (Germany)) de_DE    # Hallo! Ich heiße Eddy.',
  'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  '',
  'not a voice line',
].join('\n');

describe('parseSayVoices', () => {
  it('parses names, languages, and samples', () => {
    const voices = parseSayVoices(SAMPLE);
    const samantha = voices.find((v) => v.name === 'Samantha');
    expect(samantha).toBeDefined();
    expect(samantha?.lang).toBe('en_US');
    expect(samantha?.sample).toBe('Hello! My name is Samantha.');
  });

  it('handles multi-word voice names', () => {
    const voices = parseSayVoices(SAMPLE);
    const badNews = voices.find((v) => v.name === 'Bad News');
    expect(badNews).toBeDefined();
    expect(badNews?.lang).toBe('en_US');
  });

  it('handles parenthesised names with a single space before the lang code', () => {
    const voices = parseSayVoices(SAMPLE);
    expect(voices.find((v) => v.name === 'Eddy (German (Germany))')?.lang).toBe('de_DE');
    expect(voices.find((v) => v.name === 'Eddy (English (UK))')?.lang).toBe('en_GB');
  });

  it('handles hyphenated language codes (older macOS)', () => {
    const voices = parseSayVoices(SAMPLE);
    expect(voices.find((v) => v.name === 'Fiona')?.lang).toBe('en-scotland');
  });

  it('keeps accented names intact', () => {
    const voices = parseSayVoices(SAMPLE);
    expect(voices.find((v) => v.name === 'Amélie')?.lang).toBe('fr_CA');
  });

  it('skips blank and malformed lines', () => {
    const voices = parseSayVoices(SAMPLE);
    expect(voices).toHaveLength(8);
    expect(voices.every((v) => v.name && v.lang)).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(parseSayVoices('')).toEqual([]);
  });
});

describe('englishSayVoices', () => {
  it('filters to en_* and en-* voices only', () => {
    const en = englishSayVoices(parseSayVoices(SAMPLE));
    expect(en.map((v) => v.name).sort()).toEqual([
      'Albert',
      'Bad News',
      'Eddy (English (UK))',
      'Fiona',
      'Samantha',
    ]);
  });
});
