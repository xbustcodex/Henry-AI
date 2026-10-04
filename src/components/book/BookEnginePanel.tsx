/**
 * BookEnginePanel — capture Topher's life material for his book (build plan,
 * Phase 3). Stories, lessons, letters, faith, the MS journey, fatherhood,
 * rebuilding, money. Capture it here; the Book Crew shapes it into chapters.
 *
 * Reads via `listBookEntries`, writes via `createBookEntry` / `update` / `delete`.
 * Everything stays on this device — these are Topher's own words.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import CoverStudio from './CoverStudio';

type Entry = HenryBookEntry;
type Section = 'material' | 'cover';
type Kind = Entry['kind'];

const KINDS: { id: Kind; label: string }[] = [
  { id: 'story', label: 'Story' },
  { id: 'lesson', label: 'Lesson' },
  { id: 'letter', label: 'Letter' },
  { id: 'faith', label: 'Faith' },
  { id: 'health', label: 'MS / Health' },
  { id: 'fatherhood', label: 'Fatherhood' },
  { id: 'business', label: 'Business' },
  { id: 'money', label: 'Money' },
  { id: 'other', label: 'Other' },
];
const LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label])) as Record<Kind, string>;

function api() {
  return typeof window !== 'undefined' ? window.henryAPI : undefined;
}

export default function BookEnginePanel() {
  const [section, setSection] = useState<Section>('material');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Kind | 'all'>('all');

  const [draftKind, setDraftKind] = useState<Kind>('story');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api()?.listBookEntries?.();
      if (!res) { setError('The Book Engine is only available in the desktop app.'); setEntries([]); return; }
      if (!res.ok) { setError(res.error || 'Could not load your material.'); setEntries([]); return; }
      setEntries(res.result ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your material.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    const content = draftContent.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      const res = await api()?.createBookEntry?.({ content, kind: draftKind, title: draftTitle.trim() || undefined });
      if (res?.ok && res.result) {
        setEntries((prev) => [res.result as Entry, ...prev]);
        setDraftTitle('');
        setDraftContent('');
      } else if (res && !res.ok) {
        setError(res.error || 'Could not save.');
      }
    } finally {
      setSaving(false);
    }
  }, [draftContent, draftKind, draftTitle, saving]);

  const remove = useCallback(async (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try { await api()?.deleteBookEntry?.(id); } catch { void load(); }
  }, [load]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    return m;
  }, [entries]);

  const shown = filter === 'all' ? entries : entries.filter((e) => e.kind === filter);

  return (
    <div className="h-full overflow-y-auto bg-henry-bg">
      <div className={`${section === 'cover' ? 'max-w-5xl' : 'max-w-3xl'} mx-auto px-5 py-6`}>
        <h1 className="text-xl font-semibold text-henry-text">Book</h1>
        <p className="text-xs text-henry-text-muted mb-4">
          {section === 'material'
            ? "Your life story, captured piece by piece. Save a moment, a lesson, a letter — the Book Crew turns it into chapters when you're ready."
            : 'Design your book cover — Henry can teach you step by step, or generate and compose it for you.'}
        </p>

        {/* Section tabs */}
        <div className="flex items-center gap-1.5 mb-5">
          <SectionTab active={section === 'material'} onClick={() => setSection('material')} label="📖 Material" />
          <SectionTab active={section === 'cover'} onClick={() => setSection('cover')} label="🎨 Cover Studio" />
        </div>

        {section === 'cover' && <CoverStudio />}

        {section === 'material' && (
        <>
        {/* Capture */}
        <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4 mb-5">
          <div className="flex gap-2 mb-2">
            <select
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value as Kind)}
              className="bg-henry-surface border border-henry-border/30 rounded-lg px-2 py-1.5 text-xs text-henry-text outline-none"
            >
              {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Title (optional)"
              className="flex-1 bg-henry-surface border border-henry-border/30 rounded-lg px-3 py-1.5 text-sm text-henry-text placeholder:text-henry-text-muted outline-none"
            />
          </div>
          <textarea
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            placeholder="Write it in your own words…"
            rows={4}
            className="w-full bg-henry-surface border border-henry-border/30 rounded-lg px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none resize-y leading-relaxed"
          />
          <div className="flex justify-end mt-2">
            <button
              onClick={() => void save()}
              disabled={saving || !draftContent.trim()}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Save to book'}
            </button>
          </div>
        </div>

        {/* Filters */}
        {entries.length > 0 && (
          <div className="flex items-center flex-wrap gap-1.5 mb-4">
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label={`All ${entries.length}`} />
            {KINDS.filter((k) => counts.get(k.id)).map((k) => (
              <FilterChip key={k.id} active={filter === k.id} onClick={() => setFilter(k.id)} label={`${k.label} ${counts.get(k.id)}`} />
            ))}
          </div>
        )}

        {loading && <div className="text-sm text-henry-text-muted py-12 text-center">Loading…</div>}
        {!loading && error && (
          <div className="bg-henry-surface/50 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
            {error}
            <button onClick={() => void load()} className="block mt-2 text-henry-accent hover:underline">Try again</button>
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="text-sm text-henry-text-muted py-10 text-center leading-relaxed">
            Nothing captured yet. Start with one true thing — a memory, a lesson, a letter to your kids.<br />
            You can also just tell Henry in chat: "save this for the book."
          </div>
        )}

        {!loading && !error && shown.length > 0 && (
          <div className="space-y-3">
            {shown.map((e) => <EntryCard key={e.id} entry={e} onRemove={remove} />)}
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}

function SectionTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors border ${
        active
          ? 'bg-henry-accent/15 border-henry-accent/40 text-henry-accent'
          : 'border-henry-border/30 text-henry-text-muted hover:text-henry-text hover:bg-henry-surface/60'
      }`}
    >
      {label}
    </button>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
        active ? 'bg-henry-accent/15 text-henry-accent' : 'text-henry-text-muted hover:text-henry-text hover:bg-henry-surface/60'
      }`}
    >
      {label}
    </button>
  );
}

function EntryCard({ entry, onRemove }: { entry: Entry; onRemove: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const long = entry.content.length > 280;
  const text = expanded || !long ? entry.content : entry.content.slice(0, 280) + '…';
  return (
    <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-henry-accent/10 text-henry-accent">{LABEL[entry.kind]}</span>
          {entry.title && <span className="ml-2 text-sm font-medium text-henry-text">{entry.title}</span>}
        </div>
        <button onClick={() => onRemove(entry.id)} title="Remove" className="text-henry-text-muted hover:text-red-400 transition-colors text-xs px-1 flex-shrink-0">✕</button>
      </div>
      <p className="text-sm text-henry-text mt-2 whitespace-pre-wrap leading-relaxed">{text}</p>
      {long && (
        <button onClick={() => setExpanded((v) => !v)} className="mt-1 text-[11px] text-henry-accent hover:underline">
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
      {entry.updated_at && (
        <p className="text-[10px] text-henry-text-muted mt-2">{new Date(entry.updated_at).toLocaleDateString()}</p>
      )}
    </div>
  );
}
