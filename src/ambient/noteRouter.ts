/**
 * Henry AI — Ambient Note Router
 *
 * Classifies captured speech/text into a category, then routes it to the
 * right destination (reminders, memory, workspace, journal, chat, etc.).
 *
 * Classification is pattern-based — fast, offline, no AI call needed.
 * Each incoming note is matched against priority-ordered patterns.
 *
 * Routing destinations feed into existing Henry systems:
 *   reminder       → reminders.ts (saveReminder)
 *   personal_memory → rich_memory localStorage
 *   workspace_note  → workspace_captures localStorage
 *   project_note    → project_captures localStorage
 *   journal         → journal_captures localStorage
 *   task            → task_captures localStorage
 *   chat_input      → sendToHenry (chatBridgeStore)
 *   general_note    → general_captures localStorage
 */

import { saveReminder, type Reminder } from '../henry/reminders';
import { sendToHenry } from '../actions/store/chatBridgeStore';

// ── Note Categories ───────────────────────────────────────────────────────────

export type NoteCategory =
  | 'reminder'
  | 'task'
  | 'workspace_note'
  | 'project_note'
  | 'personal_memory'
  | 'journal'
  | 'chat_input'
  | 'general_note';

export const NOTE_CATEGORY_LABELS: Record<NoteCategory, string> = {
  reminder:        'Reminder',
  task:            'Task',
  workspace_note:  'Workspace Note',
  project_note:    'Project Note',
  personal_memory: 'Personal Memory',
  journal:         'Journal',
  chat_input:      'Send to Henry',
  general_note:    'General Note',
};

export const NOTE_CATEGORY_ICONS: Record<NoteCategory, string> = {
  reminder:        '🔔',
  task:            '📋',
  workspace_note:  '🗂️',
  project_note:    '📐',
  personal_memory: '🧠',
  journal:         '📔',
  chat_input:      '💬',
  general_note:    '📝',
};

// ── Route destination labels ──────────────────────────────────────────────────

export type RouteDest =
  | 'reminders'
  | 'personal_memory'
  | 'workspace'
  | 'project'
  | 'journal'
  | 'tasks'
  | 'chat'
  | 'saved';

export const ROUTE_DEST_LABELS: Record<RouteDest, string> = {
  reminders:       'Reminders',
  personal_memory: 'Personal Memory',
  workspace:       'Workspace',
  project:         'Project Notes',
  journal:         'Journal',
  tasks:           'Tasks',
  chat:            'Henry Chat',
  saved:           'Saved',
};

// ── Classification patterns (priority order) ──────────────────────────────────

interface ClassifyRule {
  category: NoteCategory;
  patterns: RegExp[];
}

const CLASSIFY_RULES: ClassifyRule[] = [
  {
    category: 'reminder',
    patterns: [
      /\b(remind me|don't forget|remember to|set a reminder|alert me|notify me)\b/i,
      /\btomorrow\b.*\bremind\b/i,
      /\bat \d+.*(am|pm)/i,
    ],
  },
  {
    category: 'chat_input',
    patterns: [
      /\b(tell|message|send|let)\b.*(slack|henry|team|them|him|her)\b/i,
      /^henry[,!? ]/i,
      /\bhey henry\b/i,
    ],
  },
  {
    category: 'personal_memory',
    patterns: [
      /\b(remember that I|I prefer|I like|my preference|I always|I never|I tend to|I believe|I feel)\b/i,
      /\bimportant to remember\b/i,
      /\bkeep in mind that\b/i,
    ],
  },
  {
    category: 'journal',
    patterns: [
      /\b(journal|reflecting|reflection|processing|today I|I've been thinking|I feel|I felt|emotionally|gratitude|grateful)\b/i,
      /\bwrite this down\b/i,
    ],
  },
  {
    category: 'project_note',
    patterns: [
      /\b(project note|add to (the )?project|roadmap|feature idea|product idea|belongs in the project)\b/i,
      /\b(design decision|architecture|we should build|we could build)\b/i,
    ],
  },
  {
    category: 'workspace_note',
    patterns: [
      /\b(workspace note|work note|add to workspace|for the workspace|note for (the )?team)\b/i,
      /\boffice note\b/i,
    ],
  },
  {
    category: 'task',
    patterns: [
      /\b(todo|to-do|to do|task|need to|have to|must|I should|action item|follow up|follow-up)\b/i,
      /\bget (this|that) done\b/i,
    ],
  },
];

/**
 * Classify a text string into a NoteCategory.
 * Pattern-based, runs synchronously, no API calls.
 */
export function classifyNote(text: string): NoteCategory {
  const lower = text.toLowerCase().trim();
  for (const rule of CLASSIFY_RULES) {
    if (rule.patterns.some((p) => p.test(lower))) {
      return rule.category;
    }
  }
  return 'general_note';
}

/**
 * Returns the default routing destination for a note category.
 */
export function defaultDestForCategory(category: NoteCategory): RouteDest {
  const map: Record<NoteCategory, RouteDest> = {
    reminder:        'reminders',
    task:            'tasks',
    workspace_note:  'workspace',
    project_note:    'project',
    personal_memory: 'personal_memory',
    journal:         'journal',
    chat_input:      'chat',
    general_note:    'saved',
  };
  return map[category];
}

// ── localStorage route keys ───────────────────────────────────────────────────

const ROUTE_KEYS: Record<RouteDest, string> = {
  reminders:       'henry:reminders',       // handled by saveReminder()
  personal_memory: 'henry:ambient:memory',
  workspace:       'henry:ambient:workspace',
  project:         'henry:ambient:project',
  journal:         'henry:ambient:journal',
  tasks:           'henry:ambient:tasks',
  chat:            '__chat__',              // handled by sendToHenry()
  saved:           'henry:ambient:saved',
};

interface SimpleCapture {
  id: string;
  text: string;
  createdAt: string;
}

function loadList(key: string): SimpleCapture[] {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}

function saveList(key: string, items: SimpleCapture[]) {
  try { localStorage.setItem(key, JSON.stringify(items)); } catch { /* ignore */ }
}

/**
 * Execute the routing for a note to a destination.
 * Returns true if routed successfully.
 */
export function executeRoute(text: string, dest: RouteDest): boolean {
  try {
    if (dest === 'chat') {
      sendToHenry(text);
      return true;
    }

    if (dest === 'reminders') {
      // Create a basic reminder due in 1 hour
      const dueAt = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16);
      const reminder: Reminder = {
        id: `rem_amb_${Date.now()}`,
        title: text.slice(0, 120),
        dueAt,
        repeat: 'none',
        category: 'personal',
        done: false,
        createdAt: new Date().toISOString(),
        notes: 'Captured by Henry ambient listener',
      };
      saveReminder(reminder);
      return true;
    }

    const key = ROUTE_KEYS[dest];
    if (!key) return false;

    const items = loadList(key);
    items.unshift({ id: `cap_${Date.now()}`, text, createdAt: new Date().toISOString() });
    saveList(key, items.slice(0, 200)); // cap at 200 items per destination
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-route a note based on its category.
 * Returns the destination it was routed to, or null if nothing obvious.
 * Only auto-routes for very high-confidence patterns.
 */
export function autoRoute(text: string, category: NoteCategory): RouteDest | null {
  // Only auto-route the highest-confidence categories
  const autoCategories: NoteCategory[] = ['reminder', 'chat_input'];
  if (!autoCategories.includes(category)) return null;

  const dest = defaultDestForCategory(category);
  const success = executeRoute(text, dest);
  return success ? dest : null;
}
