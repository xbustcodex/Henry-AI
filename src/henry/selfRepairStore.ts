/**
 * Henry AI — Self-Repair Store
 *
 * Tracks three classes of self-knowledge:
 *   1. errorLog        — runtime crashes + AI tool failures (auto-captured)
 *   2. lessonsLearned  — things Henry has explicitly noted as lessons
 *   3. constitutionOverrides — custom rules Henry has added at runtime
 *   4. personalityPatches    — traits Henry has updated at runtime
 *
 * All data lives in localStorage so it persists across sessions.
 * The charter reads this at prompt-build time and injects a self-repair block.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface CapturedError {
  id: string;
  type: 'runtime' | 'ai_failure' | 'tool_failure' | 'render_crash';
  message: string;
  stack?: string;
  component?: string;
  context?: string;
  severity: ErrorSeverity;
  capturedAt: string;
  resolved: boolean;
  resolution?: string;
}

export interface Lesson {
  id: string;
  content: string;
  category: 'behavior' | 'preference' | 'correction' | 'capability' | 'pattern';
  addedAt: string;
  sourceErrorId?: string;
}

export interface ConstitutionOverride {
  id: string;
  section: string;
  rule: string;
  addedAt: string;
  reason?: string;
}

export interface PersonalityPatch {
  id: string;
  trait: string;
  value: string;
  previous?: string;
  patchedAt: string;
  reason?: string;
}

// ── Storage keys ───────────────────────────────────────────────────────────────

const KEYS = {
  errors: 'henry:self_repair:errors:v1',
  lessons: 'henry:self_repair:lessons:v1',
  constitution: 'henry:self_repair:constitution:v1',
  personality: 'henry:self_repair:personality:v1',
} as const;

const MAX = { errors: 50, lessons: 30, constitution: 20, personality: 30 };

// ── Helpers ────────────────────────────────────────────────────────────────────

function load<T>(key: string): T[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    return JSON.parse(localStorage.getItem(key) || '[]') as T[];
  } catch { return []; }
}

function save(key: string, items: unknown[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(items));
  } catch { /* storage full */ }
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Error Log ──────────────────────────────────────────────────────────────────

export function logError(
  type: CapturedError['type'],
  message: string,
  opts: {
    stack?: string;
    component?: string;
    context?: string;
    severity?: ErrorSeverity;
  } = {}
): CapturedError {
  const entry: CapturedError = {
    id: uid(),
    type,
    message: message.slice(0, 500),
    stack: opts.stack?.slice(0, 1000),
    component: opts.component,
    context: opts.context?.slice(0, 300),
    severity: opts.severity ?? 'medium',
    capturedAt: new Date().toISOString(),
    resolved: false,
  };
  const all = load<CapturedError>(KEYS.errors);
  save(KEYS.errors, [entry, ...all].slice(0, MAX.errors));
  return entry;
}

export function getRecentErrors(limit = 10): CapturedError[] {
  return load<CapturedError>(KEYS.errors).slice(0, limit);
}

export function getUnresolvedErrors(): CapturedError[] {
  return load<CapturedError>(KEYS.errors).filter((e) => !e.resolved);
}

export function resolveError(id: string, resolution?: string): void {
  const all = load<CapturedError>(KEYS.errors).map((e) =>
    e.id === id ? { ...e, resolved: true, resolution } : e
  );
  save(KEYS.errors, all);
}

export function clearErrors(): void {
  save(KEYS.errors, []);
}

// ── Lessons Learned ────────────────────────────────────────────────────────────

export function addLesson(
  content: string,
  category: Lesson['category'] = 'pattern',
  opts: { sourceErrorId?: string } = {}
): Lesson {
  const entry: Lesson = {
    id: uid(),
    content: content.slice(0, 400),
    category,
    addedAt: new Date().toISOString(),
    sourceErrorId: opts.sourceErrorId,
  };
  const all = load<Lesson>(KEYS.lessons);
  save(KEYS.lessons, [entry, ...all].slice(0, MAX.lessons));
  return entry;
}

export function getLessons(): Lesson[] {
  return load<Lesson>(KEYS.lessons);
}

export function removeLesson(id: string): void {
  save(KEYS.lessons, load<Lesson>(KEYS.lessons).filter((l) => l.id !== id));
}

// ── Constitution Overrides ─────────────────────────────────────────────────────

export function addConstitutionOverride(
  section: string,
  rule: string,
  reason?: string
): ConstitutionOverride {
  const entry: ConstitutionOverride = {
    id: uid(),
    section: section.slice(0, 100),
    rule: rule.slice(0, 500),
    addedAt: new Date().toISOString(),
    reason,
  };
  const all = load<ConstitutionOverride>(KEYS.constitution);
  save(KEYS.constitution, [entry, ...all].slice(0, MAX.constitution));
  return entry;
}

export function getConstitutionOverrides(): ConstitutionOverride[] {
  return load<ConstitutionOverride>(KEYS.constitution);
}

export function removeConstitutionOverride(id: string): void {
  save(KEYS.constitution, load<ConstitutionOverride>(KEYS.constitution).filter((c) => c.id !== id));
}

// ── Personality Patches ────────────────────────────────────────────────────────

export function patchPersonality(trait: string, value: string, reason?: string): PersonalityPatch {
  const all = load<PersonalityPatch>(KEYS.personality);
  const existing = all.find((p) => p.trait.toLowerCase() === trait.toLowerCase());
  const entry: PersonalityPatch = {
    id: existing?.id ?? uid(),
    trait: trait.slice(0, 80),
    value: value.slice(0, 300),
    previous: existing?.value,
    patchedAt: new Date().toISOString(),
    reason,
  };
  const updated = existing
    ? all.map((p) => (p.id === existing.id ? entry : p))
    : [entry, ...all].slice(0, MAX.personality);
  save(KEYS.personality, updated);
  return entry;
}

export function getPersonalityPatches(): PersonalityPatch[] {
  return load<PersonalityPatch>(KEYS.personality);
}

export function removePersonalityPatch(id: string): void {
  save(KEYS.personality, load<PersonalityPatch>(KEYS.personality).filter((p) => p.id !== id));
}

// ── Charter Block ──────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<Lesson['category'], string> = {
  behavior: 'Behavior',
  preference: 'Preference',
  correction: 'Correction',
  capability: 'Capability',
  pattern: 'Pattern',
};

/**
 * Builds the self-repair context block injected into the system prompt.
 * Surfaces unresolved errors, lessons, constitution overrides, and personality patches.
 * Only injects when there is something meaningful to surface.
 */
export function buildSelfRepairBlock(): string {
  const lessons = getLessons().slice(0, 8);
  const overrides = getConstitutionOverrides().slice(0, 6);
  const patches = getPersonalityPatches().slice(0, 6);
  const unresolvedErrors = getUnresolvedErrors().slice(0, 3);

  const parts: string[] = [];

  if (unresolvedErrors.length > 0) {
    const lines = unresolvedErrors.map(
      (e) => `- [${e.type.replace('_', ' ')} — ${e.severity}] ${e.message}` +
        (e.component ? ` (in ${e.component})` : '')
    );
    parts.push(`## Unresolved Errors\nThese errors have been caught but not yet fixed — be aware of them:\n${lines.join('\n')}`);
  }

  if (lessons.length > 0) {
    const lines = lessons.map(
      (l) => `- [${CATEGORY_LABELS[l.category]}] ${l.content}`
    );
    parts.push(`## Lessons You've Learned\nThings you've noted as permanent lessons from past interactions:\n${lines.join('\n')}`);
  }

  if (overrides.length > 0) {
    const lines = overrides.map(
      (c) => `- [${c.section}] ${c.rule}${c.reason ? ` (reason: ${c.reason})` : ''}`
    );
    parts.push(`## Your Custom Rules\nRules you have added to your own operating constitution:\n${lines.join('\n')}`);
  }

  if (patches.length > 0) {
    const lines = patches.map(
      (p) => `- [${p.trait}] ${p.value}`
    );
    parts.push(`## Your Personality Adjustments\nTraits you have consciously updated about yourself:\n${lines.join('\n')}`);
  }

  if (parts.length === 0) return '';

  return `## Self-Knowledge — Your Living Record\nThis section is maintained by you across sessions. It reflects what you've learned, corrected, and decided about yourself.\n\n${parts.join('\n\n')}`;
}
