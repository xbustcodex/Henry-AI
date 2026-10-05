import { describe, it, expect } from 'vitest';
import {
  GREETING_VARIANTS,
  ALL_GREETING_VARIANTS,
  renderGreeting,
} from './greeting';

/**
 * The assistant's spoken name is a user-configured setting. Four of the twelve greeting
 * variants once omitted the `{name}` placeholder, so whenever `pickVariant` selected one
 * of them the configured name could not appear at all and the greeting silently ignored
 * the setting — roughly a third of launches. That reads as "the setting doesn't work",
 * and is exactly the class of bug `greetingAssistantNameWiring.test.ts` exists to catch.
 *
 * `greetingAssistantNameWiring.test.ts` proves the name survives the real IPC path for
 * whichever variant it happens to pick. This file proves EVERY variant honours it, so the
 * defect cannot hide behind a lucky variant choice.
 */
describe('greeting variants', () => {
  it('every variant carries a {name} placeholder', () => {
    const without = ALL_GREETING_VARIANTS.filter((v) => !v.includes('{name}'));
    expect(without).toEqual([]);
  });

  it('every variant carries an {address} placeholder', () => {
    const without = ALL_GREETING_VARIANTS.filter((v) => !v.includes('{address}'));
    expect(without).toEqual([]);
  });

  it('renders the configured name and owner for every variant in every period', () => {
    for (const [period, variants] of Object.entries(GREETING_VARIANTS)) {
      for (const variant of variants) {
        const text = renderGreeting(variant, 'Ada', 'Zorblax');
        expect(text, `${period}: ${variant}`).toContain('Zorblax');
        expect(text, `${period}: ${variant}`).toContain('Ada');
        expect(text, `${period}: ${variant}`).not.toContain('{name}');
        expect(text, `${period}: ${variant}`).not.toContain('{address}');
      }
    }
  });

  it('falls back to the default name when none is configured, for every variant', () => {
    for (const variant of ALL_GREETING_VARIANTS) {
      expect(renderGreeting(variant, null, null)).toContain('Henry');
    }
  });

  it('covers all four periods with three variants each', () => {
    expect(Object.keys(GREETING_VARIANTS).sort()).toEqual(
      ['afternoon', 'evening', 'lateNight', 'morning'].sort(),
    );
    for (const variants of Object.values(GREETING_VARIANTS)) {
      expect(variants.length).toBe(3);
    }
  });
});