/**
 * Toast + Confirm primitives.
 *
 * Imperative API (importable from anywhere — no context provider needed):
 *
 *   import { toast, confirmDialog } from '@/components/ui/Toast';
 *
 *   toast.success('Saved to workspace');
 *   toast.error('Save failed: ' + err.message);
 *   toast.info('Henry is thinking...', { duration: 3000 });
 *
 *   if (await confirmDialog('Delete this entry?', { destructive: true })) {
 *     // user confirmed
 *   }
 *
 * The companion <ToastHost /> component is mounted ONCE near the app root
 * (see src/App.tsx). It subscribes to a window event bus and renders the
 * queued toasts + any pending confirm modal. Using window events instead of
 * React context means the primitives work from non-component code (effects,
 * stores, IPC callbacks) without prop drilling.
 *
 * This replaces window.alert(), window.confirm(), and window.prompt() calls
 * scattered through the app — native dialogs block the Electron renderer
 * thread, look out-of-place against the dark UI, and ignore styling.
 */

import { useEffect, useRef, useState } from 'react';

// ── Types ───────────────────────────────────────────────────────────────────

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastOpts {
  duration?: number; // ms before auto-dismiss; default 3500
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOpts {
  id: string;
  kind: ToastKind;
  message: string;
}

interface ConfirmOpts {
  destructive?: boolean;  // styles the confirm button red
  confirmLabel?: string;  // default "Confirm"
  cancelLabel?: string;   // default "Cancel"
}

interface PromptOpts {
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

// ── Imperative API ──────────────────────────────────────────────────────────

const TOAST_EVT = 'henry:toast';
const CONFIRM_EVT = 'henry:confirm';
const PROMPT_EVT = 'henry:prompt';

function emit<T>(name: string, detail: T) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

let _idCounter = 0;
function nextId() { return `t${Date.now().toString(36)}_${(++_idCounter).toString(36)}`; }

function emitToast(kind: ToastKind, message: string, opts: ToastOpts = {}) {
  emit<ToastItem>(TOAST_EVT, { id: nextId(), kind, message, ...opts });
}

export const toast = {
  success: (msg: string, opts?: ToastOpts) => emitToast('success', msg, opts),
  error:   (msg: string, opts?: ToastOpts) => emitToast('error', msg, opts),
  info:    (msg: string, opts?: ToastOpts) => emitToast('info', msg, opts),
};

/**
 * Show a confirm modal. Returns a Promise that resolves to true if the user
 * clicked the confirm button, false otherwise (cancel, close, Escape).
 */
export function confirmDialog(message: string, opts: ConfirmOpts = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const id = nextId();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id: string; result: boolean };
      if (detail.id !== id) return;
      window.removeEventListener(`${CONFIRM_EVT}:result`, handler);
      resolve(detail.result);
    };
    window.addEventListener(`${CONFIRM_EVT}:result`, handler);
    emit(CONFIRM_EVT, { id, message, ...opts });
  });
}

/**
 * Show a prompt modal. Returns the entered string, or null if the user
 * cancelled. Replaces window.prompt() — the native version in Electron
 * pops an OS dialog that ignores the app's dark theme and blocks the
 * renderer thread.
 */
export function promptDialog(message: string, opts: PromptOpts = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const id = nextId();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id: string; result: string | null };
      if (detail.id !== id) return;
      window.removeEventListener(`${PROMPT_EVT}:result`, handler);
      resolve(detail.result);
    };
    window.addEventListener(`${PROMPT_EVT}:result`, handler);
    emit(PROMPT_EVT, { id, message, ...opts });
  });
}

// ── Renderer ────────────────────────────────────────────────────────────────

const KIND_STYLES: Record<ToastKind, { bg: string; border: string; icon: string }> = {
  success: { bg: 'bg-green-500/10',  border: 'border-green-500/40',  icon: '✓' },
  error:   { bg: 'bg-red-500/10',    border: 'border-red-500/40',    icon: '✕' },
  info:    { bg: 'bg-henry-accent/10', border: 'border-henry-accent/40', icon: 'i' },
};

interface ConfirmState {
  id: string;
  message: string;
  destructive?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface PromptState {
  id: string;
  message: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const promptInputRef = useRef<HTMLInputElement | null>(null);

  // Subscribe to the toast event bus
  useEffect(() => {
    const onToast = (e: Event) => {
      const item = (e as CustomEvent<ToastItem>).detail;
      setItems(prev => [...prev, item].slice(-4)); // cap at 4 visible
      const duration = item.duration ?? 3500;
      const tid = setTimeout(() => {
        setItems(prev => prev.filter(t => t.id !== item.id));
        timersRef.current.delete(item.id);
      }, duration);
      timersRef.current.set(item.id, tid);
    };
    const onConfirm = (e: Event) => {
      const detail = (e as CustomEvent<ConfirmState>).detail;
      setConfirmState(detail);
    };
    const onPrompt = (e: Event) => {
      const detail = (e as CustomEvent<PromptState>).detail;
      setPromptState(detail);
      setPromptValue(detail.defaultValue || '');
    };
    window.addEventListener(TOAST_EVT, onToast);
    window.addEventListener(CONFIRM_EVT, onConfirm);
    window.addEventListener(PROMPT_EVT, onPrompt);
    const timers = timersRef.current;
    return () => {
      window.removeEventListener(TOAST_EVT, onToast);
      window.removeEventListener(CONFIRM_EVT, onConfirm);
      window.removeEventListener(PROMPT_EVT, onPrompt);
      for (const tid of timers.values()) clearTimeout(tid);
      timers.clear();
    };
  }, []);

  // Focus + select the prompt input when it opens
  useEffect(() => {
    if (promptState && promptInputRef.current) {
      promptInputRef.current.focus();
      promptInputRef.current.select();
    }
  }, [promptState?.id]);

  function dismiss(id: string) {
    const tid = timersRef.current.get(id);
    if (tid) { clearTimeout(tid); timersRef.current.delete(id); }
    setItems(prev => prev.filter(t => t.id !== id));
  }

  function resolveConfirm(result: boolean) {
    if (!confirmState) return;
    window.dispatchEvent(new CustomEvent(`${CONFIRM_EVT}:result`, {
      detail: { id: confirmState.id, result },
    }));
    setConfirmState(null);
  }

  function resolvePrompt(result: string | null) {
    if (!promptState) return;
    window.dispatchEvent(new CustomEvent(`${PROMPT_EVT}:result`, {
      detail: { id: promptState.id, result },
    }));
    setPromptState(null);
    setPromptValue('');
  }

  // Esc closes the confirm/prompt modal as a cancel
  useEffect(() => {
    if (!confirmState && !promptState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (promptState) resolvePrompt(null);
        else if (confirmState) resolveConfirm(false);
      }
      // Enter on the confirm modal triggers confirm; on prompt it's handled
      // by the input's onKeyDown so the user can shift+enter for newlines
      // (not used but harmless to leave the path open).
      else if (e.key === 'Enter' && confirmState && !promptState) resolveConfirm(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmState?.id, promptState?.id]);

  return (
    <>
      {/* Toast stack — bottom-right, slides up */}
      <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
        {items.map(item => {
          const s = KIND_STYLES[item.kind];
          return (
            <div
              key={item.id}
              role="status"
              className={`pointer-events-auto min-w-[240px] max-w-sm flex items-start gap-3 px-4 py-3 rounded-xl border ${s.bg} ${s.border} backdrop-blur-md shadow-lg animate-fade-in`}
              style={{ animation: 'henry-toast-in 200ms ease-out' }}
            >
              <span className="text-sm shrink-0 mt-px" aria-hidden>{s.icon}</span>
              <p className="text-sm text-henry-text flex-1 leading-snug whitespace-pre-wrap break-words">{item.message}</p>
              {item.action && (
                <button
                  type="button"
                  onClick={() => { item.action!.onClick(); dismiss(item.id); }}
                  className="text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-henry-text-muted hover:text-henry-text shrink-0"
                >{item.action.label}</button>
              )}
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(item.id)}
                className="text-henry-text-muted/60 hover:text-henry-text text-xs shrink-0"
              >✕</button>
            </div>
          );
        })}
      </div>

      {/* Confirm modal — single instance at a time */}
      {confirmState && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => resolveConfirm(false)}>
          <div
            role="dialog"
            aria-modal="true"
            className="bg-henry-surface border border-henry-border/40 rounded-2xl p-5 max-w-sm w-[90%] shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-sm text-henry-text leading-snug whitespace-pre-wrap mb-4">{confirmState.message}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => resolveConfirm(false)}
                className="px-3 py-1.5 rounded-lg bg-henry-bg border border-henry-border/30 text-henry-text-muted hover:text-henry-text text-xs"
              >{confirmState.cancelLabel || 'Cancel'}</button>
              <button
                type="button"
                onClick={() => resolveConfirm(true)}
                autoFocus
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                  confirmState.destructive
                    ? 'bg-red-500/90 hover:bg-red-500 text-white'
                    : 'bg-henry-accent hover:bg-henry-accent/90 text-white'
                }`}
              >{confirmState.confirmLabel || 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt modal — replaces window.prompt() */}
      {promptState && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => resolvePrompt(null)}>
          <div
            role="dialog"
            aria-modal="true"
            className="bg-henry-surface border border-henry-border/40 rounded-2xl p-5 max-w-md w-[90%] shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-sm text-henry-text leading-snug whitespace-pre-wrap mb-3">{promptState.message}</p>
            <input
              ref={promptInputRef}
              type="text"
              value={promptValue}
              onChange={e => setPromptValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); resolvePrompt(promptValue); }
              }}
              placeholder={promptState.placeholder || ''}
              className="w-full px-3 py-2 mb-4 rounded-lg bg-henry-bg border border-henry-border/40 text-sm text-henry-text focus:outline-none focus:border-henry-accent/60"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => resolvePrompt(null)}
                className="px-3 py-1.5 rounded-lg bg-henry-bg border border-henry-border/30 text-henry-text-muted hover:text-henry-text text-xs"
              >{promptState.cancelLabel || 'Cancel'}</button>
              <button
                type="button"
                onClick={() => resolvePrompt(promptValue)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent hover:bg-henry-accent/90 text-white"
              >{promptState.confirmLabel || 'OK'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Animation keyframes (scoped here so we don't touch the global stylesheet) */}
      <style>{`
        @keyframes henry-toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
}
