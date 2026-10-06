/**
 * Two defects from the 3.0.8 ordinary-Chat blocker.
 *
 * 1. The presence tier was rendered as a model size. `tierLabel` was
 *    `presenceTier === 'quality' ? '70B' : presenceTier === 'fast' ? '8B' : ''` —
 *    retired Groq model names, not runtime metadata. A user configured with
 *    Ollama `llama3.2:3b` was shown "Thinking… (8B)".
 *
 * 2. `extractErrorDetail` fell back to the LAST line of a wrapped error. For a
 *    Henry-authored error the last line is Henry's own remediation copy, so the
 *    user was shown advice about a URL that was already correct as though it were
 *    the reason the request failed.
 */
import { describe, it, expect } from 'vitest';
import { presenceTierLabel, detectPresenceTier } from './ambientBrain';
import { extractErrorDetail, buildStreamError } from './errorMessages';

describe('presence tier no longer fabricates a model size', () => {
  it('I: no tier renders a retired Groq parameter count', () => {
    for (const tier of ['fast', 'balanced', 'quality'] as const) {
      const label = presenceTierLabel(tier);
      expect(label).not.toMatch(/\d+\s*b/i);
      expect(label).not.toMatch(/groq|instant/i);
    }
  });

  it('I: the labels name the tier, not the model', () => {
    expect(presenceTierLabel('fast')).toBe('quick');
    expect(presenceTierLabel('quality')).toBe('deep');
    expect(presenceTierLabel('balanced')).toBe('');
  });

  it('I: a configured 3.2B Ollama model is never shown as 8B or 70B', () => {
    // Whatever tier a prompt lands in, the rendered status text must not claim a
    // parameter count the configured model does not have.
    const rendered = (['fast', 'balanced', 'quality'] as const).map((t) => {
      const label = presenceTierLabel(t);
      return label ? `Thinking… (${label})` : 'Thinking…';
    });
    const joined = rendered.join(' | ');
    expect(joined).not.toMatch(/\b8b\b|\b70b\b/i);
    expect(joined).not.toContain('llama-3.1-8b-instant');
  });

  it('I: a short prompt lands on a tier that renders truthfully', () => {
    // "Name one colour." is under the short-prompt threshold, which is exactly
    // the case that used to render "Thinking… (8B)".
    const tier = detectPresenceTier('Name one colour.', {});
    expect(presenceTierLabel(tier)).not.toMatch(/\d+b/i);
  });
});

describe('extractErrorDetail never reports Henry guidance as the reason', () => {
  it('H: does not return the "update the URL in Settings" line', () => {
    const wrapped = new Error(
      "Ollama isn't running. Start it in Terminal:\n\n  ollama serve\n\n" +
        'If Ollama is on a different machine, update the URL in Settings → Engines.',
    );
    const detail = extractErrorDetail(wrapped);
    expect(detail).not.toMatch(/update the URL/i);
    expect(detail).not.toMatch(/Settings →/);
  });

  it('H: reports the actual failure instead', () => {
    const wrapped = new Error(
      "Ollama isn't running. Start it in Terminal:\n\n  ollama serve\n\n" +
        'If Ollama is on a different machine, update the URL in Settings → Engines.',
    );
    expect(extractErrorDetail(wrapped)).toBe("Ollama isn't running.");
  });

  it('H: does not surface a shell instruction as the reason', () => {
    const detail = extractErrorDetail(
      new Error('Model "llama3.2:3b" isn\'t loaded in Ollama.\n\nRun this in Terminal:\n\n  ollama pull llama3.2:3b'),
    );
    expect(detail).not.toMatch(/ollama pull/i);
    expect(detail).toContain('isn\'t loaded in Ollama');
  });

  it('H: a message made only of advice yields no detail rather than a wrong one', () => {
    const detail = extractErrorDetail(
      new Error('If this keeps happening, check Settings → AI Providers or switch to a different model.'),
    );
    expect(detail).toBe('');
  });

  it('H: a genuine provider error is preserved', () => {
    const detail = extractErrorDetail(new Error('upstream exploded'));
    expect(detail).toBe('upstream exploded');
  });

  it('H: the specific-line match still wins over the first line', () => {
    const detail = extractErrorDetail(
      new Error(
        "Error invoking remote method 'ai:send': Error: opencode exited with code 2: Error: unknown flags: --bogus",
      ),
    );
    expect(detail).toContain('unknown flags');
  });

  it('H: an IPC envelope alone is not reported as the cause', () => {
    const detail = extractErrorDetail(
      new Error("Error invoking remote method 'ai:send': Error: something went wrong in the transport"),
    );
    expect(detail).toContain('something went wrong in the transport');
    expect(detail).not.toMatch(/invoking remote method/i);
  });

  it('H: empty input still yields no detail', () => {
    expect(extractErrorDetail(new Error(''))).toBe('');
    expect(extractErrorDetail(undefined)).toBe('');
  });

  it('H: the user-facing message carries a real reason, not Henry advice', () => {
    const message = buildStreamError(
      'ollama',
      'llama3.2:3b',
      "Ollama isn't running. Start it in Terminal:\n\n  ollama serve\n\n" +
        'If Ollama is on a different machine, update the URL in Settings → Engines.',
    );
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toMatch(/invoking remote method/i);
  });
});
