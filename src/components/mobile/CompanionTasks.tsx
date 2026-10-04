/**
 * Companion Tasks Screen
 *
 * Shows tasks synced from the desktop. Grouped by status.
 * Read-only with a quick "copy result" action.
 */

import { useState } from 'react';
import { useSyncStore } from '../../sync/syncStore';
import type { SyncTask } from '../../sync/types';

const STATUS_GROUPS = [
  { key: 'running', label: 'Active', icon: '⚡', accent: 'text-henry-warning' },
  { key: 'queued', label: 'Queued', icon: '🔄', accent: 'text-henry-accent' },
  { key: 'pending', label: 'Pending', icon: '⏳', accent: 'text-henry-text-muted' },
  { key: 'completed', label: 'Completed', icon: '✅', accent: 'text-henry-success' },
  { key: 'failed', label: 'Failed', icon: '❌', accent: 'text-henry-error' },
  { key: 'cancelled', label: 'Cancelled', icon: '🚫', accent: 'text-henry-text-muted' },
];

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Low',
  2: 'Normal',
  3: 'High',
  4: 'Critical',
};

export default function CompanionTasks() {
  const { tasks } = useSyncStore();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>('all');

  const filtered =
    activeFilter === 'all'
      ? tasks
      : tasks.filter((t) => t.status === activeFilter);

  const grouped = STATUS_GROUPS.map((g) => ({
    ...g,
    tasks: filtered.filter((t) => t.status === g.key),
  })).filter((g) => g.tasks.length > 0);

  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3">
        <h1 className="text-xl font-bold text-henry-text">Tasks</h1>
        <p className="text-xs text-henry-text-muted mt-0.5">
          {tasks.length} total · {counts['running'] ?? 0} active
        </p>
      </div>

      {/* Filter chips */}
      <div className="shrink-0 flex gap-2 overflow-x-auto px-4 pb-3 scrollbar-none">
        {['all', ...STATUS_GROUPS.map((g) => g.key)].map((key) => {
          const count = key === 'all' ? tasks.length : (counts[key] ?? 0);
          if (key !== 'all' && count === 0) return null;
          return (
            <button
              key={key}
              onClick={() => setActiveFilter(key)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                activeFilter === key
                  ? 'bg-henry-accent text-white'
                  : 'bg-henry-surface text-henry-text-muted border border-henry-border/30'
              }`}
            >
              {key === 'all' ? 'All' : key.charAt(0).toUpperCase() + key.slice(1)}
              {count > 0 && (
                <span className={`ml-1 ${activeFilter === key ? 'text-white/70' : 'text-henry-text-muted'}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4 space-y-4">
        {tasks.length === 0 && (
          <p className="text-center text-sm text-henry-text-muted py-10">
            No tasks yet
          </p>
        )}
        {grouped.map((group) => (
          <section key={group.key}>
            <p className={`text-xs font-semibold uppercase tracking-wider mb-2 ${group.accent}`}>
              {group.icon} {group.label} ({group.tasks.length})
            </p>
            <div className="space-y-2">
              {group.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  isExpanded={expanded === task.id}
                  onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  isExpanded,
  onToggle,
}: {
  task: SyncTask;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyResult() {
    if (!task.result) return;
    try {
      await navigator.clipboard.writeText(task.result);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }

  return (
    <div className="bg-henry-surface rounded-2xl border border-henry-border/20 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3.5 flex items-start gap-3 active:bg-henry-surface/70 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm text-henry-text leading-snug line-clamp-2">
            {task.description}
          </p>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-[10px] text-henry-text-muted">
              {task.type}
            </span>
            {task.priority >= 3 && (
              <span className="text-[10px] text-henry-warning font-medium">
                {PRIORITY_LABELS[task.priority]}
              </span>
            )}
            {task.cost != null && task.cost > 0 && (
              <span className="text-[10px] text-henry-text-muted">
                ${task.cost.toFixed(4)}
              </span>
            )}
            <span className="text-[10px] text-henry-text-muted ml-auto">
              {formatAge(Date.now() - new Date(task.created_at).getTime())} ago
            </span>
          </div>
        </div>
        <svg
          className={`w-4 h-4 text-henry-text-muted shrink-0 mt-0.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 border-t border-henry-border/20 pt-3 space-y-2">
          {task.result && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider">
                  Result
                </p>
                <button
                  onClick={() => void copyResult()}
                  className="text-[10px] text-henry-accent active:opacity-60 transition-opacity"
                >
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-henry-text leading-relaxed line-clamp-6">
                {task.result}
              </p>
            </div>
          )}
          {task.error && (
            <div>
              <p className="text-[10px] font-medium text-henry-error uppercase tracking-wider mb-1">
                Error
              </p>
              <p className="text-xs text-henry-error/80 leading-relaxed">{task.error}</p>
            </div>
          )}
          {task.started_at && (
            <p className="text-[10px] text-henry-text-muted">
              Started {new Date(task.started_at).toLocaleString()}
            </p>
          )}
          {task.completed_at && (
            <p className="text-[10px] text-henry-text-muted">
              Completed {new Date(task.completed_at).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
