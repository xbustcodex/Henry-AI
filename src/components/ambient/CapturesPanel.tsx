/**
 * Henry AI — Captures Panel
 *
 * Review, route, reclassify, and edit all notes captured by Henry's
 * ambient listener. Nothing here is invisible — every captured note
 * is shown with its source, classification, and routing status.
 *
 * The user can:
 *   - Read every captured note
 *   - See where it was classified (and change it)
 *   - Route it to a destination (reminders, chat, memory, workspace, etc.)
 *   - Edit the text before routing
 *   - Archive / dismiss notes they don't need
 *   - Clear archived notes
 */

import { useState, useRef, useEffect } from 'react';
import { useCapturesStore, selectActiveCaptures, selectUnroutedCaptures } from '../../ambient/capturesStore';
import { confirmDialog } from '../ui/Toast';
import type { CapturedNote } from '../../ambient/capturesStore';
import {
  NOTE_CATEGORY_LABELS,
  NOTE_CATEGORY_ICONS,
  ROUTE_DEST_LABELS,
  defaultDestForCategory,
  type NoteCategory,
  type RouteDest,
} from '../../ambient/noteRouter';
import { wakeWordManager } from '../../henry/wakeWord';
const api = (window as any).henryAPI;
import { PANEL_QUICK_ASK } from '../../henry/henryQuickAsk';

// ── Route destination options ─────────────────────────────────────────────────

const ROUTE_DESTINATIONS: { dest: RouteDest; label: string; icon: string }[] = [
  { dest: 'chat',            label: 'Send to Henry',   icon: '💬' },
  { dest: 'reminders',      label: 'Save as Reminder', icon: '🔔' },
  { dest: 'tasks',          label: 'Add to Tasks',     icon: '📋' },
  { dest: 'personal_memory',label: 'Save to Memory',   icon: '🧠' },
  { dest: 'workspace',      label: 'Add to Workspace', icon: '🗂️' },
  { dest: 'project',        label: 'Project Notes',    icon: '📐' },
  { dest: 'journal',        label: 'Save to Journal',  icon: '📔' },
  { dest: 'saved',          label: 'Save Note',        icon: '📝' },
];

const ALL_CATEGORIES: NoteCategory[] = [
  'reminder', 'task', 'workspace_note', 'project_note',
  'personal_memory', 'journal', 'chat_input', 'general_note',
];

// ── CaptureCard ───────────────────────────────────────────────────────────────

function CaptureCard({ note }: { note: CapturedNote }) {
  const { reclassify, routeCapture, editCapture, archive } = useCapturesStore();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(note.text);
  const [showReclassify, setShowReclassify] = useState(false);
  const [routed, setRouted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [editing]);

  function handleRoute(dest: RouteDest) {
    const success = routeCapture(note.id, dest);
    if (success) setRouted(true);
  }

  function handleSaveEdit() {
    if (editText.trim() && editText.trim() !== note.text) {
      editCapture(note.id, editText.trim());
    }
    setEditing(false);
  }

  const timeAgo = (() => {
    const diff = Date.now() - new Date(note.createdAt).getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return new Date(note.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  })();

  const isRouted = !!note.routedTo;
  const defaultDest = defaultDestForCategory(note.category);

  return (
    <div className={`group relative rounded-xl border transition-all ${
      isRouted
        ? 'bg-henry-surface/40 border-henry-border/30 opacity-70'
        : 'bg-henry-surface border-henry-border/50 hover:border-henry-border'
    }`}>
      {/* Category tag + timestamp */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <button
          onClick={() => setShowReclassify((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full bg-henry-hover/60 border border-henry-border/30 text-henry-text-dim hover:text-henry-text hover:border-henry-border/60 transition-all"
          title="Click to reclassify"
        >
          <span>{NOTE_CATEGORY_ICONS[note.category]}</span>
          <span>{NOTE_CATEGORY_LABELS[note.category]}</span>
          <svg className="w-2.5 h-2.5 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        <div className="flex items-center gap-2 text-[10px] text-henry-text-muted">
          {note.edited && <span className="italic">edited</span>}
          {note.autoRoutedAt && (
            <span className="text-henry-success/70">auto-routed</span>
          )}
          <span>{timeAgo}</span>
          <button
            onClick={() => archive(note.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity w-5 h-5 flex items-center justify-center rounded hover:bg-henry-hover/80 text-henry-text-muted hover:text-henry-text"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      </div>

      {/* Reclassify dropdown */}
      {showReclassify && (
        <div className="mx-3 mb-2 flex flex-wrap gap-1.5">
          {ALL_CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => { reclassify(note.id, cat); setShowReclassify(false); }}
              className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-all ${
                note.category === cat
                  ? 'bg-henry-accent/15 border-henry-accent/40 text-henry-accent'
                  : 'bg-henry-hover/40 border-henry-border/30 text-henry-text-dim hover:border-henry-border/60'
              }`}
            >
              <span>{NOTE_CATEGORY_ICONS[cat]}</span>
              <span>{NOTE_CATEGORY_LABELS[cat]}</span>
            </button>
          ))}
        </div>
      )}

      {/* Note text */}
      <div className="px-3 pb-2">
        {editing ? (
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveEdit();
                if (e.key === 'Escape') { setEditing(false); setEditText(note.text); }
              }}
              className="w-full bg-henry-bg/60 border border-henry-accent/30 rounded-lg px-3 py-2 text-sm text-henry-text resize-none focus:outline-none focus:border-henry-accent/60"
              rows={3}
            />
            <div className="flex gap-2">
              <button
                onClick={handleSaveEdit}
                className="text-[11px] px-3 py-1 rounded-lg bg-henry-accent/15 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/25 transition-all"
              >
                Save
              </button>
              <button
                onClick={() => { setEditing(false); setEditText(note.text); }}
                className="text-[11px] px-3 py-1 rounded-lg bg-henry-hover/60 border border-henry-border/30 text-henry-text-dim hover:text-henry-text transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p
            className="text-sm text-henry-text leading-relaxed cursor-text select-text"
            onDoubleClick={() => setEditing(true)}
            title="Double-click to edit"
          >
            {note.text}
            {(note as any).sourceUrl && (
              <a href={(note as any).sourceUrl} target="_blank" rel="noreferrer"
                className="text-[10px] text-henry-text-muted/60 hover:text-henry-accent truncate block mt-1.5 transition-colors">
                {'🌐 '}{(note as any).pageTitle || (note as any).sourceUrl}
              </a>
            )}
          </p>
        )}
      </div>

      {/* Routing status or routing actions */}
      {isRouted ? (
        <div className="px-3 pb-2.5 flex items-center gap-1.5 text-[11px] text-henry-success/70">
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <span>
            Routed to {ROUTE_DEST_LABELS[note.routedTo!]}
            {note.autoRoutedAt && ' (auto)'}
          </span>
        </div>
      ) : (
        <div className="px-3 pb-2.5 space-y-1.5">
          {/* Primary action (default dest for category) */}
          {!routed && (
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => handleRoute(defaultDest)}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg bg-henry-accent/10 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/20 transition-all font-medium"
              >
                <span>{ROUTE_DESTINATIONS.find((d) => d.dest === defaultDest)?.icon}</span>
                <span>{ROUTE_DEST_LABELS[defaultDest]}</span>
              </button>
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-henry-hover/60 border border-henry-border/30 text-henry-text-dim hover:text-henry-text transition-all"
                title="Edit before routing"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                Edit
              </button>
            </div>
          )}

          {/* Other destinations (collapsed by default) */}
          <details className="group/details">
            <summary className="list-none cursor-pointer text-[10px] text-henry-text-muted hover:text-henry-text-dim transition-colors select-none">
              More options ›
            </summary>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {ROUTE_DESTINATIONS.filter((d) => d.dest !== defaultDest).map(({ dest, label, icon }) => (
                <button
                  key={dest}
                  onClick={() => handleRoute(dest)}
                  className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-henry-hover/40 border border-henry-border/30 text-henry-text-dim hover:text-henry-text hover:border-henry-border/60 transition-all"
                >
                  <span>{icon}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

// ── CapturesPanel ─────────────────────────────────────────────────────────────

export default function CapturesPanel() {
  const { captures, clearArchived, clearAll, openPanel } = useCapturesStore();
  const [filter, setFilter] = useState<'all' | 'unrouted' | 'archived'>('all');
  const [dbCaptures, setDbCaptures] = useState<{id:string;text:string;captured_at:string;routed_to?:string}[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [reviewResult, setReviewResult] = useState('');
  const [wakeActive, setWakeActive] = useState(wakeWordManager.isActive);

  // Load SQLite-backed captures (from ⌥Space hotkey captures)
  useEffect(() => {
    api?.captureList?.(30).then((data: any) => setDbCaptures(data || [])).catch(() => {});
  }, [captures]);

  async function reviewAllWithHenry() {
    const all = dbCaptures.slice(0, 10).map((cap: any) => cap.text).join('\n---\n');
    if (!all.trim()) return;
    setReviewing(true);
    setReviewResult('');
    const ownerName = localStorage.getItem('henry:owner_name') || 'you';
    const prompt = `Review these ${dbCaptures.length} captures from ${ownerName}'s day:\n\n${all}\n\nIn 3-5 sentences: what patterns do you see? What 1-2 things should ${ownerName} act on? What can be dismissed? Be direct.`;
    const deviceId = (() => { let id = localStorage.getItem('henry:device_id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('henry:device_id', id); } return id; })();
    try {
      const r = await fetch('https://henry-proxy.henryai.workers.dev/v1/chat', {
        signal: AbortSignal.timeout(25000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Henry-Device': deviceId },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 350, stream: false }),
      });
      const d = await r.json() as any;
      setReviewResult(d?.choices?.[0]?.message?.content || 'No response');
    } catch { setReviewResult('Could not reach Henry AI.'); }
    setReviewing(false);
  }
  const [ambientFlash, setAmbientFlash] = useState<string | null>(null);

  // Sync wake state
  useEffect(() => {
    function onWakeState(e: Event) {
      const detail = (e as CustomEvent<{ active: boolean }>).detail;
      setWakeActive(detail.active);
    }
    function onAmbientNote(e: Event) {
      const detail = (e as CustomEvent<{ note: { text: string } }>).detail;
      const text = detail?.note?.text;
      if (text) {
        const short = text.length > 50 ? text.slice(0, 50) + '…' : text;
        setAmbientFlash(short);
        setTimeout(() => setAmbientFlash(null), 3000);
      }
    }
    window.addEventListener('henry_wake_state', onWakeState);
    window.addEventListener('henry_ambient_note', onAmbientNote);
    return () => {
      window.removeEventListener('henry_wake_state', onWakeState);
      window.removeEventListener('henry_ambient_note', onAmbientNote);
    };
  }, []);

  async function toggleListen() {
    if (wakeActive) {
      wakeWordManager.stop();
    } else {
      await wakeWordManager.start();
    }
  }

  const active = selectActiveCaptures(captures);
  const unrouted = selectUnroutedCaptures(captures);
  const archived = captures.filter((c) => c.archived);

  const displayed =
    filter === 'all'      ? active :
    filter === 'unrouted' ? unrouted :
    archived;

  return (
    <div className="h-full flex flex-col bg-henry-bg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-4 border-b border-henry-border/40 shrink-0">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-henry-text">Captures</h2>
                  {dbCaptures.length > 0 && (
                    <span className="text-[10px] bg-henry-accent/20 text-henry-accent px-2 py-0.5 rounded-full font-semibold">{dbCaptures.length}</span>
                  )}
                </div>
                {dbCaptures.length > 0 && (
                  <button onClick={() => void reviewAllWithHenry()} disabled={reviewing}
                    className="text-xs px-3 py-1.5 rounded-xl bg-henry-accent/15 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/25 disabled:opacity-40 transition-all flex-shrink-0">
                    {reviewing ? '⟳ Reviewing…' : '⚡ Review all'}
                  </button>
                )}
                <button
                onClick={() => PANEL_QUICK_ASK.captures()}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all"
              >🧠 Ask Henry</button>
              </div>
            <p className="text-xs text-henry-text-muted mt-0.5">
              Everything Henry heard and classified. Nothing is hidden.
            </p>
          </div>

          {/* Listen toggle */}
          <button
            onClick={() => void toggleListen()}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl border font-medium transition-all shrink-0 ${
              wakeActive
                ? 'bg-henry-accent/15 border-henry-accent/30 text-henry-accent hover:bg-henry-accent/25'
                : 'bg-henry-surface border-henry-border/50 text-henry-text-dim hover:text-henry-text hover:border-henry-border'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${wakeActive ? 'bg-henry-accent animate-pulse' : 'bg-henry-text-muted/40'}`} />
            {wakeActive ? 'Listening' : 'Start Listening'}
          </button>
        </div>

        {/* Live flash */}
        {ambientFlash && (
          <div className="mb-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-henry-accent/8 border border-henry-accent/20 text-xs text-henry-text animate-fade-in">
            <span className="text-henry-accent shrink-0">📝</span>
            <span className="truncate">{ambientFlash}</span>
          </div>
        )}

        {/* Stats row */}
        <div className="flex items-center gap-4 text-xs text-henry-text-muted">
          <span>{active.length} active</span>
          {unrouted.length > 0 && (
            <span className="text-henry-warning/80">{unrouted.length} unrouted</span>
          )}
          {archived.length > 0 && (
            <span>{archived.length} archived</span>
          )}
        </div>
      </div>

      {/* Henry review result */}
      {reviewResult && (
        <div className="mx-4 mb-3 p-3 bg-henry-accent/8 border border-henry-accent/20 rounded-xl">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] font-semibold text-henry-accent uppercase tracking-wider">⚡ Henry's review</p>
            <button onClick={() => setReviewResult('')} className="text-henry-text-muted hover:text-henry-text text-xs">✕</button>
          </div>
          <p className="text-xs text-henry-text leading-relaxed">{reviewResult}</p>
        </div>
      )}

      {/* DB-backed captures (from ⌥Space hotkey) */}
      {dbCaptures.length > 0 && (
        <div className="px-4 pb-2">
          <p className="text-[9px] uppercase tracking-widest text-henry-text-muted mb-1.5">Hotkey captures (⌥Space)</p>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {dbCaptures.slice(0,8).map(cap => (
              <div key={cap.id} className="flex items-start gap-2 p-2 rounded-lg bg-henry-surface/40 border border-henry-border/10 text-xs">
                <span className="text-henry-text-muted flex-shrink-0">{cap.captured_at?.slice(11,16)}</span>
                <span className="text-henry-text truncate flex-1">{cap.text?.slice(0,80)}{cap.text?.length > 80 ? '…' : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-henry-border/30 shrink-0">
        {([
          { key: 'all',      label: 'All',      count: active.length },
          { key: 'unrouted', label: 'Unrouted', count: unrouted.length },
          { key: 'archived', label: 'Archived', count: archived.length },
        ] as const).map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg transition-all ${
              filter === key
                ? 'bg-henry-accent/10 text-henry-accent border border-henry-accent/20'
                : 'text-henry-text-dim hover:text-henry-text hover:bg-henry-hover/50 border border-transparent'
            }`}
          >
            {label}
            {count > 0 && (
              <span className={`text-[10px] px-1 py-0.5 rounded-full ${
                filter === key ? 'bg-henry-accent/20 text-henry-accent' : 'bg-henry-hover/80 text-henry-text-muted'
              }`}>
                {count}
              </span>
            )}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-1">
          {filter === 'archived' && archived.length > 0 && (
            <button
              onClick={clearArchived}
              className="text-[11px] px-2 py-1 rounded-lg text-henry-text-muted hover:text-henry-error/80 hover:bg-henry-error/10 transition-all"
            >
              Clear archived
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5 min-h-0">
        {displayed.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center space-y-3">
            {filter === 'unrouted' && active.length > 0 ? (
              <>
                <span className="text-2xl">✓</span>
                <p className="text-sm text-henry-text-dim">All notes have been routed.</p>
              </>
            ) : (
              <>
                <span className="text-2xl">🎙</span>
                <p className="text-sm text-henry-text-dim">
                  {wakeActive
                    ? 'Henry is listening. Captured notes will appear here.'
                    : 'Start listening to capture ambient notes.'}
                </p>
                <p className="text-xs text-henry-text-muted max-w-xs">
                  Say "Hey Henry, remind me to..." or "Henry, note for the project..." and it will appear here with a suggested destination.
                </p>
                {!wakeActive && (
                  <button
                    onClick={() => void toggleListen()}
                    className="mt-2 flex items-center gap-2 text-xs px-4 py-2 rounded-xl bg-henry-accent/10 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/20 transition-all"
                  >
                    <span className="w-2 h-2 rounded-full bg-henry-accent" />
                    Start Listening
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          displayed.map((note) => (
            <CaptureCard key={note.id} note={note} />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-henry-border/30 shrink-0">
        <div className="flex items-center justify-between text-xs text-henry-text-muted">
          <span>Captures are stored locally on this device.</span>
          {captures.length > 0 && (
            <button
              onClick={async () => {
                // R3-Fix 1: in-app confirm instead of native window.confirm.
                if (await confirmDialog('Clear all captures? This cannot be undone.', { destructive: true, confirmLabel: 'Clear all' })) clearAll();
              }}
              className="hover:text-henry-error/80 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
