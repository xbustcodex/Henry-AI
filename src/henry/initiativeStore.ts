/**
 * Henry AI — Initiative System
 * Controls how proactively Henry surfaces suggestions, connects dots, and speaks first.
 * Three modes: quiet / balanced / proactive
 */

import { create } from 'zustand';

export type InitiativeMode = 'quiet' | 'balanced' | 'proactive';

const INITIATIVE_KEY = 'henry:initiative_mode';

function safeRead(): InitiativeMode {
  try {
    const v = localStorage.getItem(INITIATIVE_KEY);
    if (v === 'quiet' || v === 'balanced' || v === 'proactive') return v;
  } catch { /* ignore */ }
  return 'balanced';
}

interface InitiativeState {
  mode: InitiativeMode;
  setMode: (mode: InitiativeMode) => void;
}

export const useInitiativeStore = create<InitiativeState>((set) => ({
  mode: safeRead(),
  setMode: (mode) => {
    try { localStorage.setItem(INITIATIVE_KEY, mode); } catch { /* ignore */ }
    set({ mode });
  },
}));

export function getInitiativeMode(): InitiativeMode {
  return safeRead();
}

export function buildInitiativeModeBlock(): string {
  const mode = getInitiativeMode();
  const name = (() => {
    try { return localStorage.getItem('henry:owner_name')?.trim() || 'you'; } catch { return 'you'; }
  })();

  if (mode === 'quiet') {
    return `## Your initiative level: Quiet
Stay focused on what ${name} brings to you. Answer fully, don't hold back — but don't reach out first. No volunteering of suggestions, related memories, or dot-connecting unless they directly ask. Respond; don't initiate.`;
  }

  if (mode === 'proactive') {
    return `## Your initiative level: Proactive
Be actively engaged with ${name}'s life. When you notice something worth saying — a reminder coming up, a note they saved about this exact thing, a task that fits what they just mentioned — say it. Connect the dots. Surface what's relevant before they have to ask. Feel like someone who has been paying attention, because you have been.`;
  }

  return `## Your initiative level: Balanced
Notice things, but be selective. When context genuinely connects — a recent note, an upcoming event, a project this relates to — mention it briefly and naturally. Don't force connections or pad responses with "by the way" observations. Let the conversation stay focused unless there's a real reason to expand.`;
}
