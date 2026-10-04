import { create } from 'zustand';

export type AmbientStateValue =
  | 'idle'
  | 'ready'
  | 'listening'
  | 'thinking'
  | 'responding'
  | 'muted'
  | 'blocked'
  | 'reconnect_needed'
  | 'focused';

interface AmbientStore {
  state: AmbientStateValue;
  activeBrain: string | null;
  sessionActive: boolean;
  presenceExpanded: boolean;
  isMuted: boolean;
  _idleTimer: ReturnType<typeof setTimeout> | null;

  setState: (s: AmbientStateValue) => void;
  setActiveBrain: (brain: string | null) => void;
  startSession: () => void;
  endSession: () => void;
  toggleExpanded: () => void;
  toggleMuted: () => void;
}

const IDLE_TIMEOUT_MS = 90_000;

export const useAmbientStore = create<AmbientStore>((set, get) => ({
  state: 'idle',
  activeBrain: null,
  sessionActive: false,
  presenceExpanded: false,
  isMuted: false,
  _idleTimer: null,

  setState: (s: AmbientStateValue) => {
    if (get().isMuted && s !== 'muted') return;

    const prev = get()._idleTimer;
    if (prev) clearTimeout(prev);

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (s === 'ready') {
      timer = setTimeout(() => {
        const cur = get().state;
        if (cur === 'ready') set({ state: 'idle', _idleTimer: null });
      }, IDLE_TIMEOUT_MS);
    }

    set({ state: s, _idleTimer: timer });
  },

  setActiveBrain: (activeBrain) => set({ activeBrain }),

  startSession: () => set({ sessionActive: true }),

  endSession: () => {
    const prev = get()._idleTimer;
    if (prev) clearTimeout(prev);
    set({ sessionActive: false, state: 'idle', _idleTimer: null });
  },

  toggleExpanded: () => set((s) => ({ presenceExpanded: !s.presenceExpanded })),

  toggleMuted: () => {
    const { isMuted } = get();
    if (!isMuted) {
      set({ isMuted: true, state: 'muted' });
    } else {
      set({ isMuted: false, state: 'ready' });
    }
  },
}));
