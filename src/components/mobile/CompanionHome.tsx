/**
 * Companion Home Screen
 *
 * Shows:
 *   - Desktop status (online / busy / activity)
 *   - Recent tasks (last 5)
 *   - Pending approvals badge / quick action
 *   - Recent conversations preview
 *   - Quick-capture shortcut
 */

import type { CompanionView } from './CompanionApp';
import { useSyncStore } from '../../sync/syncStore';

const COMPANION_MODE_KEY = 'henry:companion:mode';
function switchToFullMode() {
  try { localStorage.setItem(COMPANION_MODE_KEY, 'full'); } catch { /* ignore */ }
  window.location.reload();
}

interface Props {
  onNavigate: (view: CompanionView) => void;
}

const STATUS_COLORS: Record<string, string> = {
  idle: 'bg-henry-success',
  thinking: 'bg-henry-accent animate-pulse',
  planning: 'bg-henry-accent animate-pulse',
  acting: 'bg-henry-warning animate-pulse',
  working: 'bg-henry-warning animate-pulse',
  streaming: 'bg-henry-accent animate-pulse',
  error: 'bg-henry-error',
  done: 'bg-henry-success',
};

const TASK_STATUS_COLORS: Record<string, string> = {
  pending: 'text-henry-text-muted',
  queued: 'text-henry-accent',
  running: 'text-henry-warning',
  completed: 'text-henry-success',
  failed: 'text-henry-error',
  cancelled: 'text-henry-text-muted',
};

export default function CompanionHome({ onNavigate }: Props) {
  const {
    desktopStatus,
    tasks,
    conversations,
    pendingActions,
    lastSyncAt,
  } = useSyncStore();

  const recentTasks = tasks.slice(0, 5);
  const recentConvos = conversations.slice(0, 4);

  const dot = desktopStatus
    ? STATUS_COLORS[desktopStatus.companionStatus] ?? 'bg-henry-text-muted'
    : 'bg-henry-text-muted';

  const syncAgo = lastSyncAt
    ? formatAge(Date.now() - lastSyncAt)
    : 'never';

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="p-4 space-y-4 pb-6">

        {/* ── Desktop Status Card ─────────────────────────────────────── */}
        <div className="bg-henry-surface rounded-2xl p-4 border border-henry-border/30">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-henry-text leading-tight">
                {desktopStatus?.online !== false ? 'Desktop Connected' : 'Desktop Offline'}
              </p>
              {desktopStatus?.currentActivity && (
                <p className="text-xs text-henry-text-muted truncate mt-0.5">
                  {desktopStatus.currentActivity}
                </p>
              )}
            </div>
            <div className="text-right shrink-0">
              {desktopStatus && (
                <div className="flex gap-3">
                  <Stat label="Running" value={desktopStatus.tasksRunning} />
                  <Stat label="Queued" value={desktopStatus.tasksQueued} />
                </div>
              )}
              <p className="text-[10px] text-henry-text-muted mt-1">
                Synced {syncAgo}
              </p>
            </div>
          </div>
        </div>

        {/* ── Pending Approvals ───────────────────────────────────────── */}
        {pendingActions.length > 0 && (
          <button
            onClick={() => onNavigate('approvals')}
            className="w-full bg-henry-warning/10 border border-henry-warning/30 rounded-2xl p-4 flex items-center gap-3 active:bg-henry-warning/20 transition-colors text-left"
          >
            <span className="text-2xl">⚡</span>
            <div className="flex-1">
              <p className="text-sm font-semibold text-henry-warning">
                {pendingActions.length} Action{pendingActions.length > 1 ? 's' : ''} Awaiting Approval
              </p>
              <p className="text-xs text-henry-text-muted mt-0.5">
                Tap to review and approve or reject
              </p>
            </div>
            <svg className="w-4 h-4 text-henry-warning shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}

        {/* ── Quick Actions ───────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3">
          <QuickAction
            icon="🎙"
            label="Voice Note"
            sub="Send to Henry"
            onClick={() => onNavigate('capture')}
          />
          <QuickAction
            icon="💬"
            label="Ask Henry"
            sub="Type a prompt"
            onClick={() => onNavigate('chat')}
          />
          <QuickAction
            icon="📸"
            label="Send Photo"
            sub="Image capture"
            onClick={() => onNavigate('capture')}
          />
          <QuickAction
            icon="📋"
            label="Tasks"
            sub={`${tasks.filter(t => t.status === 'running').length} active`}
            onClick={() => onNavigate('tasks')}
          />
        </div>

        {/* ── Recent Tasks ────────────────────────────────────────────── */}
        {recentTasks.length > 0 && (
          <section>
            <SectionHeader title="Recent Tasks" onMore={() => onNavigate('tasks')} />
            <div className="space-y-2">
              {recentTasks.map((task) => (
                <div
                  key={task.id}
                  className="bg-henry-surface rounded-xl px-4 py-3 border border-henry-border/20 flex items-start gap-3"
                >
                  <span className={`text-xs font-medium mt-0.5 shrink-0 ${TASK_STATUS_COLORS[task.status] ?? 'text-henry-text-muted'}`}>
                    {statusIcon(task.status)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-henry-text truncate">{task.description}</p>
                    <p className="text-[10px] text-henry-text-muted mt-0.5">
                      {task.status} · {formatAge(Date.now() - new Date(task.created_at).getTime())} ago
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Recent Conversations ────────────────────────────────────── */}
        {recentConvos.length > 0 && (
          <section>
            <SectionHeader title="Recent Chats" onMore={() => onNavigate('chat')} />
            <div className="space-y-2">
              {recentConvos.map((convo) => (
                <button
                  key={convo.id}
                  onClick={() => onNavigate('chat')}
                  className="w-full text-left bg-henry-surface rounded-xl px-4 py-3 border border-henry-border/20 flex items-center gap-3 active:bg-henry-surface/70 transition-colors"
                >
                  <span className="text-base shrink-0">💬</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-henry-text truncate">
                      {convo.title || 'New Chat'}
                    </p>
                    <p className="text-[10px] text-henry-text-muted mt-0.5">
                      {convo.message_count} message{convo.message_count !== 1 ? 's' : ''}
                      {' · '}
                      {formatAge(Date.now() - new Date(convo.updated_at).getTime())} ago
                    </p>
                  </div>
                  <svg className="w-4 h-4 text-henry-text-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Mode switcher */}
        <div className="pt-2 pb-2 text-center">
          <button
            onClick={switchToFullMode}
            className="text-xs text-henry-text-muted active:opacity-60 transition-opacity"
          >
            Switch to Full Henry Mode →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function QuickAction({
  icon,
  label,
  sub,
  onClick,
}: {
  icon: string;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-henry-surface rounded-2xl p-4 flex flex-col items-start gap-2 border border-henry-border/20 active:bg-henry-surface/70 transition-colors text-left"
    >
      <span className="text-2xl">{icon}</span>
      <div>
        <p className="text-sm font-semibold text-henry-text">{label}</p>
        <p className="text-[10px] text-henry-text-muted">{sub}</p>
      </div>
    </button>
  );
}

function SectionHeader({
  title,
  onMore,
}: {
  title: string;
  onMore: () => void;
}) {
  return (
    <div className="flex items-center justify-between mb-2">
      <p className="text-xs font-semibold text-henry-text-muted uppercase tracking-wider">
        {title}
      </p>
      <button
        onClick={onMore}
        className="text-xs text-henry-accent active:opacity-60 transition-opacity"
      >
        See all
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <p className="text-base font-bold text-henry-text leading-none">{value}</p>
      <p className="text-[9px] text-henry-text-muted mt-0.5">{label}</p>
    </div>
  );
}

// ── Utils ──────────────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function statusIcon(status: string): string {
  const icons: Record<string, string> = {
    pending: '⏳',
    queued: '🔄',
    running: '⚡',
    completed: '✅',
    failed: '❌',
    cancelled: '🚫',
  };
  return icons[status] ?? '•';
}
