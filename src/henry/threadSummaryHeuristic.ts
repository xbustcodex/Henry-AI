/**
 * Lean, non-LLM thread rollup for conversation_summaries — compressed themes from recent turns.
 */

import {
  capMessageContent,
  HENRY_MEMORY_CAPS,
  sliceRecentThreadMessages,
} from './memoryContext';

const SNIPPET = 140;
const MAX_TURNS = 14;

function firstLine(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  const cut = t.indexOf('\n');
  return (cut >= 0 ? t.slice(0, cut) : t).trim();
}

/**
 * Build a short markdown-style rollup from recent messages (no API calls).
 */
export function buildLeanThreadSummaryFromMessages(
  messages: ReadonlyArray<{ role: string; content: string }>
): { summary: string; messageCount: number; tokenCount: number } {
  const slice = sliceRecentThreadMessages(
    messages.map((m) => ({
      role: m.role,
      content: capMessageContent(m.content, SNIPPET),
    })),
    MAX_TURNS
  );

  const lines: string[] = [
    '*Auto rollup from recent thread (lean; not a full transcript).*',
    '',
  ];

  for (const m of slice) {
    const label = m.role === 'assistant' ? 'Henry' : m.role === 'user' ? 'You' : m.role;
    const snippet = firstLine(m.content);
    if (!snippet) continue;
    lines.push(`- **${label}:** ${snippet}`);
  }

  const summary = lines.join('\n').trim();
  const tokenCount = Math.max(1, Math.ceil(summary.length / 4));
  return {
    summary,
    messageCount: messages.length,
    tokenCount,
  };
}

export function recentTranscriptWindowSize(): number {
  return HENRY_MEMORY_CAPS.maxRecentMessagesInTranscript;
}
