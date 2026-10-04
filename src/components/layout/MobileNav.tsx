import { useState } from 'react';
import { useStore } from '../../store';
import type { Conversation } from '../../types';

type ViewType = 'today' | 'chat' | 'tasks' | 'files' | 'workspace' | 'terminal' | 'computer' | 'printer' | 'costs' | 'settings' | 'journal' | 'recorder' | 'modes' | 'reminders' | 'finance' | 'printstudio' | 'imagegen';

const BOTTOM_TABS: { id: ViewType; label: string; icon: string }[] = [
  { id: 'today', label: 'Today', icon: '🏠' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'reminders', label: 'Reminders', icon: '🔔' },
  { id: 'tasks', label: 'Tasks', icon: '📋' },
];

const MORE_NAV: { id: ViewType; label: string; icon: string }[] = [
  { id: 'journal', label: 'Journal', icon: '📔' },
  { id: 'recorder', label: 'Recorder', icon: '🎙' },
  { id: 'finance', label: 'Finance', icon: '💵' },
  { id: 'printstudio', label: 'Print Studio', icon: '🖨️' },
  { id: 'imagegen', label: 'Image Gen', icon: '🎨' },
  { id: 'files', label: 'Files', icon: '📁' },
  { id: 'workspace', label: 'Workspace', icon: '🗂️' },
  { id: 'modes', label: 'My Modes', icon: '✨' },
  { id: 'printer', label: '3D Control', icon: '🔧' },
  { id: 'terminal', label: 'Terminal', icon: '💻' },
  { id: 'computer', label: 'Computer', icon: '🖥️' },
  { id: 'costs', label: 'Costs', icon: '💰' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

export default function MobileNav() {
  const {
    currentView,
    setCurrentView,
    conversations,
    setActiveConversation,
    setMessages,
    companionStatus,
    workerStatus,
  } = useStore();
  const [moreOpen, setMoreOpen] = useState(false);

  function navigate(id: ViewType) {
    setCurrentView(id);
    setMoreOpen(false);
  }

  async function openConversation(convo: Conversation) {
    setActiveConversation(convo.id);
    try {
      const msgs = await window.henryAPI.getMessages(convo.id);
      setMessages(msgs);
    } catch { /* ignore */ }
    setCurrentView('chat');
    setMoreOpen(false);
  }

  function newChat() {
    setActiveConversation(null);
    setMessages([]);
    setCurrentView('chat');
    setMoreOpen(false);
  }

  const isMoreActive = !BOTTOM_TABS.find((t) => t.id === currentView);

  const dotColor = (status: string) =>
    status === 'idle' ? 'bg-henry-success' : status === 'error' ? 'bg-henry-error' : 'bg-henry-warning animate-pulse';

  return (
    <>
      {/* Bottom tab bar — only on mobile */}
      <nav
        className="md:hidden shrink-0 flex items-stretch bg-henry-surface/95 backdrop-blur-md border-t border-henry-border/50"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {BOTTOM_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => navigate(tab.id)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-3 min-h-[56px] transition-colors ${
              currentView === tab.id
                ? 'text-henry-accent'
                : 'text-henry-text-muted active:text-henry-text'
            }`}
          >
            <span className="text-[22px] leading-none">{tab.icon}</span>
            <span className="text-[10px] font-medium tracking-wide">{tab.label}</span>
          </button>
        ))}

        {/* More button */}
        <button
          onClick={() => setMoreOpen(true)}
          className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-3 min-h-[56px] transition-colors ${
            isMoreActive ? 'text-henry-accent' : 'text-henry-text-muted active:text-henry-text'
          }`}
        >
          <svg className="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
          </svg>
          <span className="text-[10px] font-medium tracking-wide">More</span>
        </button>
      </nav>

      {/* More drawer */}
      {moreOpen && (
        <div className="md:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
            onClick={() => setMoreOpen(false)}
          />

          {/* Sheet */}
          <div
            className="fixed bottom-0 inset-x-0 z-50 bg-henry-bg rounded-t-2xl border-t border-henry-border/50 overflow-hidden flex flex-col"
            style={{ maxHeight: '82vh', paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            {/* Handle */}
            <div className="flex flex-col items-center pt-3 pb-2 shrink-0">
              <div className="w-10 h-1 rounded-full bg-henry-border" />
            </div>

            <div className="overflow-y-auto flex-1">
              {/* New Chat */}
              <div className="px-4 pb-3">
                <button
                  onClick={newChat}
                  className="w-full flex items-center justify-center gap-2 py-3.5 bg-henry-accent/10 text-henry-accent rounded-2xl text-sm font-semibold border border-henry-accent/25 active:bg-henry-accent/20 transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New Chat
                </button>
              </div>

              {/* More nav grid */}
              <div className="px-4 pb-4">
                <p className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider mb-2.5">Navigation</p>
                <div className="grid grid-cols-4 gap-2.5">
                  {MORE_NAV.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => navigate(item.id)}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-2xl transition-colors active:scale-95 ${
                        currentView === item.id
                          ? 'bg-henry-accent/15 text-henry-accent border border-henry-accent/25'
                          : 'bg-henry-surface/60 text-henry-text-dim border border-henry-border/20'
                      }`}
                    >
                      <span className="text-2xl">{item.icon}</span>
                      <span className="text-[10px] font-medium text-center leading-tight">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Recent conversations */}
              {conversations.length > 0 && (
                <div className="px-4 pb-5">
                  <p className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider mb-2.5">Recent Chats</p>
                  <div className="space-y-1.5">
                    {conversations.slice(0, 8).map((convo: Conversation) => (
                      <button
                        key={convo.id}
                        onClick={() => openConversation(convo)}
                        className="w-full text-left flex items-center gap-3 px-4 py-3 rounded-2xl bg-henry-surface/40 border border-henry-border/20 transition-colors active:bg-henry-surface/70"
                      >
                        <span className="text-base shrink-0">💬</span>
                        <span className="text-sm text-henry-text-dim truncate flex-1">{convo.title || 'New Chat'}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Engine status */}
              <div className="px-4 pb-4">
                <div className="flex gap-3">
                  <div className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-henry-surface/40 border border-henry-border/20">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor(companionStatus.status)}`} />
                    <span className="text-xs text-henry-text-dim">Local</span>
                    <span className="text-xs text-henry-text-muted ml-auto">
                      {companionStatus.status === 'idle' ? 'Ready' : companionStatus.status}
                    </span>
                  </div>
                  <div className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-henry-surface/40 border border-henry-border/20">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor(workerStatus.status)}`} />
                    <span className="text-xs text-henry-text-dim">Cloud</span>
                    <span className="text-xs text-henry-text-muted ml-auto">
                      {workerStatus.status === 'idle' ? 'Ready' : workerStatus.status}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
