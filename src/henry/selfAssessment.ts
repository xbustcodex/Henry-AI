/**
 * Henry Self-Assessment Engine
 *
 * Henry tracks what he can't do, what breaks, what users ask for,
 * and what they actually use — then reports it clearly.
 *
 * This is the "feedback loop" layer:
 *   User asks for X → Henry can't do it → logged as gap
 *   Gap accumulates → Henry surfaces it → dev (Claude) builds it
 *
 * Henry can also assess his own health: error rates, panel crashes,
 * most-used features, and things users keep trying that fail.
 */

const GAPS_KEY = 'henry:feature_gaps';
const PREFS_KEY = 'henry:learned_prefs';
const USAGE_KEY = 'henry:usage_counts';
const CORRECTIONS_KEY = 'henry:corrections';

export interface FeatureGap {
  id: string;
  query: string;           // what the user asked
  failReason: string;      // why Henry couldn't do it
  count: number;           // how many times asked
  firstSeen: string;
  lastSeen: string;
}

export interface LearnedPref {
  key: string;
  value: string;
  source: 'correction' | 'explicit' | 'inferred';
  savedAt: string;
}

// ── Gap tracking ─────────────────────────────────────────────────────────────

export function logFeatureGap(query: string, reason: string): void {
  try {
    const gaps: FeatureGap[] = JSON.parse(localStorage.getItem(GAPS_KEY) || '[]');
    const existing = gaps.find(g => g.query.toLowerCase() === query.toLowerCase());
    if (existing) {
      existing.count++;
      existing.lastSeen = new Date().toISOString();
    } else {
      gaps.push({
        id: crypto.randomUUID(),
        query: query.slice(0, 200),
        failReason: reason,
        count: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      });
    }
    // Keep top 50 most frequent
    gaps.sort((a, b) => b.count - a.count);
    localStorage.setItem(GAPS_KEY, JSON.stringify(gaps.slice(0, 50)));
  } catch { /* ignore */ }
}

export function getTopGaps(n = 10): FeatureGap[] {
  try {
    const gaps: FeatureGap[] = JSON.parse(localStorage.getItem(GAPS_KEY) || '[]');
    return gaps.sort((a, b) => b.count - a.count).slice(0, n);
  } catch { return []; }
}

// ── Usage tracking ───────────────────────────────────────────────────────────

export function trackUsage(feature: string): void {
  try {
    const counts: Record<string, number> = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
    counts[feature] = (counts[feature] || 0) + 1;
    localStorage.setItem(USAGE_KEY, JSON.stringify(counts));
  } catch { /* ignore */ }
}

export function getUsageStats(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
  } catch { return {}; }
}

// ── Preference learning ───────────────────────────────────────────────────────

export function learnPref(key: string, value: string, source: LearnedPref['source'] = 'inferred'): void {
  try {
    const prefs: LearnedPref[] = JSON.parse(localStorage.getItem(PREFS_KEY) || '[]');
    const idx = prefs.findIndex(p => p.key === key);
    const pref: LearnedPref = { key, value, source, savedAt: new Date().toISOString() };
    if (idx >= 0) prefs[idx] = pref;
    else prefs.push(pref);
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

export function getLearnedPrefs(): LearnedPref[] {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '[]');
  } catch { return []; }
}

// ── Correction logging ────────────────────────────────────────────────────────

export function logCorrection(original: string, correction: string): void {
  try {
    const corrections: Array<{original:string;correction:string;at:string}> =
      JSON.parse(localStorage.getItem(CORRECTIONS_KEY) || '[]');
    corrections.unshift({ original: original.slice(0, 200), correction: correction.slice(0, 200), at: new Date().toISOString() });
    localStorage.setItem(CORRECTIONS_KEY, JSON.stringify(corrections.slice(0, 30)));
  } catch { /* ignore */ }
}

// ── Self-assessment report ────────────────────────────────────────────────────

export function buildSelfReport(): string {
  const gaps = getTopGaps(5);
  const usage = getUsageStats();
  const prefs = getLearnedPrefs();

  const topFeatures = Object.entries(usage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const lines: string[] = ['**Henry Self-Assessment**\n'];

  if (topFeatures.length) {
    lines.push('**Most used features:**');
    topFeatures.forEach(([f, n]) => lines.push(`  • ${f}: ${n}×`));
    lines.push('');
  }

  if (gaps.length) {
    lines.push('**Things I still can\'t do (most requested):**');
    gaps.forEach(g => lines.push(`  • "${g.query}" — ${g.count}× asked (${g.failReason})`));
    lines.push('');
    lines.push('These gaps have been logged. The dev will see them next build session.');
  } else {
    lines.push('No logged feature gaps yet — everything asked so far I\'ve handled.');
  }

  if (prefs.length) {
    lines.push('\n**What I\'ve learned about your preferences:**');
    prefs.slice(0, 5).forEach(p => lines.push(`  • ${p.key}: ${p.value}`));
  }

  return lines.join('\n');
}
