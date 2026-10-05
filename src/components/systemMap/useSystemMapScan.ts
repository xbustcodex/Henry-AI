/**
 * The scan lifecycle, shared by the onboarding stage and the Settings panel.
 *
 * Both surfaces do the same four things — start a scan with a reviewed
 * exclusion set, watch its progress, let it be cancelled, and land on a
 * terminal state. Written twice, the two copies would drift within a week and
 * one of them would end up inferring completion from a silent progress channel
 * or forgetting to unsubscribe. So there is one implementation.
 *
 * Three terminal states, all explicit:
 *
 *   - `completed` — a map exists; `contents` is set.
 *   - `cancelled` — the user stopped it. The partial map is *not* half-saved;
 *     `contents` stays null, because a truncated inventory presented as a real
 *     one is worse than no inventory.
 *   - `failed`    — the scanner said why, and `error` carries the sentence.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelSystemMapScan,
  onSystemMapProgress,
  startSystemMapScan,
  type SystemMapContents,
  type SystemMapExclusions,
  type SystemMapScanProgress,
} from '../../henry/systemMap';

export type SystemMapScanPhase = 'idle' | 'scanning' | 'completed' | 'cancelled' | 'failed';

export interface SystemMapScanState {
  phase: SystemMapScanPhase;
  progress: SystemMapScanProgress | null;
  contents: SystemMapContents | null;
  error: string | null;
}

const IDLE: SystemMapScanState = {
  phase: 'idle',
  progress: null,
  contents: null,
  error: null,
};

export function useSystemMapScan() {
  const [state, setState] = useState<SystemMapScanState>(IDLE);

  // A scan outlives a navigation away from the screen that started it. Without
  // this the terminal state would land on an unmounted component and the
  // Settings panel would come back to `idle` with a finished map it never read.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(
    () =>
      onSystemMapProgress((progress) => {
        if (!live.current) return;
        setState((prev) => (prev.phase === 'scanning' ? { ...prev, progress } : prev));
      }),
    [],
  );

  const start = useCallback(async (exclusions: SystemMapExclusions) => {
    setState({ phase: 'scanning', progress: null, contents: null, error: null });
    const outcome = await startSystemMapScan(exclusions);
    if (!live.current) return;
    if (outcome.status === 'completed') {
      setState({ phase: 'completed', progress: null, contents: outcome.contents, error: null });
    } else if (outcome.status === 'cancelled') {
      setState({ phase: 'cancelled', progress: null, contents: null, error: null });
    } else {
      setState({ phase: 'failed', progress: null, contents: null, error: outcome.error });
    }
  }, []);

  const cancel = useCallback(async () => {
    await cancelSystemMapScan();
    // The scanner's own `cancelled` outcome is authoritative and may arrive a
    // moment later; this only stops the UI claiming to still be scanning.
    if (!live.current) return;
    setState((prev) =>
      prev.phase === 'scanning'
        ? { phase: 'cancelled', progress: null, contents: null, error: null }
        : prev,
    );
  }, []);

  /** Return to the pre-scan state, keeping no trace of a cancelled attempt. */
  const reset = useCallback(() => {
    if (live.current) setState(IDLE);
  }, []);

  return { ...state, start, cancel, reset };
}