import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import type { Task, TaskStatus } from '../../types';
import { writerDraftDirForPath } from '@/henry/writerDraftIndex';
import { requestFilesTabOpenRelativeDir } from '@/henry/writerDraftContext';
import { getAmbientItems, removeAmbientItem, type AmbientItem } from '../../ambient/memoryRecall';
import { sendToHenry } from '../../actions/store/chatBridgeStore';
import { henryQuickAsk } from '../../henry/henryQuickAsk';

const STATUS_CONFIG: Record<TaskStatus, { icon: string; label: string; color: string }> = {
  pending: { icon: '⏳', label: 'Pending', color: 'text-henry-text-muted' },
  queued: { icon: '📥', label: 'Queued', color: 'text-yellow-400' },
  running: { icon: '⚡', label: 'Running', color: 'text-henry-worker' },
  completed: { icon: '✅', label: 'Done', color: 'text-henry-success' },
  failed: { icon: '❌', label: 'Failed', color: 'text-henry-error' },
  cancelled: { icon: '🚫', label: 'Cancelled', color: 'text-henry-text-muted' },
};

function AmbientTasksSection() {
  const setCurrentView = useStore((s) => s.setCurrentView);
  const [items, setItems] = useState<AmbientItem[]>([]);

  useEffect(() => {
    setItems(getAmbientItems('tasks', 10));
  }, []);

  function dismiss(id: string) {
    removeAmbientItem('tasks', id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  function promoteToChat(text: string) {
    sendToHenry(`Turn this into a task: ${text}`);
    setCurrentView('chat');
  }

  if (items.length === 0) return null;

  return (
    <div className="mt-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-henry-text-muted">
          Captured tasks
        </p>
        <button
          onClick={() => setCurrentView('captures')}
          className="text-[10px] text-henry-text-muted hover:text-henry-accent transition-colors"
        >
          See all in Captures →
        </button>
      </div>
      <div className="space-y-1.5">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-start gap-3 px-3 py-2.5 rounded-xl border border-henry-border/20 bg-henry-surface/20 group"
          >
            <span className="text-henry-text-muted mt-0.5 shrink-0">📋</span>
            <p className="flex-1 text-xs text-henry-text-dim leading-relaxed">{item.text}</p>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => promoteToChat(item.text)}
                title="Turn into a task with Henry"
                className="text-[10px] px-2 py-0.5 rounded bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-colors"
              >
                Add
              </button>
              <button
                onClick={() => dismiss(item.id)}
                title="Dismiss"
                className="text-[10px] px-2 py-0.5 rounded bg-henry-hover/60 text-henry-text-muted hover:text-henry-text transition-colors"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TaskQueueView() {
  const { tasks, setTasks, updateTask } = useStore();
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');
  const [stats, setStats] = useState<any>(null);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  useEffect(() => {
    loadTasks();
    loadStats();

    // Listen for real-time task updates
    const unsub = window.henryAPI.onTaskUpdate((data) => {
      updateTask(data.id, data);
      loadStats();
    });

    return unsub;
  }, []);

  async function loadTasks() {
    try {
      const allTasks = await window.henryAPI.getTasks();
      setTasks(allTasks);
    } catch (err) {
      console.error('Failed to load tasks:', err);
    }
  }

  async function loadStats() {
    try {
      const s = await window.henryAPI.getTaskStats();
      setStats(s);
    } catch (err) {
      console.error('Failed to load task stats:', err);
    }
  }

  async function cancelTask(id: string) {
    try {
      await window.henryAPI.cancelTask(id);
      await loadTasks();
    } catch (err) {
      console.error('Failed to cancel task:', err);
    }
  }

  async function retryTask(id: string) {
    try {
      await window.henryAPI.retryTask(id);
      await loadTasks();
    } catch (err) {
      console.error('Failed to retry task:', err);
    }
  }

  const filteredTasks = filter === 'all'
    ? tasks
    : tasks.filter((t) => t.status === filter);

  const statusCounts = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-henry-border/50">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center justify-between w-full">
                <h1 className="text-lg font-semibold text-henry-text">Task Queue</h1>
                <button
                onClick={() => henryQuickAsk({ prompt: 'Review my task queue. What should I work on next? Are there any tasks I can batch or delegate? What needs my attention most?' })}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all"
              >🧠 Ask Henry</button>
              </div>
          <div className="flex items-center gap-2">
            {stats?.activeCount > 0 && (
              <span className="flex items-center gap-1.5 px-3 py-1 bg-henry-worker/10 text-henry-worker text-xs rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-henry-worker animate-pulse" />
                {stats.activeCount} active
              </span>
            )}
            {stats?.totalCost > 0 && (
              <span className="text-xs text-henry-text-muted">
                Total: ${stats.totalCost.toFixed(4)}
              </span>
            )}
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1">
          {(['all', 'queued', 'running', 'completed', 'failed'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                filter === f
                  ? 'bg-henry-accent/10 text-henry-accent font-medium'
                  : 'text-henry-text-dim hover:text-henry-text hover:bg-henry-hover/50'
              }`}
            >
              {f === 'all' ? 'All' : STATUS_CONFIG[f]?.label || f}
              {f === 'all' ? ` (${tasks.length})` : statusCounts[f] ? ` (${statusCounts[f]})` : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-4">
        {filteredTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-4xl mb-4">📋</div>
            <h3 className="text-sm font-medium text-henry-text mb-1">
              {filter === 'all' ? 'No tasks yet' : `No ${filter} tasks`}
            </h3>
            <p className="text-xs text-henry-text-muted max-w-xs">
              Tasks appear here when you ask Henry's Worker engine to do heavy lifting —
              code generation, research, file operations, and more.
            </p>
          </div>
        ) : (
          <div className="space-y-2 max-w-3xl mx-auto">
            {filteredTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                expanded={expandedTask === task.id}
                onToggle={() =>
                  setExpandedTask(expandedTask === task.id ? null : task.id)
                }
                onCancel={() => cancelTask(task.id)}
                onRetry={() => retryTask(task.id)}
              />
            ))}
          </div>
        )}
        <AmbientTasksSection />
      </div>
    </div>
  );
}

function TaskCard({
  task,
  expanded,
  onToggle,
  onCancel,
  onRetry,
}: {
  task: Task;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const setCurrentView = useStore((s) => s.setCurrentView);
  const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;

  function openRelatedInFiles() {
    const p = task.related_file_path?.trim();
    if (!p) return;
    requestFilesTabOpenRelativeDir(writerDraftDirForPath(p));
    setCurrentView('files');
  }

  function formatTime(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function getDuration(): string | null {
    if (!task.started_at) return null;
    const start = new Date(task.started_at).getTime();
    const end = task.completed_at
      ? new Date(task.completed_at).getTime()
      : Date.now();
    const seconds = Math.round((end - start) / 1000);

    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}m ${remainder}s`;
  }

  return (
    <div
      className={`rounded-xl border transition-all ${
        task.status === 'running'
          ? 'bg-henry-worker/5 border-henry-worker/20'
          : task.status === 'failed'
          ? 'bg-henry-error/5 border-henry-error/20'
          : 'bg-henry-surface/30 border-henry-border/20'
      }`}
    >
      {/* Header row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 text-left"
      >
        <span className="text-lg">{config.icon}</span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-henry-text truncate">
              {task.description}
            </span>
            <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-henry-bg/50 text-henry-text-muted">
              {task.type.replace('_', ' ')}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <span className={`text-[10px] ${config.color}`}>
              {config.label}
            </span>
            {task.created_at && (
              <span className="text-[10px] text-henry-text-muted">
                {formatTime(task.created_at)}
              </span>
            )}
            {getDuration() && (
              <span className="text-[10px] text-henry-text-muted">
                ⏱ {getDuration()}
              </span>
            )}
            {task.cost && task.cost > 0 && (
              <span className="text-[10px] text-henry-text-muted">
                ${task.cost.toFixed(4)}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          {task.status === 'running' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              className="px-2 py-1 text-[10px] bg-henry-error/10 text-henry-error rounded hover:bg-henry-error/20 transition-colors"
            >
              Cancel
            </button>
          )}
          {(task.status === 'failed' || task.status === 'cancelled') && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
              className="px-2 py-1 text-[10px] bg-henry-accent/10 text-henry-accent rounded hover:bg-henry-accent/20 transition-colors"
            >
              Retry
            </button>
          )}
          <svg
            className={`w-3 h-3 text-henry-text-muted transition-transform ${
              expanded ? 'rotate-180' : ''
            }`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="6,9 12,15 18,9" />
          </svg>
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-4 animate-fade-in">
          <div className="border-t border-henry-border/20 pt-3 space-y-2">
            {task.result && (
              <div>
                <span className="text-[10px] text-henry-text-muted block mb-1">
                  Result
                </span>
                <pre className="text-xs text-henry-text bg-henry-bg/50 rounded-lg p-3 overflow-auto max-h-60">
                  {typeof task.result === 'string'
                    ? task.result
                    : JSON.stringify(task.result, null, 2)}
                </pre>
              </div>
            )}
            {task.error && (
              <div>
                <span className="text-[10px] text-henry-error block mb-1">
                  Error
                </span>
                <pre className="text-xs text-henry-error/80 bg-henry-error/5 rounded-lg p-3">
                  {task.error}
                </pre>
              </div>
            )}
            <div className="flex gap-4 text-[10px] text-henry-text-muted flex-wrap">
              <span>ID: {task.id.slice(0, 8)}...</span>
              <span>Priority: {task.priority}</span>
              {task.source_engine && <span>From: {task.source_engine}</span>}
              {task.created_from_mode && (
                <span>Chat mode: {task.created_from_mode}</span>
              )}
            </div>
            {task.related_file_path?.trim() && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-[10px] text-henry-text-muted break-all">
                  Linked: <code className="text-henry-text-dim">{task.related_file_path}</code>
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openRelatedInFiles();
                  }}
                  className="text-[10px] px-2 py-1 rounded-lg border border-henry-border/40 text-henry-accent hover:bg-henry-accent/10"
                >
                  Open in Files
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Running progress bar */}
      {task.status === 'running' && (
        <div className="h-0.5 bg-henry-bg/30 rounded-b-xl overflow-hidden">
          <div className="h-full bg-henry-worker animate-pulse rounded-full" style={{ width: '60%' }} />
        </div>
      )}
    </div>
  );
}
