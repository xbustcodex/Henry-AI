/**
 * Henry Emotional Intelligence — detect user emotional state from message patterns.
 *
 * Does NOT fake emotions or claim inner experience.
 * Adapts tone, pacing, and depth of response to match the user's state.
 * Injected into the system prompt as a lightweight behavior modifier.
 */

// ── Detected states ───────────────────────────────────────────────────────────

export type EmotionalState =
  | 'overwhelmed'
  | 'stressed'
  | 'urgent'
  | 'scattered'
  | 'excited'
  | 'confused'
  | 'discouraged'
  | 'confident'
  | 'focused'
  | 'neutral';

export interface EmotionResult {
  state: EmotionalState;
  intensity: 'low' | 'medium' | 'high';
  toneAdaptation: string;
}

// ── Detection patterns ────────────────────────────────────────────────────────

const PATTERNS: Array<{
  state: EmotionalState;
  patterns: RegExp[];
  intensity: 'low' | 'medium' | 'high';
}> = [
  {
    state: 'overwhelmed',
    intensity: 'high',
    patterns: [
      /\b(overwhelmed?|too much|can'?t (keep up|handle|cope|deal)|drowning|buried|swamped|falling behind|losing it|breaking point)\b/i,
      /\b(everything at once|don'?t know where to start|so much going on|too many things)\b/i,
    ],
  },
  {
    state: 'stressed',
    intensity: 'medium',
    patterns: [
      /\b(stressed?|anxious|nervous|worried|pressure|deadline|running out of time|not enough time)\b/i,
      /\b(freaking out|panic|panicking|in trouble|behind on|late on|missed)\b/i,
    ],
  },
  {
    state: 'urgent',
    intensity: 'high',
    patterns: [
      /\b(urgent|asap|right now|immediately|emergency|critical|need (this|it) (now|fast|today))\b/i,
      /\b(due (today|in an hour|in \d+ minutes?)|last minute|can you (hurry|speed|rush))\b/i,
    ],
  },
  {
    state: 'scattered',
    intensity: 'medium',
    patterns: [
      /\b(all over the place|can'?t focus|distracted|jumping between|can'?t think straight|unfocused|scattered)\b/i,
      /\b(i don'?t know what to do|not sure where|unclear what|confused about (direction|next|priorities))\b/i,
    ],
  },
  {
    state: 'excited',
    intensity: 'medium',
    patterns: [
      /\b(excited|pumped|stoked|fired up|can'?t wait|this is huge|big news|breakthrough|amazing|incredible|this is it)\b/i,
      /(!{2,}|🎉|🚀|🔥|💪|🙌)/,
    ],
  },
  {
    state: 'confused',
    intensity: 'low',
    patterns: [
      /\b(confused|don'?t understand|not (making sense|sure what)|lost|what does (this|that) mean|can you explain)\b/i,
      /\b(i'?m not following|unclear|doesn'?t make sense|what am i (missing|supposed to))\b/i,
    ],
  },
  {
    state: 'discouraged',
    intensity: 'medium',
    patterns: [
      /\b(discouraged|feeling (stuck|hopeless|useless|pointless|defeated)|not working|failing|gave up|want to quit|nothing is working)\b/i,
      /\b(is it even worth|should i (even|just|bother)|maybe i should (stop|give up|quit))\b/i,
    ],
  },
  {
    state: 'confident',
    intensity: 'low',
    patterns: [
      /\b(ready to|let'?s do this|i'?ve got (this|a plan)|here'?s my plan|decided to|going for it|moving forward)\b/i,
      /\b(figured it out|got it|know what to do|clear on|locked in)\b/i,
    ],
  },
  {
    state: 'focused',
    intensity: 'low',
    patterns: [
      /\b(focused|in the zone|working on|let'?s (focus|work|build|start)|back to|continuing|picking up where)\b/i,
    ],
  },
];

// ── Tone adaptation instructions ──────────────────────────────────────────────

const TONE_ADAPTATIONS: Record<EmotionalState, string> = {
  overwhelmed:
    'The user is overwhelmed. Lead with calm. Simplify. Break things into the single most important next step. Do not list ten options. Be a grounding force.',
  stressed:
    'The user is under pressure. Match their energy with focused clarity. Skip preamble. Get to what matters fast. Make them feel more in control.',
  urgent:
    'The user needs this now. Lead with the answer or action immediately. Skip context unless it changes the answer. Be crisp.',
  scattered:
    'The user is scattered. Help them find one thread. Ask one clarifying question or offer one clear starting point. Do not overwhelm with structure.',
  excited:
    'The user is energized. Match the moment. Be direct and forward-moving. Build on the momentum.',
  confused:
    'The user is confused. Slow down. Explain clearly without jargon. Use examples. Check understanding before moving on.',
  discouraged:
    'The user is discouraged. Lead with acknowledgment (brief). Then pivot to what can actually move. Be concrete, not motivational-poster.',
  confident:
    'The user is confident and moving. Stay out of the way. Be efficient. Support their direction.',
  focused:
    'The user is in work mode. Be precise, practical, and efficient. Skip small talk.',
  neutral: '',
};

// ── Main detector ─────────────────────────────────────────────────────────────

/**
 * Detect emotional state from user message content.
 * Returns neutral when no clear signal is present.
 */
export function detectEmotionalState(content: string): EmotionResult {
  const trimmed = content.trim();

  // Very short messages rarely have emotional signals
  if (trimmed.length < 10) {
    return { state: 'neutral', intensity: 'low', toneAdaptation: '' };
  }

  for (const def of PATTERNS) {
    for (const pattern of def.patterns) {
      if (pattern.test(trimmed)) {
        return {
          state: def.state,
          intensity: def.intensity,
          toneAdaptation: TONE_ADAPTATIONS[def.state],
        };
      }
    }
  }

  // Detect urgency from multiple exclamation marks
  const exclamations = (trimmed.match(/!/g) || []).length;
  if (exclamations >= 3) {
    return {
      state: 'urgent',
      intensity: 'medium',
      toneAdaptation: TONE_ADAPTATIONS.urgent,
    };
  }

  // Very long message → likely scattered or complex
  if (trimmed.length > 600 && !trimmed.includes('?')) {
    return {
      state: 'scattered',
      intensity: 'low',
      toneAdaptation: TONE_ADAPTATIONS.scattered,
    };
  }

  return { state: 'neutral', intensity: 'low', toneAdaptation: '' };
}

/**
 * Format the emotion result as a system prompt block.
 * Returns empty string for neutral state (no injection needed).
 */
export function buildEmotionBlock(result: EmotionResult): string {
  if (result.state === 'neutral' || !result.toneAdaptation) return '';
  return `## Tone Adaptation (detected: ${result.state})\n${result.toneAdaptation}`;
}
