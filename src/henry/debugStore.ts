/**
 * Henry AI — Debug Store
 *
 * Captures live operator-facing state for the debug panel:
 *   - last router decision (brain, execution mode, rationale, action gate)
 *   - actual provider/model used for the most recent completion
 *   - fallback status
 *   - token estimate
 *   - context tier reason
 *
 * Written by ChatView and read by HenryDebugPanel.
 * Zero overhead on the hot path — just a Zustand write.
 */

import { create } from 'zustand';
import type { RouterDecision } from '@/core/router/routerTypes';

export interface ActualModelUsed {
  role: 'companion' | 'worker';
  provider: string;
  model: string;
  isFallback: boolean;
}

export interface TokenSnapshot {
  /** Rough estimate of tokens sent in context */
  estimated: number;
  /** Whether the history was trimmed to fit the tier */
  historyTrimmed: boolean;
  /** Tier chosen for this request */
  tier: 'light' | 'medium' | 'full';
  /** One-line reason the tier was chosen */
  tierReason: string;
}

export interface DebugState {
  /** Last complete routing decision */
  lastDecision: RouterDecision | null;
  /** Actual model(s) used in the last response */
  lastModels: ActualModelUsed[];
  /** Token / context snapshot for the last request */
  lastTokens: TokenSnapshot | null;
  /** ISO timestamp of last update */
  updatedAt: string | null;

  setDecision: (d: RouterDecision) => void;
  setModels: (models: ActualModelUsed[]) => void;
  setTokens: (t: TokenSnapshot) => void;
  reset: () => void;
}

export const useDebugStore = create<DebugState>((set) => ({
  lastDecision: null,
  lastModels: [],
  lastTokens: null,
  updatedAt: null,

  setDecision: (d) => set({ lastDecision: d, updatedAt: new Date().toISOString() }),
  setModels: (models) => set({ lastModels: models }),
  setTokens: (t) => set({ lastTokens: t }),
  reset: () => set({ lastDecision: null, lastModels: [], lastTokens: null, updatedAt: null }),
}));
