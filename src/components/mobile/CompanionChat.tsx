/**
 * Companion Chat Screen
 *
 * Shows conversations from the desktop. Lets the user read history,
 * open any conversation, and send new prompts that will be processed
 * by Henry on the desktop.
 */

import { useState } from 'react';
import { useSyncStore } from '../../sync/syncStore';
import { sendPrompt, fetchMessages } from '../../sync/syncClient';
import type { SyncMessage } from '../../sync/types';
import { hapticLight, hapticMedium } from '../../capacitor';

export default function CompanionChat() {
  const {
    config,
    conversations,
    activeConversationId,
    activeMessages,
    setActiveConversation,
    setActiveMessages,
    status,
  } = useSyncStore();

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  async function openConversation(id: string) {
    setActiveConversation(id);
    if (!config) return;
    setLoadingMsgs(true);
    try {
      const msgs = await fetchMessages(config, id) as SyncMessage[];
      setActiveMessages(msgs);
    } catch {
      setActiveMessages([]);
    } finally {
      setLoadingMsgs(false);
    }
    void hapticLight();
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || !config) return;
    setSending(true);
    void hapticMedium();
    try {
      await sendPrompt(config, {
        text,
        conversationId: activeConversationId ?? undefined,
      });
      setInput('');
    } catch {
      // ignore — desktop offline
    } finally {
      setSending(false);
    }
  }

  if (activeConversationId) {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-henry-border/30">
          <button
            onClick={() => { setActiveConversation(null); setActiveMessages([]); }}
            className="p-2 -ml-2 text-henry-text-muted active:text-henry-text transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <p className="text-sm font-semibold text-henry-text flex-1 truncate">
            {conversations.find((c) => c.id === activeConversationId)?.title || 'Chat'}
          </p>
          {status === 'connected' && (
            <span className="w-2 h-2 rounded-full bg-henry-success shrink-0" />
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3 space-y-3">
          {loadingMsgs && (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-henry-accent border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {!loadingMsgs && activeMessages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}
          {!loadingMsgs && activeMessages.length === 0 && (
            <p className="text-center text-sm text-henry-text-muted py-8">No messages</p>
          )}
        </div>

        {/* Input */}
        <div
          className="shrink-0 px-4 py-3 border-t border-henry-border/30 flex gap-2 items-end"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={status === 'connected' ? 'Ask Henry…' : 'Desktop offline'}
            disabled={status !== 'connected'}
            rows={1}
            className="flex-1 bg-henry-surface rounded-2xl px-4 py-3 text-sm text-henry-text placeholder-henry-text-muted resize-none outline-none border border-henry-border/30 focus:border-henry-accent/50 transition-colors min-h-[44px] max-h-[120px] disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
              }
            }}
          />
          <button
            onClick={() => void sendMessage()}
            disabled={!input.trim() || sending || status !== 'connected'}
            className="shrink-0 w-11 h-11 rounded-2xl bg-henry-accent flex items-center justify-center active:bg-henry-accent/80 transition-colors disabled:opacity-40"
          >
            {sending ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    );
  }

  // Conversation list
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold text-henry-text">Chats</h1>
        <p className="text-xs text-henry-text-muted mt-0.5">
          {conversations.length} conversation{conversations.length !== 1 ? 's' : ''} from desktop
        </p>
      </div>

      {/* New prompt bar */}
      <div className="shrink-0 px-4 py-2">
        <div className="flex gap-2 items-center">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={status === 'connected' ? 'Ask Henry something…' : 'Desktop offline'}
            disabled={status !== 'connected'}
            className="flex-1 bg-henry-surface rounded-2xl px-4 py-3 text-sm text-henry-text placeholder-henry-text-muted outline-none border border-henry-border/30 focus:border-henry-accent/50 transition-colors disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendMessage();
            }}
          />
          <button
            onClick={() => void sendMessage()}
            disabled={!input.trim() || sending || status !== 'connected'}
            className="shrink-0 w-11 h-11 rounded-2xl bg-henry-accent flex items-center justify-center active:bg-henry-accent/80 transition-colors disabled:opacity-40"
          >
            {sending ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4 space-y-2">
        {conversations.length === 0 && (
          <p className="text-center text-sm text-henry-text-muted py-10">
            No conversations yet
          </p>
        )}
        {conversations.map((convo) => (
          <button
            key={convo.id}
            onClick={() => void openConversation(convo.id)}
            className="w-full text-left bg-henry-surface rounded-2xl px-4 py-3.5 border border-henry-border/20 active:bg-henry-surface/70 transition-colors flex items-start gap-3"
          >
            <span className="text-xl mt-0.5 shrink-0">💬</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-henry-text truncate">
                {convo.title || 'New Chat'}
              </p>
              <p className="text-[11px] text-henry-text-muted mt-0.5">
                {convo.message_count} messages
              </p>
            </div>
            <svg className="w-4 h-4 text-henry-text-muted shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: SyncMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
          isUser
            ? 'bg-henry-accent text-white rounded-br-sm'
            : 'bg-henry-surface text-henry-text border border-henry-border/20 rounded-bl-sm'
        }`}
      >
        <p className="leading-relaxed whitespace-pre-wrap">{msg.content}</p>
        {msg.model && (
          <p className={`text-[10px] mt-1 ${isUser ? 'text-white/60' : 'text-henry-text-muted'}`}>
            {msg.model}
          </p>
        )}
      </div>
    </div>
  );
}
