import { useEffect, useState } from 'react';
import type { SuggestedTaskFromMessage } from '@/henry/taskFromMessage';

interface CreateTaskFromMessageModalProps {
  open: boolean;
  suggestion: SuggestedTaskFromMessage | null;
  onClose: () => void;
  onSubmit: (title: string, promptBody: string) => Promise<void>;
}

export default function CreateTaskFromMessageModal({
  open,
  suggestion,
  onClose,
  onSubmit,
}: CreateTaskFromMessageModalProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && suggestion) {
      setTitle(suggestion.title);
      setBody(suggestion.description);
      setError(null);
    }
  }, [open, suggestion]);

  if (!open || !suggestion) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    const b = body.trim();
    if (!t || !b) {
      setError('Title and instructions are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(t, b);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-task-title"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-henry-border/40 bg-henry-bg shadow-xl p-4 text-henry-text"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="create-task-title" className="text-sm font-semibold text-henry-text mb-1">
          Create Worker task
        </h2>
        <p className="text-[10px] text-henry-text-muted leading-relaxed mb-3">
          This task can stay linked to the draft, plan, or study context it came from. Only paths are stored —
          file contents are not attached automatically.
        </p>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
              Short title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-henry-border/40 bg-henry-surface/30 px-2 py-1.5 text-xs"
              maxLength={200}
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
              Instructions for Worker
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-henry-border/40 bg-henry-surface/30 px-2 py-1.5 text-xs font-mono leading-relaxed resize-y min-h-[120px]"
            />
          </div>

          <div className="text-[10px] text-henry-text-dim space-y-0.5">
            <div>
              <span className="text-henry-text-muted">From mode:</span> {suggestion.sourceMode}
            </div>
            {suggestion.relatedFilePath && (
              <div className="break-all">
                <span className="text-henry-text-muted">Linked path:</span> {suggestion.relatedFilePath}
              </div>
            )}
          </div>

          {error && <p className="text-[10px] text-henry-error">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg border border-henry-border/40 text-henry-text-muted hover:text-henry-text disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-1.5 text-xs rounded-lg bg-henry-worker/90 text-white hover:bg-henry-worker disabled:opacity-40"
            >
              {busy ? 'Queueing…' : 'Queue task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
