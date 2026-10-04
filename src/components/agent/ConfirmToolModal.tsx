import { useEffect, useRef, useState } from 'react';

/**
 * ConfirmToolModal — the renderer half of the agent confirmation gate
 * (design §5 "confirm" tier). When Henry wants to run an outbound/destructive
 * tool (send a message, send an email, create a calendar event, run a command),
 * the ToolRunner pauses and emits `agent:confirm-required`. This modal surfaces
 * that request, lets the user review (and edit the key field — a message body,
 * an email body), then sends the decision back via `confirmTool`.
 *
 * Mounted once, globally, in the app shell so any agent run — chat or a
 * scheduled Routine — can raise a confirmation.
 *
 * The ToolRunner times out a pending confirm after 5 minutes and treats it as a
 * rejection; this modal mirrors that with its own 5-minute auto-cancel so a
 * stale prompt never lingers on screen.
 */

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

interface ConfirmRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
}

// Friendly display names for the tools that reach the confirm tier.
const TOOL_LABELS: Record<string, string> = {
  messages_send: 'Send iMessage',
  email_send: 'Send Email',
  calendar_create_event: 'Create Calendar Event',
  calendar_update_event: 'Update Calendar Event',
  calendar_delete_event: 'Delete Calendar Event',
  quote_create: 'Create Quote',
  terminal_exec: 'Run Terminal Command',
};

// Candidate arg keys, in priority order, for the single editable text field.
const EDITABLE_KEYS = ['body', 'message', 'text', 'notes', 'content', 'command', 'prompt'];

function humanizeTool(name: string): string {
  return (
    TOOL_LABELS[name] ??
    name
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

function pickEditableKey(args: Record<string, unknown>): string | null {
  for (const key of EDITABLE_KEYS) {
    if (typeof args[key] === 'string') return key;
  }
  return null;
}

export default function ConfirmToolModal() {
  // A small FIFO queue — confirm-tier tools run sequentially within one agent
  // turn, but a Routine and a chat turn could each raise one concurrently.
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const current = queue[0] ?? null;

  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to confirm-required events for the lifetime of the app.
  useEffect(() => {
    const api = window.henryAPI;
    if (typeof api?.onAgentConfirmRequired !== 'function') return;
    const unsub = api.onAgentConfirmRequired((req) => {
      const r = req as ConfirmRequest;
      if (!r?.id) return;
      setQueue((q) => (q.some((x) => x.id === r.id) ? q : [...q, r]));
    });
    return unsub;
  }, []);

  // Whenever the front-of-queue request changes, seed the editable field and
  // (re)arm the 5-minute auto-cancel timer.
  useEffect(() => {
    if (!current) {
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }
    const key = pickEditableKey(current.args);
    setEditKey(key);
    setEditValue(key ? String(current.args[key] ?? '') : '');
    setBusy(false);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // Mirror the ToolRunner timeout — auto-cancel as a rejection.
      void resolve(false, current);
    }, CONFIRM_TIMEOUT_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  async function resolve(approved: boolean, req: ConfirmRequest) {
    if (timerRef.current) clearTimeout(timerRef.current);
    setBusy(true);
    try {
      let editedArgs: Record<string, unknown> | undefined;
      // Only send edits when the user actually changed the editable field.
      if (approved && editKey && editValue !== String(req.args[editKey] ?? '')) {
        editedArgs = { ...req.args, [editKey]: editValue };
      }
      await window.henryAPI.confirmTool?.(req.id, approved, editedArgs);
    } catch (err) {
      console.error('[ConfirmToolModal] confirmTool failed:', err);
    } finally {
      // Drop this request and advance to the next, if any.
      setQueue((q) => q.filter((x) => x.id !== req.id));
    }
  }

  if (!current) return null;

  const toolLabel = humanizeTool(current.toolName);
  // Context fields shown read-only above the editable body (recipient, subject…).
  const contextEntries = Object.entries(current.args).filter(
    ([k, v]) => k !== editKey && (typeof v === 'string' || typeof v === 'number'),
  );

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-tool-title"
    >
      <div
        className="w-full max-w-lg rounded-xl border border-henry-border/40 bg-henry-bg shadow-2xl p-5 text-henry-text"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-base">🤚</span>
          <h2 id="confirm-tool-title" className="text-sm font-semibold text-henry-text">
            Henry wants to: {toolLabel}
          </h2>
        </div>
        <p className="text-xs text-henry-text-muted leading-relaxed mb-4">
          {current.description}
        </p>

        {contextEntries.length > 0 && (
          <div className="mb-3 space-y-1 rounded-lg border border-henry-border/30 bg-henry-surface/30 px-3 py-2">
            {contextEntries.map(([k, v]) => (
              <div key={k} className="text-[11px] text-henry-text-dim break-words">
                <span className="text-henry-text-muted capitalize">{k.replace(/_/g, ' ')}:</span>{' '}
                {String(v)}
              </div>
            ))}
          </div>
        )}

        {editKey ? (
          <div className="mb-4">
            <label className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
              {editKey.replace(/_/g, ' ')} — you can edit before sending
            </label>
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              rows={editKey === 'command' ? 4 : 6}
              autoFocus
              className="w-full rounded-lg border border-henry-border/40 bg-henry-surface/30 px-2.5 py-2 text-xs leading-relaxed resize-y min-h-[100px] focus:outline-none focus:border-henry-accent/50"
            />
          </div>
        ) : (
          <p className="text-[11px] text-henry-text-dim mb-4">
            Review the details above before approving.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void resolve(false, current)}
            className="px-4 py-1.5 text-xs rounded-lg border border-henry-border/50 text-henry-text-muted hover:text-henry-text hover:border-henry-border disabled:opacity-40 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resolve(true, current)}
            className="px-4 py-1.5 text-xs rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-40 transition-colors"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
