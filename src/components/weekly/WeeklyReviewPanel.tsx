/**
 * Henry AI — Weekly Review / Life Dashboard
 *
 * A perspective view across work, life, open loops, and momentum.
 * Uses real data from threads, tasks, reminders, captures, working memory,
 * and life areas. Not a cold analytics dashboard — a living overview.
 */

import { useMemo, useState, useCallback, useEffect } from 'react';
import { loadActiveThreads, resolveThread, type ContinuityThread } from '../../henry/threads/threadStore';
import { loadWorkingMemory } from '../../henry/workingMemory';
import { getRhythmState } from '../../henry/dailyRhythm';
import { getSessionMode, inferSessionMode, type SessionMode } from '../../henry/sessionModeStore';
import { computeDomainDistribution, LIFE_AREA_LABELS, type LifeArea } from '../../henry/lifeAreas';
import {
  loadOpenCommitments,
  addCommitment,
  resolveCommitment,
  dropCommitment,
  updateCommitmentStatus,
  type Commitment,
  type CommitmentType,
  type CommitmentStatus,
} from '../../henry/commitmentStore';
import {
  loadRelationships,
  addRelationship,
  clearFollowUp,
  markFollowUpNeeded,
  type Relationship,
  type RelationshipType,
} from '../../henry/relationshipStore';
import {
  loadAllValues,
  addValue,
  deactivateValue,
  toggleNonNegotiable,
  type UserValue,
  type ValueCategory,
} from '../../henry/valuesStore';
import { useStore } from '../../store';
import { PANEL_QUICK_ASK } from '../../henry/henryQuickAsk';

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback; const _p = JSON.parse(raw); return (Array.isArray(fallback) && !Array.isArray(_p)) ? fallback : (_p as T);
  } catch { return fallback; }
}

function getWeekLabel(): string {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function relativeDate(iso: string): string {
  const ageDays = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (ageDays < 0.04) return 'just now';
  if (ageDays < 1) return `${Math.round(ageDays * 24)}h ago`;
  if (ageDays < 7) return `${Math.round(ageDays)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isDueSoon(iso?: string): boolean {
  if (!iso) return false;
  const diff = new Date(iso).getTime() - Date.now();
  return diff > 0 && diff < 48 * 3600000; // within 48h
}

function isOverdue(iso?: string): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() < Date.now();
}

const SESSION_LABELS: Record<SessionMode, string> = {
  auto: 'Auto', build: 'Build', admin: 'Admin',
  reflection: 'Reflection', capture: 'Capture', execution: 'Execution',
};

const THREAD_TYPE_LABELS: Record<string, string> = {
  project: 'Project', task: 'Task', conversation: 'Conversation',
  debugging: 'Debug', planning: 'Planning', personal: 'Personal', logistics: 'Logistics',
};

// ── Section components ────────────────────────────────────────────────────────

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-sm font-semibold text-henry-text">{title}</h2>
      {count !== undefined && count > 0 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-henry-border/50 text-henry-text-dim">{count}</span>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <p className="text-xs text-henry-text-dim italic">{message}</p>;
}

// ── Thread card ────────────────────────────────────────────────────────────────

function ThreadCard({ thread, onResolve }: { thread: ContinuityThread; onResolve: (id: string) => void }) {
  const typeLabel = THREAD_TYPE_LABELS[thread.type] ?? thread.type;
  return (
    <div className="rounded-lg border border-henry-border/40 bg-henry-bg px-3 py-2.5 space-y-1">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-henry-text truncate">{thread.title}</p>
          <p className="text-[10px] text-henry-text-dim mt-0.5">
            <span className="text-henry-accent/70">{typeLabel}</span>
            {thread.lastTouched && ` · ${relativeDate(thread.lastTouched)}`}
          </p>
        </div>
        <button
          onClick={() => onResolve(thread.id)}
          className="text-[10px] text-henry-text-dim hover:text-henry-text px-1.5 py-0.5 rounded border border-henry-border/30 hover:border-henry-border/60 transition-colors shrink-0"
        >
          Done
        </button>
      </div>
      {thread.suggestedNextStep && (
        <p className="text-[10px] text-henry-text-dim">
          <span className="text-henry-text/60">→</span> {thread.suggestedNextStep.slice(0, 100)}
        </p>
      )}
      {thread.unresolvedItems.length > 0 && (
        <p className="text-[10px] text-henry-text-dim/70 italic">
          Open: {thread.unresolvedItems.slice(0, 2).join('; ')}
        </p>
      )}
    </div>
  );
}

// ── Life area bar ─────────────────────────────────────────────────────────────

function LifeAreaBar({ area, label, pct }: { area: LifeArea; label: string; pct: number }) {
  const barWidth = `${pct}%`;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-henry-text-dim w-20 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-henry-border/30 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-henry-accent/50 transition-all"
          style={{ width: barWidth }}
        />
      </div>
      <span className="text-[10px] text-henry-text-dim w-8 text-right">{pct}%</span>
    </div>
  );
}

// ── Commitment components ──────────────────────────────────────────────────────

const COMMITMENT_TYPE_LABELS: Record<CommitmentType, string> = {
  personal:   'Personal',
  project:    'Project',
  relational: 'Relational',
  recurring:  'Recurring',
  henry:      'Henry agreed',
};

const COMMITMENT_STATUS_LABELS: Partial<Record<CommitmentStatus, string>> = {
  waiting: 'waiting',
  blocked: 'blocked',
  active:  'in progress',
};

function CommitmentCard({
  commitment,
  onResolve,
  onDrop,
  onBlock,
  onWait,
}: {
  commitment: Commitment;
  onResolve: (id: string) => void;
  onDrop: (id: string) => void;
  onBlock: (id: string, reason: string) => void;
  onWait: (id: string, waitingOn?: string) => void;
}) {
  const [expandedAction, setExpandedAction] = useState<'block' | 'wait' | null>(null);
  const [reason, setReason] = useState('');

  const typeLabel = COMMITMENT_TYPE_LABELS[commitment.type];
  const statusLabel = COMMITMENT_STATUS_LABELS[commitment.status];
  const due = commitment.dueAt ? new Date(commitment.dueAt) : null;
  const overdue = due && due.getTime() < Date.now();
  const dueSoon = due && !overdue && due.getTime() - Date.now() < 48 * 3600000;

  function confirmBlock() {
    onBlock(commitment.id, reason.trim());
    setExpandedAction(null);
    setReason('');
  }

  function confirmWait() {
    onWait(commitment.id, reason.trim() || undefined);
    setExpandedAction(null);
    setReason('');
  }

  function cancelExpanded() {
    setExpandedAction(null);
    setReason('');
  }

  return (
    <div className="rounded-lg border border-henry-border/40 bg-henry-bg px-3 py-2.5 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-henry-text">{commitment.title}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] text-henry-accent/70">{typeLabel}</span>
            {statusLabel && (
              <span className="text-[10px] text-henry-text-dim/60">· {statusLabel}</span>
            )}
            {(overdue || dueSoon) && due && (
              <span className={`text-[10px] ${overdue ? 'text-red-400' : 'text-amber-400/80'}`}>
                · {overdue ? 'overdue' : 'due soon'} ({due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => { setExpandedAction(expandedAction === 'wait' ? null : 'wait'); setReason(''); }}
            title="Mark as waiting on something"
            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
              expandedAction === 'wait'
                ? 'border-henry-accent/40 text-henry-accent'
                : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text hover:border-henry-border/60'
            }`}
          >
            Wait
          </button>
          <button
            onClick={() => { setExpandedAction(expandedAction === 'block' ? null : 'block'); setReason(''); }}
            title="Mark as blocked — add reason"
            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
              expandedAction === 'block'
                ? 'border-amber-400/50 text-amber-400/80'
                : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text hover:border-henry-border/60'
            }`}
          >
            Block
          </button>
          <button
            onClick={() => onDrop(commitment.id)}
            title="Consciously release this commitment"
            className="text-[10px] text-henry-text-dim hover:text-henry-text px-1.5 py-0.5 rounded border border-henry-border/30 hover:border-henry-border/60 transition-colors"
          >
            Drop
          </button>
          <button
            onClick={() => onResolve(commitment.id)}
            className="text-[10px] text-henry-text-dim hover:text-henry-text px-1.5 py-0.5 rounded border border-henry-border/30 hover:border-henry-accent/40 transition-colors"
          >
            Done
          </button>
        </div>
      </div>

      {/* Inline Block reason input */}
      {expandedAction === 'block' && (
        <div className="flex items-center gap-2 pt-0.5">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmBlock(); if (e.key === 'Escape') cancelExpanded(); }}
            placeholder="What's blocking this? (optional)"
            className="flex-1 text-[10px] bg-transparent border-b border-henry-border/40 focus:border-amber-400/30 outline-none py-0.5 text-henry-text placeholder:text-henry-text-dim/50"
          />
          <button onClick={confirmBlock} className="text-[10px] text-amber-400/70 hover:text-amber-400 transition-colors shrink-0">Mark blocked</button>
          <button onClick={cancelExpanded} className="text-[10px] text-henry-text-dim hover:text-henry-text transition-colors shrink-0">Cancel</button>
        </div>
      )}

      {/* Inline Wait reason input */}
      {expandedAction === 'wait' && (
        <div className="flex items-center gap-2 pt-0.5">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmWait(); if (e.key === 'Escape') cancelExpanded(); }}
            placeholder="Waiting on what? (optional)"
            className="flex-1 text-[10px] bg-transparent border-b border-henry-border/40 focus:border-henry-accent/30 outline-none py-0.5 text-henry-text placeholder:text-henry-text-dim/50"
          />
          <button onClick={confirmWait} className="text-[10px] text-henry-accent/70 hover:text-henry-accent transition-colors shrink-0">Mark waiting</button>
          <button onClick={cancelExpanded} className="text-[10px] text-henry-text-dim hover:text-henry-text transition-colors shrink-0">Cancel</button>
        </div>
      )}

      {commitment.description && !expandedAction && (
        <p className="text-[10px] text-henry-text-dim/70 leading-relaxed">
          {commitment.description.slice(0, 120)}
        </p>
      )}
      {commitment.blockedReason && !expandedAction && (
        <p className="text-[10px] text-amber-400/70 italic">
          {commitment.status === 'waiting' ? 'Waiting on:' : 'Blocked:'} {commitment.blockedReason}
        </p>
      )}
    </div>
  );
}

function AddCommitmentForm({ onAdd }: { onAdd: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<CommitmentType>('personal');
  const [weight, setWeight] = useState<'low' | 'medium' | 'high'>('medium');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    addCommitment(t, type, { weight: weight === 'high' ? 8 : weight === 'medium' ? 5 : 3 });
    setTitle('');
    setType('personal');
    setWeight('medium');
    setOpen(false);
    onAdd();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[10px] text-henry-accent/60 hover:text-henry-accent transition-colors mt-1"
      >
        + Add commitment
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-2 p-3 rounded-lg border border-henry-border/40 bg-henry-bg">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What are you committed to?"
        className="w-full text-xs bg-transparent border-b border-henry-border/40 focus:border-henry-accent/40 outline-none py-1 text-henry-text placeholder:text-henry-text-dim"
      />
      <div className="flex items-center gap-3">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as CommitmentType)}
          className="text-[10px] bg-henry-surface border border-henry-border/40 rounded px-1.5 py-1 text-henry-text-dim outline-none"
        >
          {(Object.keys(COMMITMENT_TYPE_LABELS) as CommitmentType[]).map((t) => (
            <option key={t} value={t}>{COMMITMENT_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <div className="flex gap-1">
          {(['low', 'medium', 'high'] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWeight(w)}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                weight === w
                  ? 'border-henry-accent/40 text-henry-accent'
                  : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'
              }`}
            >
              {w}
            </button>
          ))}
        </div>
        <div className="flex gap-1 ml-auto">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-[10px] text-henry-text-dim hover:text-henry-text px-2 py-0.5 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim()}
            className="text-[10px] px-2 py-0.5 rounded border border-henry-border/40 bg-henry-surface text-henry-text-dim hover:text-henry-text hover:border-henry-accent/30 transition-colors disabled:opacity-40"
          >
            Hold it
          </button>
        </div>
      </div>
    </form>
  );
}

// ── Relationship components ────────────────────────────────────────────────────

const RELATIONSHIP_TYPE_LABELS: Record<RelationshipType, string> = {
  family: 'Family', friend: 'Friend', work: 'Work', collaborator: 'Collaborator',
  client: 'Client', vendor: 'Vendor', mentor: 'Mentor', faith: 'Faith', recurring: 'Recurring',
};

function PersonCard({
  person,
  onClearFollowUp,
  onMarkFollowUp,
}: {
  person: Relationship;
  onClearFollowUp: (id: string) => void;
  onMarkFollowUp: (id: string, note?: string) => void;
}) {
  const [addingNote, setAddingNote] = useState(false);
  const [noteText, setNoteText] = useState('');
  const days = person.lastInteraction
    ? Math.round((Date.now() - new Date(person.lastInteraction).getTime()) / 86400000)
    : null;
  const daysStr = days === null ? '' : days === 0 ? ' · today' : ` · ${days}d ago`;

  return (
    <div className="rounded-lg border border-henry-border/40 bg-henry-bg px-3 py-2.5 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-henry-text">{person.name}</p>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-[10px] text-henry-accent/70">{RELATIONSHIP_TYPE_LABELS[person.type]}</span>
            {person.followUpNeeded && (
              <span className="text-[10px] text-amber-400/70">· follow-up needed</span>
            )}
            {daysStr && <span className="text-[10px] text-henry-text-dim/50">{daysStr}</span>}
          </div>
          {person.followUpNote && (
            <p className="text-[10px] text-henry-text-dim/70 italic mt-0.5">{person.followUpNote}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {person.followUpNeeded ? (
            <button
              onClick={() => onClearFollowUp(person.id)}
              className="text-[10px] text-henry-text-dim hover:text-henry-text px-1.5 py-0.5 rounded border border-henry-border/30 hover:border-henry-accent/40 transition-colors"
            >
              Done
            </button>
          ) : (
            <button
              onClick={() => setAddingNote((v) => !v)}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${addingNote ? 'border-amber-400/40 text-amber-400/70' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'}`}
            >
              Follow up
            </button>
          )}
        </div>
      </div>
      {addingNote && (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onMarkFollowUp(person.id, noteText.trim() || undefined); setAddingNote(false); setNoteText(''); }
              if (e.key === 'Escape') { setAddingNote(false); setNoteText(''); }
            }}
            placeholder="Follow up about what? (optional)"
            className="flex-1 text-[10px] bg-transparent border-b border-henry-border/40 focus:border-amber-400/30 outline-none py-0.5 text-henry-text placeholder:text-henry-text-dim/50"
          />
          <button
            onClick={() => { onMarkFollowUp(person.id, noteText.trim() || undefined); setAddingNote(false); setNoteText(''); }}
            className="text-[10px] text-amber-400/70 hover:text-amber-400 shrink-0 transition-colors"
          >
            Set
          </button>
        </div>
      )}
    </div>
  );
}

function AddPersonForm({ onAdd }: { onAdd: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<RelationshipType>('work');
  const [importance, setImportance] = useState<'low' | 'medium' | 'high'>('medium');
  const [followUpNote, setFollowUpNote] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    addRelationship(n, type, {
      importance: importance === 'high' ? 8 : importance === 'medium' ? 5 : 3,
      followUpNeeded: !!followUpNote.trim(),
      followUpNote: followUpNote.trim() || undefined,
    });
    setName(''); setType('work'); setImportance('medium'); setFollowUpNote('');
    setOpen(false);
    onAdd();
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-[10px] text-henry-accent/60 hover:text-henry-accent transition-colors mt-1">
        + Add person
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-2 p-3 rounded-lg border border-henry-border/40 bg-henry-bg">
      <input
        autoFocus value={name} onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        className="w-full text-xs bg-transparent border-b border-henry-border/40 focus:border-henry-accent/40 outline-none py-1 text-henry-text placeholder:text-henry-text-dim"
      />
      <input
        value={followUpNote} onChange={(e) => setFollowUpNote(e.target.value)}
        placeholder="Follow-up note (optional)"
        className="w-full text-[10px] bg-transparent border-b border-henry-border/30 focus:border-henry-accent/30 outline-none py-1 text-henry-text placeholder:text-henry-text-dim"
      />
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={type} onChange={(e) => setType(e.target.value as RelationshipType)}
          className="text-[10px] bg-henry-surface border border-henry-border/40 rounded px-1.5 py-1 text-henry-text-dim outline-none"
        >
          {(Object.keys(RELATIONSHIP_TYPE_LABELS) as RelationshipType[]).map((t) => (
            <option key={t} value={t}>{RELATIONSHIP_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <div className="flex gap-1">
          {(['low', 'medium', 'high'] as const).map((w) => (
            <button key={w} type="button" onClick={() => setImportance(w)}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${importance === w ? 'border-henry-accent/40 text-henry-accent' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'}`}
            >{w}</button>
          ))}
        </div>
        <div className="flex gap-1 ml-auto">
          <button type="button" onClick={() => setOpen(false)} className="text-[10px] text-henry-text-dim hover:text-henry-text px-2 py-0.5 transition-colors">Cancel</button>
          <button type="submit" disabled={!name.trim()}
            className="text-[10px] px-2 py-0.5 rounded border border-henry-border/40 bg-henry-surface text-henry-text-dim hover:text-henry-text hover:border-henry-accent/30 transition-colors disabled:opacity-40"
          >Add</button>
        </div>
      </div>
    </form>
  );
}

// ── Values components ──────────────────────────────────────────────────────────

const VALUE_CATEGORY_LABELS: Record<ValueCategory, string> = {
  faith: 'Faith', family: 'Family', work_ethic: 'Work', integrity: 'Integrity',
  stewardship: 'Stewardship', health: 'Health', creative: 'Creative', pace: 'Pace', principle: 'Principle',
};

function ValueItem({
  value,
  onToggleNonNeg,
  onDeactivate,
}: {
  value: UserValue;
  onToggleNonNeg: (id: string) => void;
  onDeactivate: (id: string) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2 py-1.5 border-b border-henry-border/20 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {value.nonNegotiable && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-henry-accent/10 text-henry-accent/80 shrink-0">non-neg</span>
          )}
          <p className="text-xs text-henry-text truncate">{value.title}</p>
        </div>
        <span className="text-[10px] text-henry-accent/60">{VALUE_CATEGORY_LABELS[value.category]}</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onToggleNonNeg(value.id)}
          title={value.nonNegotiable ? 'Remove non-negotiable flag' : 'Mark as non-negotiable'}
          className="text-[10px] text-henry-text-dim hover:text-henry-text px-1 py-0.5 rounded border border-henry-border/20 hover:border-henry-border/50 transition-colors"
        >
          {value.nonNegotiable ? '★' : '☆'}
        </button>
        <button
          onClick={() => onDeactivate(value.id)}
          title="Remove this value"
          className="text-[10px] text-henry-text-dim/40 hover:text-henry-text-dim px-1 py-0.5 transition-colors"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function AddValueForm({ onAdd }: { onAdd: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<ValueCategory>('principle');
  const [importance, setImportance] = useState<'low' | 'medium' | 'high'>('medium');
  const [nonNeg, setNonNeg] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    addValue(t, category, {
      importance: importance === 'high' ? 8 : importance === 'medium' ? 5 : 3,
      nonNegotiable: nonNeg,
    });
    setTitle(''); setCategory('principle'); setImportance('medium'); setNonNeg(false);
    setOpen(false);
    onAdd();
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-[10px] text-henry-accent/60 hover:text-henry-accent transition-colors mt-1">
        + Add value
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-2 p-3 rounded-lg border border-henry-border/40 bg-henry-bg">
      <input
        autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="What do you value or stand for?"
        className="w-full text-xs bg-transparent border-b border-henry-border/40 focus:border-henry-accent/40 outline-none py-1 text-henry-text placeholder:text-henry-text-dim"
      />
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={category} onChange={(e) => setCategory(e.target.value as ValueCategory)}
          className="text-[10px] bg-henry-surface border border-henry-border/40 rounded px-1.5 py-1 text-henry-text-dim outline-none"
        >
          {(Object.keys(VALUE_CATEGORY_LABELS) as ValueCategory[]).map((c) => (
            <option key={c} value={c}>{VALUE_CATEGORY_LABELS[c]}</option>
          ))}
        </select>
        <div className="flex gap-1">
          {(['low', 'medium', 'high'] as const).map((w) => (
            <button key={w} type="button" onClick={() => setImportance(w)}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${importance === w ? 'border-henry-accent/40 text-henry-accent' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'}`}
            >{w}</button>
          ))}
        </div>
        <button
          type="button" onClick={() => setNonNeg((v) => !v)}
          className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${nonNeg ? 'border-henry-accent/50 text-henry-accent' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'}`}
        >
          {nonNeg ? '★ non-negotiable' : '☆ mark non-neg'}
        </button>
        <div className="flex gap-1 ml-auto">
          <button type="button" onClick={() => setOpen(false)} className="text-[10px] text-henry-text-dim hover:text-henry-text px-2 py-0.5 transition-colors">Cancel</button>
          <button type="submit" disabled={!title.trim()}
            className="text-[10px] px-2 py-0.5 rounded border border-henry-border/40 bg-henry-surface text-henry-text-dim hover:text-henry-text hover:border-henry-accent/30 transition-colors disabled:opacity-40"
          >Add</button>
        </div>
      </div>
    </form>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function WeeklyReviewPanel() {
  const { setCurrentView } = useStore();

  // Live data from SQLite — tasks, finance, focus, journal
  const [weekSummary, setWeekSummary] = useState('');
  const [weekSummaryBusy, setWeekSummaryBusy] = useState(false);
  const [weekData, setWeekData] = useState<{
    tasks: { title:string; status:string }[];
    journal: { date:string; title?:string; mood?:string }[];
    finance: { type:string; total:number }[];
    focusStats: { mins:number; sessions:number } | null;
    reminders: { title:string; due_at:string }[];
    memories: { fact:string; category:string }[];
  }>({ tasks:[], journal:[], finance:[], focusStats:null, reminders:[], memories:[] });

  useEffect(() => {
    const api = (window as any).henryAPI;
    if (!api?.weeklyData) return;
    api.weeklyData().then((d:any) => { if(d) setWeekData(d); }).catch(() => {});
  }, []);

  // Commitments — local state drives re-render on change
  const [commitments, setCommitments] = useState<Commitment[]>(() => loadOpenCommitments());

  async function generateWeeklySummary() {
    if (weekSummaryBusy) return;
    setWeekSummaryBusy(true);
    setWeekSummary('');
    const ownerName = localStorage.getItem('henry:owner_name') || 'you';
    const tasksDone = weekData.tasks.filter(t => t.status === 'done').length;
    const tasksOpen = weekData.tasks.filter(t => t.status !== 'done').length;
    const journalDays = weekData.journal.length;
    const focusMins = weekData.focusStats?.mins || 0;
    const commitsDone = commitments.filter(c => c.status === 'resolved').length;
    const parts = [
      `Tasks: ${tasksDone} done, ${tasksOpen} still open`,
      journalDays ? `Journal: ${journalDays} entries this week` : '',
      focusMins ? `Focus: ${focusMins} minutes of deep work` : '',
      commitsDone ? `Commitments resolved: ${commitsDone}` : '',
      weekData.reminders.length ? `Open reminders: ${weekData.reminders.length}` : '',
    ].filter(Boolean).join('. ');
    const prompt = `Write a brief weekly review for ${ownerName}.

This week: ${parts || 'not much data yet'}.

Format:
**What went well:** 1-2 sentences
**What to carry forward:** 1-2 bullets
**One focus for next week:** 1 sentence

Be encouraging and specific. Keep it under 80 words total.`;
    const deviceId = (() => { let id = localStorage.getItem('henry:device_id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('henry:device_id', id); } return id; })();
    try {
      const r = await fetch('https://henry-proxy.henryai.workers.dev/v1/chat', {
        signal: AbortSignal.timeout(25000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Henry-Device': deviceId },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 300, stream: false }),
      });
      const d = await r.json() as any;
      setWeekSummary(d?.choices?.[0]?.message?.content || 'No response');
    } catch { setWeekSummary('Could not reach Henry AI.'); }
    setWeekSummaryBusy(false);
  }

  const refreshCommitments = useCallback(() => {
    setCommitments(loadOpenCommitments());
  }, []);

  function handleResolveCommitment(id: string) {
    resolveCommitment(id);
    refreshCommitments();
  }

  function handleDropCommitment(id: string) {
    dropCommitment(id);
    refreshCommitments();
  }

  function handleBlockCommitment(id: string, reason: string) {
    updateCommitmentStatus(id, 'blocked', reason || undefined);
    refreshCommitments();
  }

  function handleWaitCommitment(id: string, waitingOn?: string) {
    updateCommitmentStatus(id, 'waiting', waitingOn);
    refreshCommitments();
  }

  // People — relationships with open follow-ups
  const [people, setPeople] = useState<Relationship[]>(() => loadRelationships().filter((r) => r.followUpNeeded || r.importance >= 7));

  const refreshPeople = useCallback(() => {
    setPeople(loadRelationships().filter((r) => r.followUpNeeded || r.importance >= 7));
  }, []);

  function handleClearFollowUp(id: string) {
    clearFollowUp(id);
    refreshPeople();
  }

  function handleMarkFollowUp(id: string, note?: string) {
    markFollowUpNeeded(id, note);
    refreshPeople();
  }

  // Values — user's standards and priorities
  const [values, setValues] = useState<UserValue[]>(() => loadAllValues());

  const weekIncome = weekData.finance.find((f:any)=>f.type==='income')?.total || 0;
  const weekExpenses = weekData.finance.find((f:any)=>f.type==='expense')?.total || 0;
  const doneTasks = weekData.tasks.filter((t:any)=>t.status==='done').length;
  const pendingTasks = weekData.tasks.filter((t:any)=>t.status!=='done').length;

  function debriefWithHenry() {
    const threads = loadActiveThreads();
    const commitments = loadOpenCommitments();
    const weekLabel = getWeekLabel();
    const openCount = threads.length;
    const commitCount = commitments.filter(c => c.status === 'open').length;
    const prompt = `Help me do my weekly review for the week of ${weekLabel}. I have ${openCount} open threads and ${commitCount} open commitments. Walk me through: What did I accomplish? What's still open? What should I carry into next week? What should I drop or delegate?`;
    // Stamp the review date so nudges don't fire again this week
    try { localStorage.setItem('henry:weekly_review_last', new Date().toISOString()); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode: 'companion', prompt } }));
    useStore.getState().setCurrentView('chat');
  }


  const refreshValues = useCallback(() => {
    setValues(loadAllValues());
  }, []);

  function handleToggleNonNeg(id: string) {
    toggleNonNegotiable(id);
    refreshValues();
  }

  function handleDeactivateValue(id: string) {
    deactivateValue(id);
    refreshValues();
  }

  const threads = useMemo(() => loadActiveThreads().slice(0, 5), []);
  const openLoops = useMemo(() =>
    loadWorkingMemory()
      .filter((i) => !i.resolved && (i.type === 'question' || i.type === 'commitment' || i.type === 'concern'))
      .slice(0, 8),
    [],
  );

  const reminders = useMemo(() => {
    const all = safeJSON<Array<{ id: string; title: string; dueDate?: string; completed?: boolean }>>(
      'henry:reminders', [],
    );
    return all
      .filter((r) => !r.completed && (isDueSoon(r.dueDate) || isOverdue(r.dueDate)))
      .slice(0, 6);
  }, []);

  const captures = useMemo(() => {
    const all = safeJSON<Array<{ id: string; text?: string; content?: string; createdAt?: string; routed?: boolean }>>(
      'henry:captures_v1', [],
    );
    return all.slice(0, 5);
  }, []);

  const domainDist = useMemo(() => computeDomainDistribution().slice(0, 5), []);

  const rhythm = useMemo(() => getRhythmState(), []);
  const rawSessionMode = getSessionMode();
  const effectiveSession = rawSessionMode === 'auto' ? inferSessionMode(rhythm.phase) : rawSessionMode;

  function handleResolveThread(id: string) {
    resolveThread(id);
    // Force re-render by navigating away and back isn't ideal, but since this
    // is a perspective view the user can refresh by switching away/back.
  }

  const weekLabel = getWeekLabel();

  return (
    <div className="h-full overflow-y-auto bg-henry-bg">
      <div className="max-w-2xl mx-auto p-6 space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-base font-semibold text-henry-text">Weekly Overview</h1>
            <p className="text-xs text-henry-text-dim mt-0.5">Week of {weekLabel}</p>
          </div>
          <button onClick={() => void generateWeeklySummary()} disabled={weekSummaryBusy}
            className="text-[11px] px-3 py-1.5 rounded-xl bg-henry-accent/15 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/25 disabled:opacity-40 transition-all flex-shrink-0">
            {weekSummaryBusy ? '⟳ Thinking…' : '⚡ Week summary'}
          </button>
          <div className="flex items-center gap-2 text-[10px] text-henry-text-dim">
            <button
              onClick={() => PANEL_QUICK_ASK.weekly()}
              className="px-2.5 py-1 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all font-medium text-[11px]"
            >🧠 Ask Henry</button>
            <span className="px-2 py-1 rounded-md bg-henry-surface border border-henry-border/40">
              {rhythm.label}
            </span>
            <span className="px-2 py-1 rounded-md bg-henry-surface border border-henry-border/40">
              {SESSION_LABELS[effectiveSession]}{rawSessionMode === 'auto' ? ' (auto)' : ''}
            </span>
          </div>
        </div>

        {/* Active Threads */}
        <div>
          <SectionHeader title="Active threads" count={threads.length} />
          {threads.length === 0 ? (
            <EmptyState message="No active threads. Start a project or conversation and Henry will track it here." />
          ) : (
            <div className="space-y-2">
              {threads.map((t) => (
                <ThreadCard key={t.id} thread={t} onResolve={handleResolveThread} />
              ))}
            </div>
          )}
        </div>

        {/* Open Commitments */}
        <div>
          <SectionHeader title="Open commitments" count={commitments.length} />
          {commitments.length === 0 ? (
            <EmptyState message="Nothing held here yet. Use 'Add commitment' to record what matters." />
          ) : (
            <div className="space-y-2">
              {commitments.map((c) => (
                <CommitmentCard
                  key={c.id}
                  commitment={c}
                  onResolve={handleResolveCommitment}
                  onDrop={handleDropCommitment}
                  onBlock={handleBlockCommitment}
                  onWait={handleWaitCommitment}
                />
              ))}
            </div>
          )}
          <AddCommitmentForm onAdd={refreshCommitments} />
        </div>

        {/* People */}
        <div>
          <SectionHeader title="People" count={people.length > 0 ? people.filter((p) => p.followUpNeeded).length || undefined : undefined} />
          {people.length === 0 ? (
            <EmptyState message="No relationships tracked yet. Add people whose relational context matters." />
          ) : (
            <div className="space-y-2">
              {people.slice(0, 6).map((p) => (
                <PersonCard
                  key={p.id}
                  person={p}
                  onClearFollowUp={handleClearFollowUp}
                  onMarkFollowUp={handleMarkFollowUp}
                />
              ))}
            </div>
          )}
          <AddPersonForm onAdd={refreshPeople} />
        </div>

        {/* Open Loops */}
        <div>
          <SectionHeader title="Open loops" count={openLoops.length} />
          {openLoops.length === 0 ? (
            <EmptyState message="No open questions or commitments tracked." />
          ) : (
            <ul className="space-y-1.5">
              {openLoops.map((item) => (
                <li key={item.id} className="flex items-start gap-2">
                  <span className="text-henry-accent/60 text-[10px] mt-0.5 shrink-0">
                    {item.type === 'question' ? '?' : item.type === 'commitment' ? '→' : '!'}
                  </span>
                  <p className="text-xs text-henry-text-dim leading-relaxed">{item.content.slice(0, 120)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Upcoming Pressure */}
        {reminders.length > 0 && (
          <div>
            <SectionHeader title="Upcoming" count={reminders.length} />
            <ul className="space-y-1.5">
              {reminders.map((r) => (
                <li key={r.id} className="flex items-start gap-2">
                  <span className={`text-[10px] shrink-0 mt-0.5 ${isOverdue(r.dueDate) ? 'text-red-400' : 'text-henry-accent/60'}`}>
                    {isOverdue(r.dueDate) ? 'overdue' : 'soon'}
                  </span>
                  <p className="text-xs text-henry-text-dim">{r.title}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Recent Captures */}
        {captures.length > 0 && (
          <div>
            <SectionHeader title="Recent captures" />
            <ul className="space-y-1.5">
              {captures.map((c, i) => {
                const text = c.text ?? c.content ?? '';
                return (
                  <li key={c.id ?? i} className="flex items-start gap-2">
                    <span className="text-henry-text-dim/40 text-[10px] shrink-0 mt-0.5">
                      {c.routed ? '✓' : '·'}
                    </span>
                    <p className="text-xs text-henry-text-dim leading-relaxed">{text.slice(0, 100)}{text.length > 100 ? '…' : ''}</p>
                  </li>
                );
              })}
            </ul>
            <button
              onClick={() => setCurrentView('captures')}
              className="mt-2 text-[10px] text-henry-accent/70 hover:text-henry-accent transition-colors"
            >
              View all captures →
            </button>
          </div>
        )}

        {/* Life Areas */}
        {domainDist.length > 0 && (
          <div>
            <SectionHeader title="Life areas this week" />
            <div className="space-y-2">
              {domainDist.map((d) => (
                <LifeAreaBar key={d.area} area={d.area} label={d.label} pct={d.pct} />
              ))}
            </div>
            {domainDist.length >= 3 && (() => {
              const neglected = (['faith', 'health', 'family', 'creative', 'growth'] as LifeArea[])
                .filter((a) => !domainDist.find((d) => d.area === a));
              if (neglected.length === 0) return null;
              return (
                <p className="text-[10px] text-henry-text-dim/60 italic mt-2">
                  Quiet this week: {neglected.map((a) => LIFE_AREA_LABELS[a]).join(', ')}.
                </p>
              );
            })()}
          </div>
        )}

        {/* Your Values */}
        <div>
          <SectionHeader title="Your values" count={values.length > 0 ? values.length : undefined} />
          {values.length === 0 ? (
            <EmptyState message="No values set yet. Add what you actually stand for — not what sounds good." />
          ) : (
            <div>
              {values.map((v) => (
                <ValueItem
                  key={v.id}
                  value={v}
                  onToggleNonNeg={handleToggleNonNeg}
                  onDeactivate={handleDeactivateValue}
                />
              ))}
            </div>
          )}
          <AddValueForm onAdd={refreshValues} />
        </div>

        {/* Quick actions */}
        <div>
          <SectionHeader title="Quick navigation" />
          <div className="flex flex-wrap gap-2">
            {([
              { view: 'today', label: 'Today' },
              { view: 'tasks', label: 'Tasks' },
              { view: 'reminders', label: 'Reminders' },
              { view: 'captures', label: 'Captures' },
              { view: 'workspace', label: 'Workspace' },
              { view: 'journal', label: 'Journal' },
            ] as { view: Parameters<typeof setCurrentView>[0]; label: string }[]).map(({ view, label }) => (
              <button
                key={view}
                onClick={() => setCurrentView(view)}
                className="text-[10px] px-2.5 py-1.5 rounded-lg border border-henry-border/40 bg-henry-surface text-henry-text-dim hover:text-henry-text hover:border-henry-accent/30 transition-colors"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
