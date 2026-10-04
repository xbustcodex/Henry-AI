/**
 * Henry AI — Commitment Auto-Extractor
 *
 * Detects high-confidence commitment language in user and Henry messages
 * and auto-creates durable Commitment records without user friction.
 *
 * Rules:
 *  - Only fires on high-confidence patterns — no false positives tolerated
 *  - Max 2 new commitments extracted per message
 *  - Deduplicates against existing open commitments (60% word overlap check)
 *  - Never extracts questions or very short phrases
 *  - Runs silently — no UI feedback, no notification
 */

import {
  addCommitment,
  loadOpenCommitments,
  type CommitmentType,
} from './commitmentStore';

// ── Patterns ──────────────────────────────────────────────────────────────────

interface CommitmentPattern {
  re: RegExp;
  captureGroup: number; // which capture group is the commitment subject
}

/** User statements that express a personal commitment. */
const USER_PATTERNS: CommitmentPattern[] = [
  { re: /\bI(?:'m| am) going to\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI need to\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ve| have) committed to\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ve| have) promised (?:to |myself to )?(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ve| have) been meaning to\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI should(?:\s+remember)? to\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI want to make sure(?:\s+I)?\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ll| will) make sure to\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI have to\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
];

/** Henry statements that express an agreement or Henry-held commitment. */
const HENRY_PATTERNS: CommitmentPattern[] = [
  { re: /\bI(?:'ll| will) research\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ll| will) look into\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ll| will) help you (?:with |on |track )?(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ll| will) follow up (?:on|with|about)?\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ll| will) keep track (?:of )?(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ll| will) hold (?:that|this|it)?\s*(?:open|for you)?\s*(?:—|–|-|:)?\s*(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ll| will) make a note (?:of |to track )?(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bLet me track\s+(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
  { re: /\bI(?:'ll| will) remember (?:to |that )?(.{12,120}?)(?:[.!?;,\n]|$)/i, captureGroup: 1 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const QUESTION_STARTS = /^(who|what|when|where|why|how|whether|if|whether|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b/i;

/** Strip trailing filler from an extracted subject. */
function cleanSubject(raw: string): string {
  return raw
    .trim()
    // Remove trailing conjunctions / partial phrases
    .replace(/\s+(and|but|or|because|so|then|though|if|when|unless|until|that|which|who)\s*$/i, '')
    // Remove trailing punctuation except period which adds clarity
    .replace(/[,;:]$/, '')
    .trim();
}

/** Significant words for dedup (>3 chars, not stop words). */
const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'been', 'will', 'would', 'could', 'should', 'make', 'sure', 'going', 'need', 'want']);

function sigWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

function isSimilarToExisting(title: string): boolean {
  const words = sigWords(title);
  if (words.size === 0) return false;
  const existing = loadOpenCommitments();
  for (const c of existing) {
    const existingWords = sigWords(c.title);
    const overlap = [...words].filter((w) => existingWords.has(w)).length;
    const smaller = Math.min(words.size, existingWords.size);
    if (smaller > 0 && overlap / smaller >= 0.6) return true;
  }
  return false;
}

function tryExtract(text: string, patterns: CommitmentPattern[]): string[] {
  const subjects: string[] = [];
  for (const { re, captureGroup } of patterns) {
    if (subjects.length >= 2) break;
    const match = text.match(re);
    if (!match) continue;
    const raw = match[captureGroup]?.trim() ?? '';
    if (!raw || raw.length < 12) continue;
    const subject = cleanSubject(raw);
    if (!subject || subject.length < 10) continue;
    if (QUESTION_STARTS.test(subject)) continue;
    if (!isSimilarToExisting(subject)) {
      subjects.push(subject);
    }
  }
  return subjects;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan a user message for explicit personal commitments and auto-save them.
 * Called after each user message is processed.
 */
export function autoExtractUserCommitments(userText: string, _convId: string): void {
  if (typeof localStorage === 'undefined') return;
  if (userText.length < 15) return;

  const subjects = tryExtract(userText, USER_PATTERNS);
  for (const subject of subjects) {
    addCommitment(subject, 'personal', { weight: 5 });
  }
}

/**
 * Scan Henry's response for agreements and auto-save them as henry-type commitments.
 * Called after each Henry response completes.
 */
export function autoExtractHenryCommitments(henryText: string, _convId: string): void {
  if (typeof localStorage === 'undefined') return;
  if (henryText.length < 40) return;

  const subjects = tryExtract(henryText, HENRY_PATTERNS);
  for (const subject of subjects) {
    addCommitment(subject, 'henry', { weight: 6 });
  }
}
