/**
 * Henry Auto-Memory — extracts facts from conversation and saves them
 * to henry:facts without requiring the user to explicitly say "remember this".
 * Runs lightly after each assistant message, catches high-signal patterns.
 */

import { v4 as uuid } from 'uuid';

function safeGet<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}
function safeSet<T>(key: string, val: T): void {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
}

export interface AutoFact {
  id: string;
  content: string;
  source: 'auto' | 'manual';
  confidence: 'high' | 'medium';
  category: 'person' | 'project' | 'preference' | 'goal' | 'fact';
  extractedAt: string;
  conversationId?: string;
}

const PATTERNS: Array<{
  regex: RegExp;
  category: AutoFact['category'];
  confidence: AutoFact['confidence'];
  extract: (m: RegExpMatchArray) => string | null;
}> = [
  // "my client [name]" / "working with [name]"
  {
    regex: /my (?:client|customer)\s+(?:is\s+)?([A-Z][a-zA-Z\s]{2,30})/,
    category: 'person', confidence: 'high',
    extract: (m) => `Client: ${m[1].trim()}`,
  },
  // "I'm working on [project]" / "working on a project called"
  {
    regex: /(?:working on|building|developing)\s+(?:a\s+)?(?:project\s+(?:called\s+)?)?["']?([A-Z][a-zA-Z0-9\s]{2,40})["']?/,
    category: 'project', confidence: 'medium',
    extract: (m) => `Project: ${m[1].trim()}`,
  },
  // "remember that..." / "note that..."
  {
    regex: /(?:remember|note|keep in mind)\s+that\s+(.{10,120})/i,
    category: 'fact', confidence: 'high',
    extract: (m) => m[1].trim(),
  },
  // "I prefer..." / "I always..."
  {
    regex: /I (?:prefer|always|usually|tend to|like to)\s+(.{8,80})/,
    category: 'preference', confidence: 'medium',
    extract: (m) => `Preference: ${m[1].trim()}`,
  },
  // "my goal is..." / "I want to..."
  {
    regex: /my goal is\s+(.{10,100})/i,
    category: 'goal', confidence: 'high',
    extract: (m) => `Goal: ${m[1].trim()}`,
  },
];

const DEDUP_THRESHOLD = 0.8; // similarity threshold to skip duplicates

function roughSimilarity(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const bWords = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = [...aWords].filter(w => bWords.has(w)).length;
  const union = new Set([...aWords, ...bWords]).size;
  return union === 0 ? 0 : intersection / union;
}

export function extractAutoFacts(
  userMessage: string,
  conversationId?: string
): AutoFact[] {
  const found: AutoFact[] = [];

  for (const p of PATTERNS) {
    const match = userMessage.match(p.regex);
    if (!match) continue;
    const content = p.extract(match);
    if (!content || content.length < 8) continue;

    found.push({
      id: uuid(),
      content,
      source: 'auto',
      confidence: p.confidence,
      category: p.category,
      extractedAt: new Date().toISOString(),
      conversationId,
    });
  }

  return found;
}

export function saveAutoFacts(facts: AutoFact[]): void {
  if (!facts.length) return;
  const existing = safeGet<AutoFact[]>('henry:facts', []);

  let added = 0;
  for (const fact of facts) {
    // Dedup check
    const isDuplicate = existing.some(e =>
      roughSimilarity(e.content, fact.content) > DEDUP_THRESHOLD
    );
    if (!isDuplicate) {
      existing.push(fact);
      added++;
    }
  }

  if (added > 0) {
    safeSet('henry:facts', existing);
  }
}

export function runAutoMemory(userMessage: string, conversationId?: string): void {
  try {
    const facts = extractAutoFacts(userMessage, conversationId);
    if (facts.length === 0) return;

    // 1. Save to localStorage (web mode / fast path)
    saveAutoFacts(facts);

    // 2. Also persist to SQLite via IPC so buildContext can surface them
    if (typeof window !== 'undefined' && (window as any).henryAPI?.saveFact) {
      for (const fact of facts) {
        (window as any).henryAPI.saveFact({
          conversation_id: conversationId ?? null,
          fact: fact.content,
          category: fact.category,
          importance: fact.confidence === 'high' ? 3 : 2,
        }).catch(() => { /* non-critical */ });
      }
    }
  } catch {
    // Never crash the main chat flow
  }
}
