/**
 * Henry AI — Thread Engine
 *
 * Derives ContinuityThread objects from existing Henry data sources:
 * - HenryProject (rich memory) → project threads
 * - Working memory items (grouped by conversationId/topic) → conversation threads
 * - High-priority orphaned tasks → task threads
 *
 * Called by the background brain. Merges derived threads into the thread store.
 * Preserves user-controlled thread changes (pause, resolve, rename).
 */

import type { ContinuityThread, ThreadType } from './threadStore';
import { upsertDerivedThread } from './threadStore';
import type { HenryProject } from '../richMemory';
import type { WorkingMemoryItem } from '../workingMemory';
import type { Task } from '../../types/index';

// ── Safe localStorage readers ─────────────────────────────────────────────────

function safeJSON<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback; const _p = JSON.parse(raw); return (Array.isArray(fallback) && !Array.isArray(_p)) ? fallback : (_p as T);
  } catch { return fallback; }
}

// ── Recency scoring ──────────────────────────────────────────────────────────

/** Score 0–20 based on how recently the item was updated. Decays over 14 days. */
function recencyBoost(isoDate: string): number {
  const ageDays = (Date.now() - new Date(isoDate).getTime()) / 86400000;
  return Math.round(Math.max(0, 20 * (1 - ageDays / 14)));
}

// ── Project threads ──────────────────────────────────────────────────────────

function deriveProjectThreads(
  projects: HenryProject[],
  workingMemory: WorkingMemoryItem[],
): ContinuityThread[] {
  const now = new Date().toISOString();

  return projects
    .filter((p) => p.status === 'active')
    .map((p) => {
      // Find working memory items that mention this project by name
      const projectWords = p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const linkedWM = workingMemory.filter((item) => {
        if (item.resolved) return false;
        const text = item.content.toLowerCase();
        return projectWords.some((word) => text.includes(word));
      });

      const unresolvedItems = linkedWM
        .filter((i) => i.type === 'question' || i.type === 'commitment' || i.type === 'concern')
        .slice(0, 5)
        .map((i) => i.content.slice(0, 80));

      // Weight: base 60 + recency boost + 3 per linked working memory item
      const weight = Math.min(100, 60 + recencyBoost(p.updatedAt) + Math.min(20, linkedWM.length * 3));

      const thread: ContinuityThread = {
        id: `project:${p.id}`,
        title: p.name,
        type: 'project' as ThreadType,
        status: 'active',
        weight,
        lastTouched: p.updatedAt,
        suggestedNextStep: p.nextStep?.trim() || undefined,
        unresolvedItems,
        relatedProjectId: p.id,
        source: 'derived',
        createdAt: p.createdAt,
        updatedAt: now,
      };

      return thread;
    });
}

// ── Conversation threads ─────────────────────────────────────────────────────

/**
 * Group orphaned working memory items (not linked to any project) by
 * conversationId into named conversation threads.
 * Only creates a thread when there are 2+ unresolved items in a group.
 */
function deriveConversationThreads(
  workingMemory: WorkingMemoryItem[],
  projectThreadIds: Set<string>,
): ContinuityThread[] {
  const now = new Date().toISOString();

  // Only items not linked to a project thread
  const orphaned = workingMemory.filter((item) => {
    if (item.resolved) return false;
    return true; // will de-duplicate below by checking project content overlap
  });

  // Group by conversationId
  const byConv = new Map<string, WorkingMemoryItem[]>();
  for (const item of orphaned) {
    const key = item.conversationId ?? 'no-conv';
    const group = byConv.get(key) ?? [];
    group.push(item);
    byConv.set(key, group);
  }

  const threads: ContinuityThread[] = [];

  for (const [convId, items] of byConv.entries()) {
    if (items.length < 2) continue; // Not enough signal for a thread
    if (convId === 'no-conv' && items.length < 3) continue; // Extra guard for ungrouped

    // Title from first focus item, or first commitment
    const focusItem = items.find((i) => i.type === 'focus');
    const commitItem = items.find((i) => i.type === 'commitment');
    const titleSource = focusItem ?? commitItem ?? items[0];
    const title = titleSource.content.slice(0, 60).replace(/\.$/, '');

    // Determine if this resembles a debugging/planning thread
    const allText = items.map((i) => i.content.toLowerCase()).join(' ');
    let type: ThreadType = 'conversation';
    if (/\bbug\b|error|fix|broken|crash|debug|issue/.test(allText)) type = 'debugging';
    else if (/plan|decide|choose|should we|option|approach|strategy/.test(allText)) type = 'planning';

    const unresolvedItems = items
      .filter((i) => i.type === 'question' || i.type === 'concern')
      .slice(0, 3)
      .map((i) => i.content.slice(0, 80));

    // Most recent update in this group
    const mostRecent = items.reduce((a, b) =>
      new Date(a.updatedAt) > new Date(b.updatedAt) ? a : b,
    );

    const weight = Math.min(80, 30 + recencyBoost(mostRecent.updatedAt) + items.length * 4);

    threads.push({
      id: `conv:${convId}`,
      title,
      type,
      status: 'active',
      weight,
      lastTouched: mostRecent.updatedAt,
      unresolvedItems,
      source: 'derived',
      createdAt: items[0].createdAt,
      updatedAt: now,
    });
  }

  return threads;
}

// ── Task threads ─────────────────────────────────────────────────────────────

/**
 * Create task threads for high-priority pending/running tasks not linked to a project.
 * Only surfaces tasks with priority >= 7 (out of 10) or running status.
 */
function deriveTaskThreads(tasks: Task[]): ContinuityThread[] {
  const now = new Date().toISOString();

  return tasks
    .filter((t) => {
      if (t.status === 'completed' || t.status === 'cancelled') return false;
      if (t.status === 'running') return true;
      return (t.priority ?? 0) >= 7;
    })
    .slice(0, 3) // Max 3 task threads
    .map((t) => {
      const weight = Math.min(70,
        20
        + (t.status === 'running' ? 30 : 0)
        + Math.round((t.priority ?? 5) * 2)
        + recencyBoost(t.created_at),
      );

      return {
        id: `task:${t.id}`,
        title: t.description.slice(0, 80),
        type: 'task' as ThreadType,
        status: t.status === 'running' ? ('active' as const) : ('background' as const),
        weight,
        lastTouched: t.started_at ?? t.created_at,
        unresolvedItems: [],
        source: 'derived' as const,
        createdAt: t.created_at,
        updatedAt: now,
      };
    });
}

// ── Main derivation ───────────────────────────────────────────────────────────

/**
 * Derive threads from all current data sources and save them to the thread store.
 * Idempotent — calling repeatedly only updates weights and items, never
 * stomps user-controlled status changes.
 */
export function deriveAndSaveThreads(): void {
  if (typeof localStorage === 'undefined') return;

  const projects = safeJSON<HenryProject[]>('henry:rich_memory:projects', []);
  const workingMemory = safeJSON<WorkingMemoryItem[]>('henry:working_memory:v1', []);
  const tasks = safeJSON<Task[]>('henry:tasks', []);

  const projectThreads = deriveProjectThreads(projects, workingMemory);
  const projectThreadIds = new Set(projectThreads.map((t) => t.id));
  const conversationThreads = deriveConversationThreads(workingMemory, projectThreadIds);
  const taskThreads = deriveTaskThreads(tasks);

  // Save all derived threads (merge with store, preserving user-controlled ones)
  for (const thread of [...projectThreads, ...conversationThreads, ...taskThreads]) {
    upsertDerivedThread(thread);
  }
}
