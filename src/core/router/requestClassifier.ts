/**
 * Henry AI — Request Classifier
 *
 * Classifies an incoming user message into a `RequestClass`.
 * More detailed than the contextTier intent classifier (which is integration-focused).
 * Drives brain assignment, execution mode, and context tier in the Brain Router.
 *
 * Classification is purely pattern-based — no LLM call, no async, instant.
 */

import type { RequestClass } from './routerTypes';

// ── Pattern maps ───────────────────────────────────────────────────────────

const PATTERNS: Array<{ class: RequestClass; re: RegExp; priority: number }> = [
  // ── Identity / self-description (high priority — before general chat)
  {
    class: 'identity',
    re: /\b(who are you|what are you|what can you do|tell me about yourself|describe yourself|what('?s| is) henry|are you aware|how can you help|what services|what (are|do) you (know|have access|see|track)|what('?s| is) (your|henry'?s?) capabilit|what('?s| is) connected)\b/i,
    priority: 90,
  },

  // ── Computer control
  {
    class: 'computer',
    re: /\b(run (a |the )?(command|script|shell|terminal)|execute (a |the )?command|open (app|application|terminal|finder|chrome|safari|vscode|slack)|screenshot|take a (screen|photo|picture)|type (this|that|into)|click (on|the|at)|applescript|press (enter|tab|escape|cmd|ctrl|shift)|open url|launch|start up|kill (the |a )?process)\b/i,
    priority: 85,
  },

  // ── Note capture
  {
    class: 'note_capture',
    re: /\b(remember (this|that)|note (this|that)|add (this|that) to (my |the )?(list|notes?|tasks?|backlog)|capture (this|that)|make a note|log this|save this|don'?t forget|file this|store this)\b/i,
    priority: 80,
  },

  // ── Memory recall
  {
    class: 'memory_recall',
    re: /\b(do you remember|what did (we|i|you) (say|talk|discuss|decide|agree)|recall|look (it|this) up in (memory|notes?|history)|what('?s| is) in (my |the )?memory|what have (i|we) discussed|past (conversation|session|thread)|last time (we|i)|previously you said|earlier (we|you))\b/i,
    priority: 80,
  },

  // ── Reflection / review
  {
    class: 'reflection',
    re: /\b(weekly review|what('?s| is) been happening|how('?s| is) (it|this|everything) going|drift|what (have i|have we) been working on|review (my|the|this) week|am i on track|what am i (missing|avoiding|drifting from)|what should (i|we) (reflect on|revisit)|summarize (my|the) (week|month|progress|work)|big picture|zoom out)\b/i,
    priority: 80,
  },

  // ── Relationship / commitment
  {
    class: 'relationship',
    re: /\b(commitment|follow.?up|promised|owe (me|you|them|him|her)|relationship|people|person|contact|who (did i|have i) (promise|say|tell|commit)|what did i (say|promise|tell) (to |about )?\w+|check in (with|on)|reach out|send (to|a) message to \w+)\b/i,
    priority: 75,
  },

  // ── Integration — specific services (before generic 'action')
  {
    class: 'integration',
    re: /\b(email|gmail|inbox|mail|calendar|schedule|event|meeting|appointment|slack|channel|github|repo|pull request|\bpr\b|git issue|notion|stripe|payment|charge|revenue|linear|ticket|sprint|google (drive|docs|sheets|calendar|meet)|send (a |an )?(message|email|slack))\b/i,
    priority: 70,
  },

  // ── Explicit action requests (write, send, create, book, delete)
  {
    class: 'action',
    re: /\b(send (it|this|that|the email|the message|the file)|create (a |an |the )?|book (a |an |the )?|schedule (a |an |the )?|delete (this|that|the)|publish|post (this|that)|submit|add to|move (this|that|the)|assign|close (this|that|the)|update (this|that)|make a (reservation|booking|appointment))\b/i,
    priority: 65,
  },

  // ── Writing / drafting
  {
    class: 'writing',
    re: /\b(write (a|an|the|me|this|that)|draft|compose|rewrite|revise|edit|polish|improve the (writing|text|copy|draft)|help (me |with )?(write|draft|compose)|rephrase|reword|make (this|it) (sound|read)|writing)\b/i,
    priority: 60,
  },

  // ── Planning / prioritization
  {
    class: 'planning',
    re: /\b(plan|prioritize|prioritise|what should (i|we) (do|focus|work on)|next steps?|roadmap|strategy|what('?s| is) most important|what matters (most|now)|what('?s| is) (the )?(priority|highest priority|top priority)|help me (plan|figure out|decide|think through)|where should (i|we) start|what('?s| is) blocking)\b/i,
    priority: 55,
  },

  // ── Debugging / system problem
  {
    class: 'debugging',
    re: /\b(not working|broken|error|bug|crash|fix (this|that|the|it)|something('?s| is) wrong|why (is|isn'?t|doesn'?t|won'?t)|can'?t (connect|reach|access|load|open|find)|failed|timeout|issue (with|in)|problem (with|in)|debug|troubleshoot)\b/i,
    priority: 50,
  },
];

/**
 * Classify a user message into a `RequestClass`.
 *
 * Uses pattern matching only — no async, no LLM, ~0ms cost.
 * When multiple patterns match, the highest-priority one wins.
 */
export function classifyRequest(message: string): RequestClass {
  const trimmed = message.trim();

  let bestClass: RequestClass = 'conversation';
  let bestPriority = -1;

  for (const { class: cls, re, priority } of PATTERNS) {
    if (priority > bestPriority && re.test(trimmed)) {
      bestClass = cls;
      bestPriority = priority;
    }
  }

  return bestClass;
}

// ── Derived helpers ────────────────────────────────────────────────────────

/**
 * True when the request class implies an action is being attempted
 * (not just a question about whether something can be done).
 */
export function isActionIntent(cls: RequestClass): boolean {
  return cls === 'action' || cls === 'integration' || cls === 'computer';
}

/**
 * True when the action appears to be a write/destructive operation
 * (send, delete, create, post) vs a read (show, list, check).
 */
export function isDestructiveAction(message: string): boolean {
  return /\b(send|delete|remove|post|publish|submit|book|create|overwrite|replace|clear|wipe|reset)\b/i.test(message)
    && !/\b(can you|could you|would you|should i|how (do i|can i)|what (if|would))\b/i.test(message);
}

/**
 * Extract the integration service name a message likely targets.
 * Returns null if no service is identifiable.
 */
export function extractTargetService(message: string): string | null {
  const lc = message.toLowerCase();
  if (/\b(gmail|email|inbox|mail)\b/.test(lc)) return 'gmail';
  if (/\b(calendar|gcal|google calendar|event|meeting|appointment|schedule)\b/.test(lc)) return 'gcal';
  if (/\bslack\b/.test(lc)) return 'slack';
  if (/\b(github|repo|pull request|\bpr\b|git issue)\b/.test(lc)) return 'github';
  if (/\bnotion\b/.test(lc)) return 'notion';
  if (/\b(stripe|payment|charge|invoice)\b/.test(lc)) return 'stripe';
  if (/\b(linear|ticket|sprint|backlog)\b/.test(lc)) return 'linear';
  return null;
}
