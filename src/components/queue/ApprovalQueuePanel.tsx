/**
 * ApprovalQueuePanel — the review surface for the Approval Queue (build plan,
 * Phase 2). Read-only: decisions happen in the in-chat confirm prompt; this
 * panel is the durable record of what Henry asked to do and how it resolved —
 * pending at the top, history below, filterable by status.
 *
 * Reads via `approvalsList` + `approvalsStats`. Every call is guarded so the
 * panel always renders a clear loading / empty / error state.
 */

import { useCallback, useEffect, useState } from 'react';

type Approval = HenryApproval;
type Filter = 'all' | 'pending' | 'approved' | 'rejected' | 'expired';

const FILTERS: Filter[] = ['all', 'pending', 'approved', 'rejected', 'expired'];

const STATUS_STYLE: Record<Approval['status'], string> = {
  pending: 'bg-amber-500/15 text-amber-400',
  approved: 'bg-emerald-500/15 text-emerald-400',
  rejected: 'bg-red-500/15 text-red-400',
  needs_review: 'bg-sky-500/15 text-sky-400',
  expired: 'bg-henry-border/30 text-henry-text-muted',
  completed: 'bg-sky-500/15 text-sky-400',
};

function api() {
  return typeof window !== 'undefined' ? window.henryAPI : undefined;
}

function relative(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function argsSummary(json?: string | null): string {
  if (!json) return '';
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return '';
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('  ·  ');
  } catch {
    return '';
  }
}

export default function ApprovalQueuePanel() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: Filter) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api()?.approvalsList?.(f === 'all' ? undefined : { status: f });
      if (!res) { setError('The Approval Queue is only available in the desktop app.'); setApprovals([]); return; }
      if (!res.ok) { setError(res.error || 'Could not load approvals.'); setApprovals([]); return; }
      setApprovals(res.result ?? []);
      const s = await api()?.approvalsStats?.();
      if (s?.ok && s.result) setStats(s.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load approvals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(filter); }, [load, filter]);

  return (
    <div className="h-full overflow-y-auto bg-henry-bg">
      <div className="max-w-3xl mx-auto px-5 py-6">
        <div className="flex items-end justify-between mb-1">
          <h1 className="text-xl font-semibold text-henry-text">Approvals</h1>
          <button
            onClick={() => void load(filter)}
            className="text-xs text-henry-text-muted hover:text-henry-text transition-colors"
          >
            Refresh
          </button>
        </div>
        <p className="text-xs text-henry-text-muted mb-4">
          Everything Henry asked to do before acting — what's waiting, what you approved, what you turned down.
        </p>

        {/* Filter chips with live counts */}
        <div className="flex items-center gap-1.5 mb-5 flex-wrap">
          {FILTERS.map((f) => {
            const count = f === 'all'
              ? Object.values(stats).reduce((a, b) => a + b, 0)
              : (stats[f] ?? 0);
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-[11px] rounded-full px-2.5 py-1 transition-colors ${
                  active
                    ? 'bg-henry-accent/20 text-henry-accent'
                    : 'bg-henry-surface/40 text-henry-text-muted hover:text-henry-text'
                }`}
              >
                {f}{count ? ` · ${count}` : ''}
              </button>
            );
          })}
        </div>

        {loading && <div className="text-sm text-henry-text-muted py-12 text-center">Loading approvals…</div>}

        {!loading && error && (
          <div className="bg-henry-surface/50 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
            {error}
            <button onClick={() => void load(filter)} className="block mt-2 text-henry-accent hover:underline">Try again</button>
          </div>
        )}

        {!loading && !error && approvals.length === 0 && (
          <div className="text-sm text-henry-text-muted py-12 text-center">
            {filter === 'all'
              ? "Nothing here yet. When Henry needs your OK before a risky action, it shows up here."
              : `No ${filter} approvals.`}
          </div>
        )}

        {!loading && !error && approvals.length > 0 && (
          <div className="space-y-2">
            {approvals.map((a) => (
              <ApprovalRow key={a.id} approval={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── One approval row ─────────────────────────────────────────────────────────

function ApprovalRow({ approval }: { approval: Approval }) {
  const summary = argsSummary(approval.args_json);
  const isPending = approval.status === 'pending';
  return (
    <div
      className={`rounded-xl p-3.5 border ${
        isPending
          ? 'bg-amber-500/5 border-amber-500/30'
          : 'bg-henry-surface/40 border-henry-border/30'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-henry-text">{approval.description || approval.tool_name}</span>
            <code className="text-[10px] text-henry-text-dim bg-henry-surface/60 rounded px-1.5 py-0.5">
              {approval.tool_name}
            </code>
          </div>
          {summary && (
            <p className="text-[11px] text-henry-text-muted mt-1 truncate" title={summary}>{summary}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span className={`text-[10px] rounded-full px-2 py-0.5 ${STATUS_STYLE[approval.status]}`}>
            {approval.status}
          </span>
          <span className="text-[10px] text-henry-text-dim">
            {relative(approval.decided_at || approval.requested_at)}
          </span>
        </div>
      </div>
    </div>
  );
}
