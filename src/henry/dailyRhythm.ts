/**
 * Henry AI — Daily Rhythm System
 *
 * Henry understands the time-shape of the day and week.
 * Rhythm is inferred from time of day + day of week. No storage needed.
 *
 * morning_setup — orient, review, prepare, choose focus
 * focus_block   — deep work, execution, building, progress
 * admin_window  — logistics, inbox, scheduling, cleanup
 * meeting_prep  — prepare for an upcoming event (time-bound)
 * evening_review — close loops, reflect, save progress
 * weekly_reset  — reorient across projects and priorities (Monday AM)
 */

export type RhythmPhase =
  | 'morning_setup'
  | 'focus_block'
  | 'admin_window'
  | 'meeting_prep'
  | 'evening_review'
  | 'weekly_reset';

export interface RhythmState {
  phase: RhythmPhase;
  label: string;
  description: string;
}

// ── Phase inference ───────────────────────────────────────────────────────────

/**
 * Infer the current rhythm phase from local time.
 * Pure function — no side effects, no storage.
 */
export function inferRhythmPhase(now: Date = new Date()): RhythmPhase {
  const hour = now.getHours();
  const dayOfWeek = now.getDay(); // 0=Sunday, 1=Monday

  // Monday before 10am → weekly reset
  if (dayOfWeek === 1 && hour >= 5 && hour < 10) return 'weekly_reset';

  // 5am–9am → morning setup
  if (hour >= 5 && hour < 9) return 'morning_setup';

  // 9am–12pm → focus block (morning work)
  if (hour >= 9 && hour < 12) return 'focus_block';

  // 12pm–2pm → admin window (post-lunch logistics)
  if (hour >= 12 && hour < 14) return 'admin_window';

  // 2pm–6pm → focus block (afternoon work)
  if (hour >= 14 && hour < 18) return 'focus_block';

  // 6pm–9pm → evening review
  if (hour >= 18 && hour < 21) return 'evening_review';

  // Outside those hours (early morning, late night) → focus block as default
  return 'focus_block';
}

const PHASE_META: Record<RhythmPhase, { label: string; description: string }> = {
  morning_setup:  { label: 'Morning Setup',   description: 'Orient, review priorities, choose today\'s focus' },
  focus_block:    { label: 'Focus Block',      description: 'Deep work in progress' },
  admin_window:   { label: 'Admin Window',     description: 'Logistics, inbox, tasks, cleanup' },
  meeting_prep:   { label: 'Meeting Prep',     description: 'Preparing for an upcoming event' },
  evening_review: { label: 'Evening Review',   description: 'Closing loops, reflecting, winding down' },
  weekly_reset:   { label: 'Weekly Reset',     description: 'Reorienting across projects and priorities' },
};

export function getRhythmState(now?: Date): RhythmState {
  const phase = inferRhythmPhase(now);
  return { phase, ...PHASE_META[phase] };
}

// ── System Prompt Block ───────────────────────────────────────────────────────

const PHASE_BLOCKS: Record<RhythmPhase, string> = {
  morning_setup: `## Daily Rhythm: Morning Setup
Help ground the day, not overwhelm it. Surface top priorities, what's due today, and the active thread. Offer to set a clear focus. Keep it calm and orienting.`,

  focus_block: `## Daily Rhythm: Focus Block
Deep work is underway. Minimize noise. Emphasize the active thread and top priorities. Surface blockers and essential context only. Help maintain momentum.`,

  admin_window: `## Daily Rhythm: Admin Window
This is a logistics window. Surface tasks, reminders, calendar, and inbox signals. Emphasize quick wins and clearing the backlog. Be practical and concise.`,

  meeting_prep: `## Daily Rhythm: Meeting Prep
Help prepare for an upcoming event or conversation. Surface related notes, files, and context quickly. Be efficient and summary-focused.`,

  evening_review: `## Daily Rhythm: Evening Review
Wind-down time. Surface unfinished items and loose ends. Help close loops naturally. Support reflection without urgency. Offer to capture any loose thoughts.`,

  weekly_reset: `## Daily Rhythm: Weekly Reset
Start of a new week. Help review active projects, unresolved threads, and what carried over. Help choose a clear focus for the week. Keep it perspective-oriented, not task-list heavy.`,
};

export function buildRhythmBlock(now?: Date): string {
  if (typeof window === 'undefined') return '';
  const phase = inferRhythmPhase(now);
  return PHASE_BLOCKS[phase];
}
