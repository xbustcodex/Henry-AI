/**
 * Henry Companion App Shell
 *
 * Root component rendered when the app is in companion mode on iOS/Android.
 * Handles:
 *   - Connection state management (connecting, syncing, disconnected)
 *   - Periodic snapshot refresh
 *   - SSE event stream
 *   - Navigation routing
 */

import { useEffect, useRef, useState } from 'react';
import { useSyncStore } from '../../sync/syncStore';
import {
  loadConnectionConfig,
  fetchSnapshot,
  initSyncStream,
  stopSyncStream,
} from '../../sync/syncClient';
import type { SyncEvent } from '../../sync/types';
import CompanionNav from './CompanionNav';
import CompanionHome from './CompanionHome';
import CompanionChat from './CompanionChat';
import CompanionTasks from './CompanionTasks';
import CompanionCapture from './CompanionCapture';
import CompanionApproval from './CompanionApproval';
import CompanionPairing from './CompanionPairing';

export type CompanionView = 'home' | 'chat' | 'tasks' | 'capture' | 'approvals';

export default function CompanionApp() {
  const [view, setView] = useState<CompanionView>('home');
  const {
    status,
    config,
    pendingActions,
    setStatus,
    setConfig,
    applySnapshot,
    upsertTask,
    addMessage,
    upsertNote,
    setDesktopStatus,
    setPendingActions,
    removeAction,
  } = useSyncStore();

  const syncTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);

  // ── Bootstrap ────────────────────────────────────────────────────────────
  useEffect(() => {
    mounted.current = true;
    const stored = loadConnectionConfig();
    if (stored) {
      setConfig(stored);
      connect(stored);
    } else {
      setStatus('disconnected');
    }
    return () => {
      mounted.current = false;
      stopSyncStream();
      if (syncTimer.current) clearInterval(syncTimer.current);
    };
  }, []);

  async function connect(cfg: ReturnType<typeof loadConnectionConfig>) {
    if (!cfg) return;
    setStatus('connecting');
    try {
      const snap = await fetchSnapshot(cfg);
      if (!mounted.current) return;
      applySnapshot(snap);
      setStatus('connected');

      initSyncStream(
        cfg,
        handleSyncEvent,
        (s) => { if (mounted.current) setStatus(s); }
      );

      // Refresh snapshot every 30 s as a fallback
      syncTimer.current = setInterval(async () => {
        try {
          const s = await fetchSnapshot(cfg);
          if (mounted.current) applySnapshot(s);
        } catch { /* ignore */ }
      }, 30_000);
    } catch {
      if (mounted.current) setStatus('error');
    }
  }

  function handleSyncEvent(event: SyncEvent) {
    if (!mounted.current) return;
    switch (event.type) {
      case 'message_added':
        addMessage(event.payload as Parameters<typeof addMessage>[0]);
        break;
      case 'task_updated':
      case 'task_added':
        upsertTask(event.payload as Parameters<typeof upsertTask>[0]);
        break;
      case 'note_added':
      case 'note_updated':
        upsertNote(event.payload as Parameters<typeof upsertNote>[0]);
        break;
      case 'desktop_status':
        setDesktopStatus(event.payload as Parameters<typeof setDesktopStatus>[0]);
        break;
      case 'pending_action':
        setPendingActions([
          ...useSyncStore.getState().pendingActions,
          event.payload as Parameters<typeof setPendingActions>[0][0],
        ]);
        break;
      case 'action_resolved':
        removeAction((event.payload as { actionId: string }).actionId);
        break;
      default:
        break;
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (status === 'disconnected' && !config) {
    return <CompanionPairing onPaired={(cfg) => { setConfig(cfg); connect(cfg); }} />;
  }

  return (
    <div
      className="flex flex-col h-full bg-henry-bg text-henry-text"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* Connection status banner */}
      {status === 'disconnected' && (
        <div className="shrink-0 bg-henry-warning/15 text-henry-warning text-xs text-center py-2 px-4 flex items-center justify-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-henry-warning animate-pulse shrink-0" />
          Desktop offline — showing cached data
        </div>
      )}
      {status === 'connecting' && (
        <div className="shrink-0 bg-henry-accent/10 text-henry-accent text-xs text-center py-2 px-4 flex items-center justify-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-henry-accent animate-pulse shrink-0" />
          Connecting to desktop…
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === 'home' && <CompanionHome onNavigate={setView} />}
        {view === 'chat' && <CompanionChat />}
        {view === 'tasks' && <CompanionTasks />}
        {view === 'capture' && <CompanionCapture onDone={() => setView('home')} />}
        {view === 'approvals' && <CompanionApproval />}
      </div>

      {/* Bottom nav */}
      <CompanionNav
        current={view}
        onNavigate={setView}
        approvalCount={pendingActions.length}
      />
    </div>
  );
}
