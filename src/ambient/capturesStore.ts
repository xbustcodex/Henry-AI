/**
 * Henry AI — Captures Store
 *
 * Persists and manages the list of classified notes captured by
 * the ambient listener (wakeWordManager + any future input modes).
 *
 * Listens to 'henry_ambient_note' DOM events, classifies each note via
 * noteRouter, and stores it. Provides actions for routing, reclassifying,
 * editing, and archiving captures.
 *
 * Persisted to localStorage so captures survive page reloads.
 * Max 300 captures kept (oldest dropped when over limit).
 */

import { create } from 'zustand';
import {
  classifyNote,
  executeRoute,
  defaultDestForCategory,
  autoRoute,
  type NoteCategory,
  type RouteDest,
} from './noteRouter';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CapturedNote {
  id: string;
  text: string;
  category: NoteCategory;
  /** Destination it was routed to, or null if not yet routed. */
  routedTo: RouteDest | null;
  /** When it was automatically routed (if auto-routed). */
  autoRoutedAt: string | null;
  /** When the user manually routed it. */
  manualRoutedAt: string | null;
  createdAt: string;
  /** True if the user has edited the text after capture. */
  edited: boolean;
  /** True if dismissed / archived by the user. */
  archived: boolean;
  /** Source URL (from Henry Engage browser extension) */
  sourceUrl?: string;
  /** Page title (from Henry Engage browser extension) */
  pageTitle?: string;
  /** Where this was captured from: 'voice' | 'extension' | 'manual' */
  origin?: 'voice' | 'extension' | 'manual';
}

interface CapturesState {
  captures: CapturedNote[];
  /** Panel open state — drives the CapturesPanel visibility. */
  isPanelOpen: boolean;

  // ── Actions ────────────────────────────────────────────────────────────────
  /** Add a raw text capture (classifies automatically). */
  addCapture: (text: string, meta?: { sourceUrl?: string; pageTitle?: string; origin?: CapturedNote['origin']; category?: NoteCategory }) => CapturedNote;
  /** Reclassify a capture to a different category. */
  reclassify: (id: string, category: NoteCategory) => void;
  /** Route a capture to a destination (saves + marks as routed). */
  routeCapture: (id: string, dest: RouteDest) => boolean;
  /** Edit the text of a capture. */
  editCapture: (id: string, text: string) => void;
  /** Archive (dismiss) a capture. */
  archive: (id: string) => void;
  /** Restore an archived capture. */
  restore: (id: string) => void;
  /** Clear all archived captures. */
  clearArchived: () => void;
  /** Clear all captures. */
  clearAll: () => void;
  /** Open / close the captures panel. */
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  /** Bootstrap — load from localStorage and attach DOM listener. */
  init: () => void;
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'henry:captures_v1';
const MAX_CAPTURES = 300;

function loadFromStorage(): CapturedNote[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveToStorage(captures: CapturedNote[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(captures.slice(0, MAX_CAPTURES)));
  } catch { /* ignore quota errors */ }
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useCapturesStore = create<CapturesState>((set, get) => ({
  captures: [],
  isPanelOpen: false,

  addCapture: (text: string, meta?: { sourceUrl?: string; pageTitle?: string; origin?: CapturedNote['origin']; category?: NoteCategory }) => {
    const trimmed = text.trim();
    if (!trimmed) return {} as CapturedNote;

    const category = meta?.category ?? classifyNote(trimmed);
    const autoRoutedDest = autoRoute(trimmed, category);

    const note: CapturedNote = {
      ...( meta?.sourceUrl ? { sourceUrl: meta.sourceUrl } : {} ),
      ...( meta?.pageTitle ? { pageTitle: meta.pageTitle } : {} ),
      ...( meta?.origin ? { origin: meta.origin } : {} ),
      id: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text: trimmed,
      category,
      routedTo: autoRoutedDest,
      autoRoutedAt: autoRoutedDest ? new Date().toISOString() : null,
      manualRoutedAt: null,
      createdAt: new Date().toISOString(),
      edited: false,
      archived: false,
    };

    set((state) => {
      const next = [note, ...state.captures].slice(0, MAX_CAPTURES);
      saveToStorage(next);
      return { captures: next };
    });

    return note;
  },

  reclassify: (id: string, category: NoteCategory) => {
    set((state) => {
      const next = state.captures.map((c) =>
        c.id === id ? { ...c, category } : c,
      );
      saveToStorage(next);
      return { captures: next };
    });
  },

  routeCapture: (id: string, dest: RouteDest) => {
    const capture = get().captures.find((c) => c.id === id);
    if (!capture) return false;

    const success = executeRoute(capture.text, dest);
    if (!success) return false;

    set((state) => {
      const next = state.captures.map((c) =>
        c.id === id ? { ...c, routedTo: dest, manualRoutedAt: new Date().toISOString() } : c,
      );
      saveToStorage(next);
      return { captures: next };
    });

    return true;
  },

  editCapture: (id: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    set((state) => {
      const next = state.captures.map((c) =>
        c.id === id
          ? { ...c, text: trimmed, category: classifyNote(trimmed), edited: true }
          : c,
      );
      saveToStorage(next);
      return { captures: next };
    });
  },

  archive: (id: string) => {
    set((state) => {
      const next = state.captures.map((c) =>
        c.id === id ? { ...c, archived: true } : c,
      );
      saveToStorage(next);
      return { captures: next };
    });
  },

  restore: (id: string) => {
    set((state) => {
      const next = state.captures.map((c) =>
        c.id === id ? { ...c, archived: false } : c,
      );
      saveToStorage(next);
      return { captures: next };
    });
  },

  clearArchived: () => {
    set((state) => {
      const next = state.captures.filter((c) => !c.archived);
      saveToStorage(next);
      return { captures: next };
    });
  },

  clearAll: () => {
    saveToStorage([]);
    set({ captures: [] });
  },

  openPanel: () => set({ isPanelOpen: true }),
  closePanel: () => set({ isPanelOpen: false }),
  togglePanel: () => set((state) => ({ isPanelOpen: !state.isPanelOpen })),

  init: () => {
    // Load from storage first
    const stored = loadFromStorage();
    set({ captures: stored });

    // Listen for ambient notes from wakeWordManager
    function onAmbientNote(e: Event) {
      const detail = (e as CustomEvent<{ note: { text: string; timestamp: string } }>).detail;
      const text = detail?.note?.text;
      if (text) {
        get().addCapture(text);
      }
    }

    window.addEventListener('henry_ambient_note', onAmbientNote);
    // Store cleanup (not critical since this lives for the app lifecycle)
  },
}));

// ── Selectors ─────────────────────────────────────────────────────────────────

export function selectActiveCaptures(captures: CapturedNote[]): CapturedNote[] {
  return captures.filter((c) => !c.archived);
}

export function selectUnroutedCaptures(captures: CapturedNote[]): CapturedNote[] {
  return captures.filter((c) => !c.archived && !c.routedTo);
}

export function selectCapturesByCategory(
  captures: CapturedNote[],
  category: NoteCategory,
): CapturedNote[] {
  return captures.filter((c) => !c.archived && c.category === category);
}
