/**
 * Agent runtimes — the panel where the user chooses an installed agent runtime.
 *
 * ── What this panel does and does not do ───────────────────────────────────
 *
 * It SHOWS what discovery found, including what was NOT found: a runtime that
 * is not installed appears as "not installed", never hidden and never implied to
 * be available. Where a runtime could report something for itself — its version,
 * whether it really lists models, how many — that is shown, and unverified
 * capabilities are labelled as unverified rather than rounded up to "yes".
 *
 * It only ever CHANGES anything when the user presses Use. That is the point of
 * the panel existing: discovery never auto-selects a runtime, so a user who has
 * not chosen one keeps having chosen none. Nothing here picks a default on
 * mount, on refresh, or because something new was installed.
 *
 * All of it goes through `src/henry/agentRuntimes`, which is IPC only — no
 * Node built-in reaches the renderer to answer "is this program installed?".
 */

import { useCallback, useEffect, useState } from 'react';
import {
  discoverAgentRuntimes,
  selectAgentRuntime,
  type DiscoveredRuntime,
} from '../../henry/agentRuntimes';
import { toast } from '../ui/Toast';

const cardCls = 'bg-henry-card border border-henry-border rounded-xl p-4';

/** One capability, described honestly. */
function CapabilityBadge({ verified, note }: { verified: boolean; note?: string }) {
  return (
    <span
      className={verified ? 'text-emerald-400' : 'text-henry-text-muted'}
      title={note}
    >
      {verified ? 'verified' : note ? 'not verified' : 'not checked'}
    </span>
  );
}

function RuntimeRow({
  runtime,
  selected,
  busy,
  onUse,
}: {
  runtime: DiscoveredRuntime;
  selected: boolean;
  busy: boolean;
  onUse: (id: string) => void;
}) {
  const { capabilities } = runtime;
  const unavailable = !runtime.available;

  return (
    <div className="rounded-lg border border-henry-border px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-henry-text truncate">
              {runtime.displayName}
            </span>
            {unavailable ? (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-henry-bg text-henry-text-muted">
                not installed
              </span>
            ) : (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                installed
              </span>
            )}
            {selected && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-henry-accent/15 text-henry-accent">
                in use
              </span>
            )}
          </div>

          {runtime.version && (
            <p className="text-[11px] text-henry-text-dim mt-1 font-mono truncate">
              {runtime.version}
            </p>
          )}
          {runtime.binaryPath && (
            <p className="text-[11px] text-henry-text-muted mt-0.5 font-mono truncate">
              {runtime.binaryPath}
            </p>
          )}
          {runtime.description && (
            <p className="text-[11px] text-henry-text-muted mt-1">{runtime.description}</p>
          )}

          {/* The reason a runtime is absent, in the user's terms. Omitting this
              row entirely would read as "we never looked". */}
          {unavailable && runtime.unavailableReason && (
            <p className="text-[11px] text-henry-text-muted mt-1.5 leading-relaxed">
              {runtime.unavailableReason}
            </p>
          )}

          {runtime.available && (
            <div className="text-[11px] text-henry-text-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
              <span>
                runs: <CapabilityBadge
                  verified={capabilities.run.verified}
                  note={capabilities.run.note}
                />
              </span>
              <span>
                models: <CapabilityBadge
                  verified={capabilities.listModels.verified}
                  note={capabilities.listModels.note}
                />
                {capabilities.modelCount != null && ` (${capabilities.modelCount} reachable)`}
              </span>
            </div>
          )}

          {runtime.authHint?.optional && (
            <p className="text-[11px] text-henry-text-muted mt-1">
              Works without a credential{runtime.authHint.envVar
                ? `; ${runtime.authHint.envVar} unlocks the rest.`
                : '.'}
            </p>
          )}
        </div>

        {runtime.available && (
          <button
            type="button"
            onClick={() => onUse(runtime.id)}
            disabled={busy || selected}
            className="shrink-0 text-xs px-3 py-1.5 rounded-md border border-henry-border text-henry-text hover:bg-henry-bg disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {selected ? 'Selected' : 'Use'}
          </button>
        )}
      </div>
    </div>
  );
}

export default function AgentRuntimePanel() {
  const [runtimes, setRuntimes] = useState<DiscoveredRuntime[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingModels, setCheckingModels] = useState(false);

  /**
   * Look, then render. Deliberately does NOT touch `selectedId` from what it
   * finds: the stored selection is what the user chose, and discovery cannot
   * change it. `selectedId` is only ever written by `use` below.
   */
  const load = useCallback(async (includeModels = false) => {
    const res = await discoverAgentRuntimes({ includeModels });
    if (!res) {
      setError('Agent runtime discovery is unavailable in this build.');
      return;
    }
    if (res.error) {
      setError(res.error);
      setRuntimes([]);
      return;
    }
    setError(null);
    setRuntimes(res.runtimes);
    setSelectedId(res.selectedRuntimeId);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const use = async (id: string) => {
    setBusy(true);
    try {
      const res = await selectAgentRuntime(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Only now, after the write succeeded, does the panel show it as chosen.
      setSelectedId(res.selectedRuntimeId);
      toast.success('Agent runtime saved');
    } finally {
      setBusy(false);
    }
  };

  const installed = (runtimes ?? []).filter((r) => r.available);
  const missing = (runtimes ?? []).filter((r) => !r.available);

  return (
    <div className={cardCls}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-henry-text">Agent runtimes</h3>
          <p className="text-[11px] text-henry-text-muted mt-1 leading-relaxed max-w-prose">
            Agent software installed on this computer. Finding one does not turn it
            on — choose the one you want Henry to use. Nothing is selected until you
            pick it below.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="text-[11px] px-2.5 py-1 rounded-md border border-henry-border text-henry-text hover:bg-henry-bg"
          >
            Re-check
          </button>
          {installed.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setCheckingModels(true);
                void load(true).finally(() => setCheckingModels(false));
              }}
              disabled={checkingModels}
              className="text-[11px] px-2.5 py-1 rounded-md border border-henry-border text-henry-text hover:bg-henry-bg disabled:opacity-40"
            >
              {checkingModels ? 'Checking…' : 'Check models'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="text-[11px] text-red-400 mb-3">Discovery failed: {error}</p>
      )}

      {!runtimes && !error && (
        <p className="text-[11px] text-henry-text-muted">Looking for installed agent runtimes…</p>
      )}

      {runtimes && (
        <div className="space-y-2">
          {selectedId && (
            <p className="text-[11px] text-henry-text-dim">
              Currently using{' '}
              <span className="text-henry-text">
                {runtimes.find((r) => r.id === selectedId)?.displayName ?? selectedId}
              </span>
              .
            </p>
          )}

          {installed.map((runtime) => (
            <RuntimeRow
              key={runtime.id}
              runtime={runtime}
              selected={runtime.id === selectedId}
              busy={busy}
              onUse={use}
            />
          ))}

          {missing.map((runtime) => (
            <RuntimeRow
              key={runtime.id}
              runtime={runtime}
              selected={false}
              busy={busy}
              onUse={use}
            />
          ))}

          {installed.length === 0 && missing.length === 0 && (
            <p className="text-[11px] text-henry-text-muted">
              No agent runtimes are registered.
            </p>
          )}
        </div>
      )}
    </div>
  );
}