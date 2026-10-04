/**
 * Henry Companion Sync Store
 *
 * Zustand slice for companion/sync state. Kept separate so it can be
 * imported only on mobile / companion paths without polluting the desktop
 * store bundle.
 */

import { create } from 'zustand';
import type {
  CompanionConnectionStatus,
  CompanionConnectionConfig,
  SyncSnapshot,
  PendingAction,
  SyncConversation,
  SyncMessage,
  SyncTask,
  SyncNote,
  DesktopStatus,
} from './types';

export interface SyncState {
  // Connection
  status: CompanionConnectionStatus;
  config: CompanionConnectionConfig | null;
  lastSyncAt: number | null;
  syncError: string | null;

  // Snapshot data
  conversations: SyncConversation[];
  activeConversationId: string | null;
  activeMessages: SyncMessage[];
  tasks: SyncTask[];
  notes: SyncNote[];
  desktopStatus: DesktopStatus | null;

  // Actions awaiting approval
  pendingActions: PendingAction[];

  // Capture state
  captureInFlight: boolean;

  // Actions
  setStatus: (status: CompanionConnectionStatus) => void;
  setConfig: (config: CompanionConnectionConfig | null) => void;
  setLastSyncAt: (ts: number) => void;
  setSyncError: (err: string | null) => void;
  applySnapshot: (snap: SyncSnapshot) => void;
  setActiveConversation: (id: string | null) => void;
  setActiveMessages: (msgs: SyncMessage[]) => void;
  addMessage: (msg: SyncMessage) => void;
  upsertTask: (task: SyncTask) => void;
  addNote: (note: SyncNote) => void;
  upsertNote: (note: SyncNote) => void;
  setPendingActions: (actions: PendingAction[]) => void;
  removeAction: (id: string) => void;
  setCaptureInFlight: (v: boolean) => void;
  setDesktopStatus: (status: DesktopStatus) => void;
  reset: () => void;
}

const initialState = {
  status: 'disconnected' as CompanionConnectionStatus,
  config: null,
  lastSyncAt: null,
  syncError: null,
  conversations: [],
  activeConversationId: null,
  activeMessages: [],
  tasks: [],
  notes: [],
  desktopStatus: null,
  pendingActions: [],
  captureInFlight: false,
};

export const useSyncStore = create<SyncState>((set) => ({
  ...initialState,

  setStatus: (status) => set({ status }),
  setConfig: (config) => set({ config }),
  setLastSyncAt: (lastSyncAt) => set({ lastSyncAt }),
  setSyncError: (syncError) => set({ syncError }),

  applySnapshot: (snap) =>
    set({
      conversations: snap.conversations,
      tasks: snap.tasks,
      notes: snap.notes,
      desktopStatus: snap.desktopStatus,
      pendingActions: snap.pendingActions,
      lastSyncAt: snap.timestamp,
    }),

  setActiveConversation: (id) =>
    set({ activeConversationId: id, activeMessages: [] }),

  setActiveMessages: (msgs) => set({ activeMessages: msgs }),

  addMessage: (msg) =>
    set((s) => ({ activeMessages: [...s.activeMessages, msg] })),

  upsertTask: (task) =>
    set((s) => {
      const exists = s.tasks.findIndex((t) => t.id === task.id);
      if (exists >= 0) {
        const updated = [...s.tasks];
        updated[exists] = task;
        return { tasks: updated };
      }
      return { tasks: [task, ...s.tasks] };
    }),

  addNote: (note) => set((s) => ({ notes: [note, ...s.notes] })),

  upsertNote: (note) =>
    set((s) => {
      const exists = s.notes.findIndex((n) => n.id === note.id);
      if (exists >= 0) {
        const updated = [...s.notes];
        updated[exists] = note;
        return { notes: updated };
      }
      return { notes: [note, ...s.notes] };
    }),

  setPendingActions: (pendingActions) => set({ pendingActions }),

  removeAction: (id) =>
    set((s) => ({
      pendingActions: s.pendingActions.filter((a) => a.id !== id),
    })),

  setCaptureInFlight: (captureInFlight) => set({ captureInFlight }),

  setDesktopStatus: (desktopStatus) => set({ desktopStatus }),

  reset: () => set(initialState),
}));
