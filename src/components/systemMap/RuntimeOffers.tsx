/**
 * Agent runtimes the scan turned up — offered, never applied.
 *
 * ── The one rule this component exists to enforce ───────────────────────────
 *
 * Finding agent software on this machine is an *offer*, not a configuration.
 * `discoverAgentRuntimes()` is read-only by contract and returns the user's
 * existing selection untouched; `selectAgentRuntime()` is the only writer in the
 * whole codebase, and it is called from exactly one place below — the handler
 * for the button the user pressed.
 *
 * So: nothing is selected on mount, on refresh, or because a runtime happened
 * to be installed before onboarding ran. A user who has chosen no external
 * runtime keeps having chosen none until they press "Use this runtime".
 * Acceptance is a deliberate, per-runtime, reversible act, and the button is
 * labelled so that it reads as the decision it is.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  discoverAgentRuntimes,
  selectAgentRuntime,
  type DiscoveredRuntime,
} from '../../henry/agentRuntimes';
import { StageCard, StageTextAction, STAGE_PROSE_LEADING } from '../onboarding/layout';

export default function RuntimeOffers() {
  const [offers, setOffers] = useState<DiscoveredRuntime[] | null>(null);
  const [accepted, setAccepted] = useState<{ id: string; name: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  /**
   * Look, then render — and read the selection as a *filter*, never as a value
   * to write. The rows below are what is installed and not already chosen.
   */
  const load = useCallback(async () => {
    const res = await discoverAgentRuntimes();
    if (!res) return;
    setOffers(
      res.runtimes.filter((r) => r.available && r.id !== res.selectedRuntimeId),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = async (runtime: DiscoveredRuntime) => {
    setBusyId(runtime.id);
    setError(null);
    try {
      const res = await selectAgentRuntime(runtime.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Only after the write succeeded is anything called "in use".
      setAccepted({ id: runtime.id, name: runtime.displayName });
      setOffers((prev) => prev?.filter((r) => r.id !== runtime.id) ?? null);
    } finally {
      setBusyId(null);
    }
  };

  if (dismissed || !offers || offers.length === 0) return null;

  return (
    <StageCard label="AI software found on this computer">
      <div className="space-y-5">
        <p className={`text-sm text-henry-text-dim ${STAGE_PROSE_LEADING}`}>
          Henry found agent software installed on this machine. Using one is entirely your
          choice — nothing is switched on until you say so.
        </p>

        {error && (
          <p className="text-xs text-red-400">That could not be saved: {error}</p>
        )}

        {accepted && (
          <p className="text-xs text-emerald-400">Henry will use {accepted.name}.</p>
        )}

        <ul className="space-y-3">
          {offers.map((runtime) => (
            <li
              key={runtime.id}
              className="flex items-start justify-between gap-4 rounded-xl border border-henry-border/40 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm text-henry-text">{runtime.displayName}</p>
                {runtime.description && (
                  <p className={`text-xs text-henry-text-muted mt-1 ${STAGE_PROSE_LEADING}`}>
                    {runtime.description}
                  </p>
                )}
                {runtime.version && (
                  <p className="text-[11px] text-henry-text-muted font-mono mt-1 truncate">
                    {runtime.version}
                  </p>
                )}
              </div>
              <StageTextAction
                type="button"
                onClick={() => void accept(runtime)}
                disabled={busyId !== null}
                className="shrink-0 text-xs rounded-xl border border-henry-border/50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busyId === runtime.id ? 'Saving…' : 'Use this runtime'}
              </StageTextAction>
            </li>
          ))}
        </ul>

        <StageTextAction
          type="button"
          onClick={() => setDismissed(true)}
          className="text-xs text-henry-text-muted"
        >
          Not now — use no external runtime
        </StageTextAction>
      </div>
    </StageCard>
  );
}