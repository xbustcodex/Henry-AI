/**
 * Henry AI — Priority Sources
 * Reads raw data from every data store and converts each item into
 * a PriorityItem with signals populated. Scoring is done by the engine.
 */

import type { PriorityItem, PrioritySignals } from './priorityTypes';
import { loadOpenCommitments } from '../commitmentStore';
import { loadRelationships } from '../relationshipStore';

function safeJSON<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeGet(key: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
}

const now = () => Date.now();

// ── Reminders ──────────────────────────────────────────────────────────────

export function loadReminderItems(): PriorityItem[] {
  const reminders = safeJSON<any[]>('henry:reminders', []);
  const items: PriorityItem[] = [];
  const n = now();

  for (const r of reminders) {
    if (r.done || r.dismissed) continue;
    const title = r.title || r.content || '(reminder)';
    const dueAt = r.dueAt ? new Date(r.dueAt).getTime() : undefined;
    const isOverdue = dueAt != null && dueAt < n;
    const dueWithinMs = dueAt != null && dueAt >= n ? dueAt - n : undefined;
    const isExplicitUrgent = r.priority === 'urgent' || r.urgent === true;
    const recencyMs = r.createdAt ? n - new Date(r.createdAt).getTime() : undefined;

    const signals: PrioritySignals = {
      isOverdue,
      dueWithinMs,
      isExplicitUrgent,
      isUnresolved: true,
      recencyMs,
    };

    items.push({
      id: `reminder:${r.id || title}`,
      title,
      source: 'reminder',
      category: 'background',
      score: 0,
      signals,
      dueAt,
      context: isOverdue ? `Was due ${new Date(dueAt!).toLocaleDateString()}` : dueAt ? `Due ${new Date(dueAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` : undefined,
      raw: r,
    });
  }

  return items;
}

// ── Tasks ──────────────────────────────────────────────────────────────────

export function loadTaskItems(): PriorityItem[] {
  const tasks = safeJSON<any[]>('henry:tasks', []);
  const items: PriorityItem[] = [];
  const n = now();

  // Active projects for cross-referencing
  const projects = safeJSON<any[]>('henry:rich_memory:projects', []);
  const activeProjectNames = new Set(
    projects.filter((p) => p.status === 'active').map((p) => (p.name || '').toLowerCase())
  );

  for (const t of tasks) {
    if (t.status === 'done' || t.status === 'completed' || t.status === 'archived') continue;
    const title = t.title || t.content || '(task)';
    const dueAt = t.dueAt ? new Date(t.dueAt).getTime() : undefined;
    const isOverdue = dueAt != null && dueAt < n;
    const dueWithinMs = dueAt != null && dueAt >= n ? dueAt - n : undefined;
    const isExplicitUrgent = t.priority === 'urgent' || t.urgent === true;
    const recencyMs = t.created_at ? n - new Date(t.created_at).getTime() : t.createdAt ? n - new Date(t.createdAt).getTime() : undefined;

    // Check if this task is tied to an active project
    const hasActiveProject = activeProjectNames.size > 0 &&
      [...activeProjectNames].some((pn) => title.toLowerCase().includes(pn));

    const signals: PrioritySignals = {
      isOverdue,
      dueWithinMs,
      isExplicitUrgent,
      isUnresolved: true,
      hasActiveProject,
      recencyMs,
    };

    items.push({
      id: `task:${t.id || title}`,
      title,
      source: 'task',
      category: 'background',
      score: 0,
      signals,
      dueAt,
      raw: t,
    });
  }

  return items;
}

// ── Projects ───────────────────────────────────────────────────────────────

export function loadProjectItems(): PriorityItem[] {
  const projects = safeJSON<any[]>('henry:rich_memory:projects', []);
  const items: PriorityItem[] = [];
  const n = now();

  for (const p of projects) {
    if (p.status === 'completed' || p.status === 'archived' || p.status === 'paused') continue;
    const title = p.name || '(project)';
    const recencyMs = p.updatedAt ? n - new Date(p.updatedAt).getTime() : undefined;
    const isActive = p.status === 'active';
    const dueAt = p.deadline ? new Date(p.deadline).getTime() : undefined;
    const dueWithinMs = dueAt != null && dueAt >= n ? dueAt - n : undefined;
    const isOverdue = dueAt != null && dueAt < n;

    const signals: PrioritySignals = {
      isOverdue,
      dueWithinMs,
      isUnresolved: isActive,
      hasActiveProject: isActive,
      recencyMs,
    };

    items.push({
      id: `project:${p.id || title}`,
      title: `Project: ${title}`,
      source: 'project',
      category: 'background',
      score: 0,
      signals,
      dueAt,
      context: isActive ? 'In progress' : undefined,
      raw: p,
    });
  }

  return items;
}

// ── Ambient Captures ───────────────────────────────────────────────────────

export function loadCaptureItems(): PriorityItem[] {
  const captures = safeJSON<any[]>('henry:captures_v1', []);
  const items: PriorityItem[] = [];
  const n = now();

  for (const c of captures) {
    if (c.status === 'routed' || c.status === 'archived') continue;
    const title = (c.text || '').slice(0, 100) || '(captured note)';
    const recencyMs = c.capturedAt ? n - new Date(c.capturedAt).getTime() : undefined;
    const isExplicitUrgent = c.category === 'reminder' || c.autoRouted === true;

    const signals: PrioritySignals = {
      isUnresolved: true,
      isExplicitUrgent,
      recencyMs,
    };

    items.push({
      id: `capture:${c.id || title.slice(0, 20)}`,
      title: `Captured: "${title}"`,
      source: 'capture',
      category: 'background',
      score: 0,
      signals,
      context: c.category ? `Category: ${c.category}` : undefined,
      raw: c,
    });
  }

  return items;
}

// ── Workspace / Personal memory notes ─────────────────────────────────────

export function loadAmbientNoteItems(): PriorityItem[] {
  const items: PriorityItem[] = [];
  const n = now();

  const BUCKETS: { key: string; source: PriorityItem['source'] }[] = [
    { key: 'henry:ambient:tasks', source: 'workspace_note' },
    { key: 'henry:ambient:workspace', source: 'workspace_note' },
    { key: 'henry:ambient:project', source: 'workspace_note' },
    { key: 'henry:ambient:memory', source: 'personal_memory' },
  ];

  for (const { key, source } of BUCKETS) {
    const bucket = safeJSON<any[]>(key, []);
    for (const note of bucket.slice(0, 5)) {
      const title = (note.text || '').slice(0, 100) || '(note)';
      const recencyMs = note.timestamp ? n - note.timestamp : undefined;
      items.push({
        id: `ambient:${key}:${note.id || title.slice(0, 20)}`,
        title: `Note: "${title}"`,
        source,
        category: 'background',
        score: 0,
        signals: { isUnresolved: true, recencyMs },
        raw: note,
      });
    }
  }

  return items;
}

// ── Computer snapshot context ──────────────────────────────────────────────

export function loadComputerItems(): PriorityItem[] {
  const items: PriorityItem[] = [];
  const n = now();

  try {
    const raw = safeGet('henry:computer_snapshot');
    if (!raw) return items;
    const snap = JSON.parse(raw);
    const age = n - (snap.takenAt || 0);
    if (age > 60 * 60 * 1000) return items; // stale

    if (!snap.canAct && snap.blockedReason) {
      items.push({
        id: 'computer:blocked',
        title: `Computer: ${snap.blockedReason}`,
        source: 'computer',
        category: 'background',
        score: 0,
        signals: { hasComputerContext: true, recencyMs: age },
        context: 'Accessibility permission needed',
        raw: snap,
      });
    }

    if (snap.activeApp) {
      items.push({
        id: `computer:active:${snap.activeApp}`,
        title: `Active app: ${snap.activeApp}`,
        source: 'computer',
        category: 'background',
        score: 0,
        signals: { hasComputerContext: true, recencyMs: age },
        raw: snap,
      });
    }
  } catch { /* ignore */ }

  return items;
}

// ── Connected service context ──────────────────────────────────────────────

export function loadConnectedServiceItems(): PriorityItem[] {
  const items: PriorityItem[] = [];
  try {
    const connections = safeJSON<Record<string, any>>('henry:connections', {});
    const connected = Object.entries(connections)
      .filter(([, v]) => v?.status === 'connected')
      .map(([k]) => k);

    if (connected.length) {
      items.push({
        id: 'services:connected',
        title: `Connected services: ${connected.join(', ')}`,
        source: 'conversation',
        category: 'background',
        score: 0,
        signals: { hasConnectedContext: true },
      });
    }
  } catch { /* ignore */ }
  return items;
}

// ── Commitments ────────────────────────────────────────────────────────────

export function loadCommitmentItems(): PriorityItem[] {
  const items: PriorityItem[] = [];
  const n = now();

  // Only surface commitments with weight ≥ 7 (high-importance) into priority
  const highWeight = loadOpenCommitments().filter((c) => c.weight >= 7);

  for (const c of highWeight) {
    const dueAt = c.dueAt ? new Date(c.dueAt).getTime() : undefined;
    const isOverdue = dueAt != null && dueAt < n;
    const dueWithinMs = dueAt != null && dueAt >= n ? dueAt - n : undefined;
    const recencyMs = n - new Date(c.lastTouchedAt).getTime();
    const isBlocking = c.status === 'blocked';

    const signals: PrioritySignals = {
      isOverdue,
      dueWithinMs,
      isUnresolved: true,
      isBlockingOther: isBlocking,
      recencyMs,
      // Convert weight 7–10 into urgency signal
      isExplicitUrgent: c.weight >= 9,
    };

    const typeLabel = c.type === 'henry' ? 'Henry agreed' : c.type.charAt(0).toUpperCase() + c.type.slice(1);
    const statusNote = c.status === 'blocked' ? ` — blocked${c.blockedReason ? `: ${c.blockedReason}` : ''}` : c.status === 'waiting' ? ' — waiting' : '';

    items.push({
      id: `commitment:${c.id}`,
      title: c.title,
      source: 'commitment',
      category: isOverdue ? 'urgent_now' : c.weight >= 9 ? 'important_soon' : 'active_focus',
      score: 0,
      signals,
      dueAt,
      context: `${typeLabel} commitment${statusNote}`,
      raw: c,
    });
  }

  return items;
}

// ── Relationships ──────────────────────────────────────────────────────────

export function loadRelationshipItems(): PriorityItem[] {
  const items: PriorityItem[] = [];
  const n = now();

  // Only surface relationships with importance ≥ 6 and a pending follow-up
  const people = loadRelationships().filter((r) => r.followUpNeeded && r.importance >= 6);

  for (const r of people) {
    const daysSince = r.lastInteraction
      ? Math.round((n - new Date(r.lastInteraction).getTime()) / 86400000)
      : null;
    const isOverdue = daysSince !== null && daysSince > 7;
    const recencyMs = r.lastInteraction ? n - new Date(r.lastInteraction).getTime() : undefined;

    const signals: PrioritySignals = {
      isOverdue,
      isUnresolved: true,
      isExplicitUrgent: r.importance >= 9,
      recencyMs,
    };

    const contactNote = r.followUpNote ? ` — ${r.followUpNote}` : '';
    const contactAgo = daysSince !== null ? ` (last contact ${daysSince}d ago)` : '';

    items.push({
      id: `relationship:${r.id}`,
      title: `Follow up with ${r.name}${contactNote}`,
      source: 'relationship',
      category: isOverdue ? 'important_soon' : 'background',
      score: 0,
      signals,
      context: `${r.type} relationship${contactAgo}`,
      raw: r,
    });
  }

  return items;
}

// ── Continuity Threads ─────────────────────────────────────────────────────

/**
 * Converts active continuity threads into priority items.
 * Active threads with unresolved items become strong continuity signals.
 * Paused = low signal. Background = included but lower weight.
 */
export function loadThreadItems(): PriorityItem[] {
  const threads = safeJSON<any[]>('henry:continuity_threads:v1', []);
  const items: PriorityItem[] = [];
  const n = now();

  for (const t of threads) {
    if (t.status === 'done') continue;

    const recencyMs = t.lastTouched ? n - new Date(t.lastTouched).getTime() : undefined;
    const isActive = t.status === 'active';
    const isPaused = t.status === 'paused';
    const hasUnresolved = Array.isArray(t.unresolvedItems) && t.unresolvedItems.length > 0;
    const weight = typeof t.weight === 'number' ? t.weight : 30;

    // Paused threads with nothing unresolved: skip — not worth ranking
    if (isPaused && !hasUnresolved) continue;

    const signals: PrioritySignals = {
      isUnresolved: hasUnresolved,
      // Active thread with items = a blocking continuity signal
      isBlockingOther: isActive && hasUnresolved,
      hasActiveProject: isActive,
      recencyMs,
      // Threads with high engine weight are treated as explicit priority
      isExplicitUrgent: isActive && weight >= 80,
    };

    const typeLabel = t.type
      ? (t.type.charAt(0).toUpperCase() + t.type.slice(1))
      : 'Thread';
    const unresolvedNote = hasUnresolved
      ? ` — ${t.unresolvedItems.length} open item${t.unresolvedItems.length > 1 ? 's' : ''}`
      : '';

    items.push({
      id: `thread:${t.id}`,
      title: `Thread: "${(t.title ?? '').slice(0, 80)}"`,
      source: 'conversation',
      category: isActive ? 'active_focus' : 'background',
      score: 0, // scored by the engine
      signals,
      context: `${typeLabel}${unresolvedNote}`,
      raw: t,
    });
  }

  return items;
}

// ── Master loader ──────────────────────────────────────────────────────────

export function loadAllPrioritySources(): PriorityItem[] {
  return [
    ...loadReminderItems(),
    ...loadTaskItems(),
    ...loadProjectItems(),
    ...loadCaptureItems(),
    ...loadCommitmentItems(),
    ...loadRelationshipItems(),
    ...loadThreadItems(),
    ...loadAmbientNoteItems(),
    ...loadComputerItems(),
    ...loadConnectedServiceItems(),
  ];
}
