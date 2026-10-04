/**
 * Henry AI — Priority Engine Types
 * Shared types for the priority system.
 */

/** How urgent/important something is right now. */
export type PriorityCategory =
  | 'urgent_now'       // needs attention immediately
  | 'important_soon'   // matters within hours or today
  | 'active_focus'     // currently being worked on / highly relevant
  | 'background'       // relevant context, not pressing
  | 'parked'           // acknowledged, intentionally deferred
  | 'resolved';        // done / no longer needs surfacing

/** Where this item came from. */
export type PrioritySource =
  | 'reminder'
  | 'task'
  | 'project'
  | 'capture'
  | 'list'
  | 'commitment'
  | 'relationship'
  | 'personal_memory'
  | 'workspace_note'
  | 'computer'
  | 'conversation';

/** Raw scoring signals — each contributes weighted points. */
export interface PrioritySignals {
  isOverdue?: boolean;
  dueWithinMs?: number;         // how soon it's due (0 = now)
  isExplicitUrgent?: boolean;   // user flagged urgent
  mentionCount?: number;        // times mentioned or referenced
  isUnresolved?: boolean;       // no completion / still open
  hasActiveProject?: boolean;   // tied to an in-flight project
  recencyMs?: number;           // how recent (smaller = newer)
  hasConnectedContext?: boolean;// linked to a connected service
  hasComputerContext?: boolean; // active app / file match
  isBlockingOther?: boolean;    // other work depends on this
  emotionalWeight?: number;     // 0–1 inferred intensity (light touch)
}

/** A single scored, categorized priority item. */
export interface PriorityItem {
  id: string;
  title: string;
  source: PrioritySource;
  category: PriorityCategory;
  /** 0–100 composite score. Higher = more important now. */
  score: number;
  signals: PrioritySignals;
  /** Optional short plain-language note about why it's prioritized. */
  context?: string;
  dueAt?: number;
  raw?: any;
}

/** The full output of one engine run. */
export interface PrioritySnapshot {
  takenAt: number;
  mode: PriorityMode;
  /** All items sorted by score descending. */
  items: PriorityItem[];
  /** The single most important thing right now. */
  topFocus: PriorityItem | null;
  /** Top 3 items to have in focus. */
  top3: PriorityItem[];
  /** Category buckets for easy access. */
  urgentNow: PriorityItem[];
  importantSoon: PriorityItem[];
  activeFocus: PriorityItem[];
  background: PriorityItem[];
  deferred: PriorityItem[];
  /** What Henry should surface proactively in conversation. Max 3. */
  surfaceNow: PriorityItem[];
  /** Items that are real but don't need to be mentioned. */
  keepQuiet: PriorityItem[];
}

/**
 * User-selectable priority mode — affects how scoring is weighted.
 * calm: de-emphasizes urgency signals, prefers steady flow
 * balanced: neutral weighting (default)
 * urgency: amplifies time-pressure signals
 */
export type PriorityMode = 'calm' | 'balanced' | 'urgency';

export const PRIORITY_MODE_KEY = 'henry:priority_mode';
