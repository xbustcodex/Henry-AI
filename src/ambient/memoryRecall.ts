/**
 * Henry AI — Ambient Memory Recall
 *
 * Reads from all ambient routing destination buckets in localStorage
 * and provides:
 *   - `buildAmbientMemoryBlock()` → markdown block injected into system prompts
 *   - `getAmbientItems(dest, limit)` → recent items for UI display
 *
 * This is the retrieval side of the note routing system. The write side
 * lives in noteRouter.ts / capturesStore.ts. Nothing here does any writes.
 *
 * Key design: lightweight context injection — only the last few items from
 * each non-empty bucket, kept short so they don't crowd the prompt.
 */

import type { RouteDest } from './noteRouter';

// ── Storage keys (must match noteRouter.ts ROUTE_KEYS) ───────────────────────

const BUCKET_KEYS: Partial<Record<RouteDest, string>> = {
  personal_memory: 'henry:ambient:memory',
  workspace:       'henry:ambient:workspace',
  project:         'henry:ambient:project',
  journal:         'henry:ambient:journal',
  tasks:           'henry:ambient:tasks',
  saved:           'henry:ambient:saved',
  // 'reminders' handled by reminders.ts
  // 'chat' is live — no recall needed
};

const BUCKET_LABELS: Partial<Record<RouteDest, string>> = {
  personal_memory: 'Personal notes',
  workspace:       'Workspace notes',
  project:         'Project notes',
  journal:         'Journal entries',
  tasks:           'Captured tasks',
  saved:           'Saved notes',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AmbientItem {
  id: string;
  text: string;
  createdAt: string;
}

// ── Core reads ────────────────────────────────────────────────────────────────

/** Read items from a specific routing destination bucket. */
export function getAmbientItems(dest: RouteDest, limit = 20): AmbientItem[] {
  const key = BUCKET_KEYS[dest];
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items.slice(0, limit) : [];
  } catch {
    return [];
  }
}

/** Get the total count of items in a bucket. */
export function getAmbientCount(dest: RouteDest): number {
  const key = BUCKET_KEYS[dest];
  if (!key) return 0;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return 0;
  }
}

/** Delete a single item from a bucket by id. */
export function removeAmbientItem(dest: RouteDest, id: string): void {
  const key = BUCKET_KEYS[dest];
  if (!key) return;
  try {
    const items = getAmbientItems(dest, 200);
    const updated = items.filter((i) => i.id !== id);
    localStorage.setItem(key, JSON.stringify(updated));
  } catch { /* ignore */ }
}

// ── System prompt block ───────────────────────────────────────────────────────

/**
 * Build a compact markdown block summarizing ambient captured notes
 * for injection into Henry's system prompt.
 *
 * Only includes the 3 most recent items per non-empty bucket.
 * Keeps total output small — this supplements long-term memory,
 * it doesn't replace the conversation context.
 *
 * Returns empty string if there's nothing worth injecting.
 */
export function buildAmbientMemoryBlock(): string {
  const sections: string[] = [];

  for (const [dest, key] of Object.entries(BUCKET_KEYS) as [RouteDest, string][]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const items: AmbientItem[] = JSON.parse(raw);
      if (!Array.isArray(items) || items.length === 0) continue;

      const recent = items.slice(0, 3);
      const label = BUCKET_LABELS[dest] ?? dest;
      const lines = recent.map((item) => {
        const age = formatAge(item.createdAt);
        return `  - ${item.text.slice(0, 140)}${item.text.length > 140 ? '…' : ''} (${age})`;
      });
      sections.push(`**${label}:**\n${lines.join('\n')}`);
    } catch { /* skip corrupt bucket */ }
  }

  if (sections.length === 0) return '';

  return `## Ambient Captures — Things the user has noted recently
These are short notes the user captured while thinking out loud. Use them as light context — don't force them into every response, but draw on them when relevant:
${sections.join('\n\n')}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAge(isoString: string): string {
  try {
    const diff = Date.now() - new Date(isoString).getTime();
    if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    const days = Math.floor(diff / 86_400_000);
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  } catch {
    return 'recently';
  }
}
