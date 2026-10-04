import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shield, ChevronRight, RefreshCw, Trash2, Loader2, AlertTriangle } from 'lucide-react';

/**
 * AuditLogPanel — "What Henry Did" (design §5 Audit Log).
 *
 * Every tool call the agent runs is written to the session store as a `role:
 * 'tool'` message (see electron/agent/toolRunner.ts). This panel surfaces that
 * trail: newest first, one row per call with its safety tier, status, and a
 * collapsible view of the args + result.
 *
 * Data sources:
 *   - window.henryAPI.listToolCalls()  → the tool-call messages (session store)
 *   - window.henryAPI.listTools()      → name→{safetyLevel, description} so we
 *                                        can badge each row by tier and show a
 *                                        friendly label. Safety tier isn't
 *                                        stored on the message, so we map it
 *                                        from the live tool catalogue.
 */

// ── Wire shapes ──────────────────────────────────────────────────────────────

type ContentBlock =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

interface ToolCallRow {
  id: number;
  session_id: string;
  session_title?: string | null;
  role: string;
  tool_name?: string | null;
  tool_call_id?: string | null;
  timestamp: number; // epoch seconds
  content: ContentBlock[] | string | null;
}

type SafetyTier = 'silent' | 'notify' | 'confirm';
type Status = 'success' | 'failed' | 'cancelled';
type Filter = 'all' | SafetyTier | 'failed';

interface ToolMeta {
  safetyLevel: SafetyTier;
  description: string;
  category: string;
}

// ── A normalized, render-ready view of one tool call ─────────────────────────

interface AuditEntry {
  id: number;
  toolName: string;
  label: string;
  tier: SafetyTier;
  status: Status;
  timestamp: number;
  sessionTitle: string;
  args: unknown;
  result: unknown;
  errorMessage?: string;
}

const TIER_BADGE: Record<SafetyTier, { label: string; cls: string }> = {
  silent: { label: 'Silent', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  notify: { label: 'Notify', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  confirm: { label: 'Confirm', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
};

const STATUS_BADGE: Record<Status, { label: string; cls: string }> = {
  success: { label: 'Success', cls: 'text-emerald-400' },
  failed: { label: 'Failed', cls: 'text-red-400' },
  cancelled: { label: 'Cancelled', cls: 'text-henry-text-muted' },
};

/** Turn `qb_sync_invoices` into `QuickBooks · Sync Invoices`-ish readable text. */
function humanizeToolName(name: string): string {
  const PREFIX: Record<string, string> = {
    qb: 'QuickBooks',
    web: 'Web',
    calendar: 'Calendar',
    email: 'Email',
    imessage: 'iMessage',
    memory: 'Memory',
    quote: 'Quote',
    invoice: 'Invoice',
    finance: 'Finance',
    permissions: 'Permissions',
  };
  const parts = name.split('_');
  const head = PREFIX[parts[0]] ?? cap(parts[0]);
  const rest = parts.slice(1).map(cap).join(' ');
  return rest ? `${head} · ${rest}` : head;
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Pull the {tool_use, tool_result} pair out of a tool message's content. */
function parseEntry(row: ToolCallRow, meta: Map<string, ToolMeta>): AuditEntry {
  const name = row.tool_name ?? 'unknown';
  const blocks = Array.isArray(row.content) ? row.content : [];
  const use = blocks.find((b) => b.type === 'tool_use') as
    | { input?: unknown }
    | undefined;
  const res = blocks.find((b) => b.type === 'tool_result') as
    | { content?: unknown; is_error?: boolean }
    | undefined;

  // result.content is the ToolResult: { ok, data?, error?, retryable? }
  const result = res?.content;
  const r = (result ?? {}) as { ok?: boolean; error?: string };
  const errorMessage = typeof r.error === 'string' ? r.error : undefined;

  let status: Status = 'success';
  if (res?.is_error || r.ok === false) {
    // The runner returns this exact error when the user declines a confirm-tier tool.
    status = errorMessage === 'User declined the action.' ? 'cancelled' : 'failed';
  }

  const m = meta.get(name);
  return {
    id: row.id,
    toolName: name,
    label: humanizeToolName(name),
    tier: m?.safetyLevel ?? 'silent',
    status,
    timestamp: row.timestamp,
    sessionTitle: row.session_title ?? '',
    args: use?.input,
    result,
    errorMessage,
  };
}

function formatTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${time}`;
}

function pretty(value: unknown): string {
  if (value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ── Row ──────────────────────────────────────────────────────────────────────

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const tier = TIER_BADGE[entry.tier];
  const status = STATUS_BADGE[entry.status];

  return (
    <div className="border border-henry-border/20 rounded-lg bg-henry-surface/30 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-henry-surface/50 transition-colors"
      >
        <ChevronRight
          size={14}
          className={`shrink-0 text-henry-text-muted transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="shrink-0 text-[11px] tabular-nums text-henry-text-muted w-[92px]">
          {formatTime(entry.timestamp)}
        </span>
        <span className="flex-1 min-w-0 truncate text-sm text-henry-text font-medium">
          {entry.label}
        </span>
        <span className={`shrink-0 text-[11px] font-medium ${status.cls}`}>{status.label}</span>
        <span
          className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${tier.cls}`}
        >
          {tier.label}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-henry-border/10">
          {entry.sessionTitle && (
            <div className="text-[11px] text-henry-text-muted">
              Session: <span className="text-henry-text">{entry.sessionTitle}</span>
            </div>
          )}
          {entry.errorMessage && entry.status !== 'cancelled' && (
            <div className="flex items-start gap-1.5 text-[11px] text-red-400">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span className="break-words">{entry.errorMessage}</span>
            </div>
          )}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-henry-text-muted mb-1">Arguments</div>
            <pre className="text-[11px] leading-relaxed bg-henry-bg/60 rounded p-2 overflow-x-auto text-henry-text/90 whitespace-pre-wrap break-words max-h-48">
              {pretty(entry.args)}
            </pre>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-henry-text-muted mb-1">Result</div>
            <pre className="text-[11px] leading-relaxed bg-henry-bg/60 rounded p-2 overflow-x-auto text-henry-text/90 whitespace-pre-wrap break-words max-h-64">
              {pretty(entry.result)}
            </pre>
          </div>
          <div className="text-[10px] text-henry-text-muted/70 font-mono">{entry.toolName}</div>
        </div>
      )}
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'silent', label: 'Silent' },
  { id: 'notify', label: 'Notify' },
  { id: 'confirm', label: 'Approvals' },
  { id: 'failed', label: 'Failed' },
];

export default function AuditLogPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const reload = useCallback(async () => {
    const api = window.henryAPI;
    if (typeof api?.listToolCalls !== 'function') {
      setError('The audit log is only available in the desktop app.');
      setLoading(false);
      return;
    }
    try {
      // Fetch the tool catalogue (for safety tiers) and the call history together.
      const [catalogue, res] = await Promise.all([
        typeof api.listTools === 'function' ? api.listTools() : Promise.resolve([]),
        api.listToolCalls(200),
      ]);

      const meta = new Map<string, ToolMeta>();
      for (const t of catalogue ?? []) {
        meta.set(t.name, {
          safetyLevel: (t.safetyLevel as SafetyTier) ?? 'silent',
          description: t.description,
          category: t.category,
        });
      }

      if (res?.ok) {
        const rows = ((res.result as { tool_calls?: ToolCallRow[] })?.tool_calls ?? []) as ToolCallRow[];
        setEntries(rows.map((row) => parseEntry(row, meta)));
        setError(null);
      } else {
        setError(res?.error ?? 'Failed to load the audit log.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // Refresh when a tool finishes so the log stays live during a conversation.
    const api = window.henryAPI;
    const unsubs: Array<() => void> = [];
    if (typeof api?.onAgentToolNotify === 'function') {
      unsubs.push(api.onAgentToolNotify(() => void reload()));
    }
    if (typeof api?.onSchedulerTaskCompleted === 'function') {
      unsubs.push(api.onSchedulerTaskCompleted(() => void reload()));
    }
    return () => unsubs.forEach((u) => u());
  }, [reload]);

  async function handleClear() {
    setClearing(true);
    try {
      await window.henryAPI.clearToolCalls?.();
      setEntries([]);
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  const filtered = useMemo(() => {
    if (filter === 'all') return entries;
    if (filter === 'failed') return entries.filter((e) => e.status === 'failed');
    return entries.filter((e) => e.tier === filter);
  }, [entries, filter]);

  return (
    <div className="flex flex-col h-full bg-henry-bg text-henry-text">
      {/* Header */}
      <div className="shrink-0 px-5 py-4 border-b border-henry-border/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Shield size={18} className="text-henry-accent" />
            <div>
              <h1 className="text-base font-semibold">Audit Log</h1>
              <p className="text-[11px] text-henry-text-muted">Every action Henry has taken, newest first.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void reload()}
              title="Refresh"
              className="p-1.5 rounded-lg text-henry-text-muted hover:text-henry-text hover:bg-henry-surface/60 transition-colors"
            >
              <RefreshCw size={15} />
            </button>
            <button
              onClick={() => setConfirmClear(true)}
              disabled={entries.length === 0}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] text-henry-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-henry-text-muted"
            >
              <Trash2 size={14} />
              Clear history
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-1.5 mt-3">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                filter === f.id
                  ? 'bg-henry-accent/15 text-henry-accent'
                  : 'text-henry-text-muted hover:text-henry-text hover:bg-henry-surface/60'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-henry-text-muted text-sm">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 py-8 text-sm text-red-400">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-henry-text-muted">
            <Shield size={28} className="mb-3 opacity-40" />
            <p className="text-sm">
              {entries.length === 0
                ? 'No agent actions recorded yet.'
                : `No ${filter} actions to show.`}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>

      {/* Clear-history confirmation */}
      {confirmClear && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[360px] rounded-xl border border-henry-border/30 bg-henry-surface p-5 shadow-2xl">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={18} className="text-red-400" />
              <h2 className="text-sm font-semibold">Clear audit history?</h2>
            </div>
            <p className="text-[12px] text-henry-text-muted leading-relaxed mb-4">
              This permanently deletes every recorded tool call. Your conversations are kept — only
              the action log is removed. This can't be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmClear(false)}
                disabled={clearing}
                className="px-3 py-1.5 rounded-lg text-[12px] text-henry-text-muted hover:text-henry-text hover:bg-henry-surface/60 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleClear()}
                disabled={clearing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
              >
                {clearing && <Loader2 size={13} className="animate-spin" />}
                Clear history
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
