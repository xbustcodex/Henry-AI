/**
 * Henry Memory Retrieval Engine — Client-side
 *
 * Formats the output of `memory:buildDeepContext` into system prompt blocks.
 * Implements the blueprint scoring formula:
 *   retrieval_score = (relevance * 0.30) + (recency * 0.20) +
 *                     (emotional * 0.15) + (strategic * 0.25) + (confidence * 0.10)
 *
 * Bandwidth modes:
 *   shallow  — minimal history, current session only, low token usage
 *   normal   — session + working memory + top personal memories (default)
 *   deep     — + projects, relationship memory, narrative arcs
 *   maximum  — + milestones, where-we-left-off, timeline, all unresolved threads
 */

export type MemoryBandwidth = 'shallow' | 'normal' | 'deep' | 'maximum';

// ── Scoring ───────────────────────────────────────────────────────────────────

export interface ScoredMemoryItem {
  label: string;
  value: string;
  score: number;
}

export function computeRetrievalScore(item: {
  relevance_score?: number;
  recency_score?: number;
  emotional_significance_score?: number;
  strategic_significance_score?: number;
  confidence_score?: number;
  created_at?: string;
  importance?: number;
}): number {
  const relevance  = item.relevance_score  ?? (item.importance ? item.importance / 10 : 0.5);
  const emotional  = item.emotional_significance_score ?? 0.3;
  const strategic  = item.strategic_significance_score ?? 0.5;
  const confidence = item.confidence_score ?? 0.7;

  // Recency: smooth decay over 90 days from created_at
  let recency = item.recency_score ?? 1.0;
  if (item.created_at) {
    const ageDays = (Date.now() - new Date(item.created_at).getTime()) / 86_400_000;
    recency = Math.max(0, 1 - ageDays / 90);
  }

  return (relevance  * 0.30)
       + (recency    * 0.20)
       + (emotional  * 0.15)
       + (strategic  * 0.25)
       + (confidence * 0.10);
}

// ── Context Formatter ─────────────────────────────────────────────────────────

export interface DeepContextFormatOptions {
  bandwidth: MemoryBandwidth;
  maxTokenBudget?: number;  // chars; default 16000
}

export interface FormattedDeepContext {
  systemBlock: string;
  bandwidth: MemoryBandwidth;
  estimatedChars: number;
  layerSummary: string[];
}

/**
 * Format the raw deep context object returned from `memory:buildDeepContext`
 * into a coherent system prompt block, respecting the bandwidth mode.
 */
export function formatDeepContext(
  ctx: Record<string, any>,
  opts: DeepContextFormatOptions,
): FormattedDeepContext {
  const { bandwidth, maxTokenBudget = 16_000 } = opts;
  const sections: string[] = [];
  const layerSummary: string[] = [];

  // ── Layer 2: Working memory (open commitments, active goals) ─────────
  const openCommitments: any[] = ctx.extended?.openCommitments ?? [];
  const activeGoals: any[] = ctx.extended?.activeGoals ?? [];

  if (openCommitments.length > 0) {
    const lines = openCommitments
      .slice(0, 8)
      .map((c: any) => `- ${c.description}`);
    sections.push(`## Open Commitments\n${lines.join('\n')}`);
    layerSummary.push(`${openCommitments.length} open commitment${openCommitments.length > 1 ? 's' : ''}`);
  }

  if (activeGoals.length > 0) {
    const lines = activeGoals
      .slice(0, 5)
      .map((g: any) => `- ${g.title}${g.summary ? `: ${g.summary.slice(0, 100)}` : ''}`);
    sections.push(`## Active Goals\n${lines.join('\n')}`);
    layerSummary.push(`${activeGoals.length} active goal${activeGoals.length > 1 ? 's' : ''}`);
  }

  // ── Layer 4: Personal memory (top scored) ────────────────────────────
  const personalMemory: any[] = ctx.extended?.personalMemory ?? [];
  if (personalMemory.length > 0 && bandwidth !== 'shallow') {
    const scored = personalMemory
      .map((p: any) => ({ ...p, _score: computeRetrievalScore(p) }))
      .sort((a: any, b: any) => b._score - a._score)
      .slice(0, bandwidth === 'normal' ? 8 : 15);

    const byType: Record<string, string[]> = {};
    for (const p of scored) {
      const t = (p.memory_type as string) || 'general';
      if (!byType[t]) byType[t] = [];
      byType[t].push(`${p.memory_key}: ${p.memory_value}`);
    }

    const typeLines: string[] = [];
    for (const [type, items] of Object.entries(byType)) {
      const label = type.replace(/_/g, ' ');
      typeLines.push(`**${label}**: ${items.slice(0, 3).join(' · ')}`);
    }

    if (typeLines.length > 0) {
      sections.push(`## Personal Memory\n${typeLines.join('\n')}`);
      layerSummary.push(`${personalMemory.length} personal memories`);
    }
  }

  // ── Layer 5: Active projects ──────────────────────────────────────────
  const activeProjects: any[] = ctx.extended?.activeProjects ?? [];
  if (activeProjects.length > 0 && (bandwidth === 'deep' || bandwidth === 'maximum')) {
    const lines = activeProjects.map((p: any) =>
      `- **${p.name}**${p.summary ? `: ${p.summary.slice(0, 120)}` : ''}`
    );
    sections.push(`## Active Projects\n${lines.join('\n')}`);
    layerSummary.push(`${activeProjects.length} active project${activeProjects.length > 1 ? 's' : ''}`);
  }

  // ── Layer 6: Relationship memory (support style) ──────────────────────
  const relationshipMemory: any[] = ctx.extended?.relationshipMemory ?? [];
  if (relationshipMemory.length > 0 && (bandwidth === 'deep' || bandwidth === 'maximum')) {
    const lines = relationshipMemory.map((r: any) =>
      `- ${r.pattern_type.replace(/_/g, ' ')}: ${r.summary}`
    );
    const ownerName = localStorage.getItem('henry:owner_name')?.trim() || 'the user';
    sections.push(`## How ${ownerName} Works Best\n${lines.join('\n')}`);
    layerSummary.push(`${relationshipMemory.length} relationship pattern${relationshipMemory.length > 1 ? 's' : ''}`);
  }

  // ── Layer 7: Narrative arcs ───────────────────────────────────────────
  const narrativeMemory: any[] = ctx.extended?.narrativeMemory ?? [];
  if (narrativeMemory.length > 0 && (bandwidth === 'deep' || bandwidth === 'maximum')) {
    const lines = narrativeMemory.map((n: any) =>
      `- **${n.arc_name}**: ${n.summary.slice(0, 150)}`
    );
    sections.push(`## Life & Work Arcs\n${lines.join('\n')}`);
    layerSummary.push(`${narrativeMemory.length} narrative arc${narrativeMemory.length > 1 ? 's' : ''}`);
  }

  // ── Maximum: Milestones + where-we-left-off + recent sessions ──────────
  if (bandwidth === 'maximum') {
    const recentMilestones: any[] = ctx.extended?.recentMilestones ?? [];
    if (recentMilestones.length > 0) {
      const lines = recentMilestones.map((m: any) =>
        `- [${m.milestone_type}] ${m.title}${m.summary ? `: ${m.summary.slice(0, 100)}` : ''}`
      );
      sections.push(`## Recent Milestones\n${lines.join('\n')}`);
      layerSummary.push(`${recentMilestones.length} milestone${recentMilestones.length > 1 ? 's' : ''}`);
    }

    const whereWeLeftOff: string | null = ctx.extended?.whereWeLeftOff ?? null;
    if (whereWeLeftOff) {
      sections.push(`## Where We Left Off\n${whereWeLeftOff}`);
      layerSummary.push('where-we-left-off summary');
    }

    const recentSessions: any[] = ctx.extended?.recentSessions ?? [];
    if (recentSessions.length > 0) {
      const sessionLines = recentSessions.slice(0, 2).map((s: any) =>
        `- ${s.summary}${s.emotional_pattern ? ` (${s.emotional_pattern})` : ''}`
      );
      sections.push(`## Recent Sessions\n${sessionLines.join('\n')}`);
    }
  }

  const systemBlock = sections.join('\n\n');
  const estimatedChars = systemBlock.length;

  // Truncate if over budget (remove last sections first)
  if (estimatedChars > maxTokenBudget) {
    const truncatedSections = [];
    let budget = maxTokenBudget;
    for (const s of sections) {
      if (s.length <= budget) {
        truncatedSections.push(s);
        budget -= s.length;
      }
    }
    return {
      systemBlock: truncatedSections.join('\n\n'),
      bandwidth,
      estimatedChars: truncatedSections.join('\n\n').length,
      layerSummary,
    };
  }

  return { systemBlock, bandwidth, estimatedChars, layerSummary };
}

// ── Where-We-Left-Off Formatter ───────────────────────────────────────────────

export function formatWhereWeLeftOff(data: {
  lastProject: string | null;
  openCommitments: { description: string; importance_score: number }[];
  activeGoals: { title: string; priority_score: number }[];
  recentSession: { summary: string; emotional_pattern: string | null } | null;
  lastWhereWeLeftOff: string | null;
  recentMilestone: { title: string; milestone_type: string } | null;
}): string {
  const parts: string[] = [];

  if (data.lastWhereWeLeftOff) {
    parts.push(data.lastWhereWeLeftOff);
  } else {
    if (data.lastProject) {
      parts.push(`Last active project: ${data.lastProject}`);
    }
    if (data.recentSession?.summary) {
      parts.push(`Last session: ${data.recentSession.summary}`);
    }
  }

  if (data.openCommitments.length > 0) {
    const items = data.openCommitments.slice(0, 3).map((c) => c.description).join('; ');
    parts.push(`Open commitments: ${items}`);
  }

  if (data.activeGoals.length > 0) {
    const goals = data.activeGoals.slice(0, 2).map((g) => g.title).join(', ');
    parts.push(`Active goals: ${goals}`);
  }

  if (data.recentMilestone) {
    parts.push(`Recent milestone: [${data.recentMilestone.milestone_type}] ${data.recentMilestone.title}`);
  }

  return parts.join('\n');
}

// ── Bandwidth Setting Helpers ─────────────────────────────────────────────────

const BANDWIDTH_KEY = 'henry:memory_bandwidth:v1';

export function getMemoryBandwidth(): MemoryBandwidth {
  try {
    const raw = localStorage.getItem(BANDWIDTH_KEY);
    if (raw === 'shallow' || raw === 'normal' || raw === 'deep' || raw === 'maximum') return raw;
  } catch { /* ignore */ }
  return 'normal';
}

export function setMemoryBandwidth(mode: MemoryBandwidth): void {
  try {
    localStorage.setItem(BANDWIDTH_KEY, mode);
  } catch { /* ignore */ }
}

// ── Personal memory type labels (human-readable) ──────────────────────────────

export const PERSONAL_MEMORY_TYPES = [
  'identity', 'preference', 'habit', 'value', 'frustration',
  'goal', 'timeline_anchor', 'style', 'business_interest',
  'decision', 'project', 'general',
] as const;

export type PersonalMemoryType = typeof PERSONAL_MEMORY_TYPES[number];

export const PERSONAL_MEMORY_TYPE_LABELS: Record<PersonalMemoryType, string> = {
  identity: 'Identity',
  preference: 'Preference',
  habit: 'Habit',
  value: 'Core value',
  frustration: 'Recurring frustration',
  goal: 'Goal',
  timeline_anchor: 'Life anchor',
  style: 'Style preference',
  business_interest: 'Business interest',
  decision: 'Decision made',
  project: 'Project note',
  general: 'General',
};

export const RELATIONSHIP_PATTERN_TYPES = [
  'encouragement_style', 'overwhelm_pattern', 'action_preference',
  'communication_preference', 'timing_preference', 'motivation_pattern',
] as const;

export const MILESTONE_TYPES = [
  'win', 'setback', 'launch', 'decision', 'realization', 'breakthrough', 'other',
] as const;
