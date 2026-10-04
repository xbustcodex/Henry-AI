/**
 * Henry Home Panel
 *
 * Expands from PresenceBar when the user clicks the chevron or state indicator.
 * Shows: live state, mode, momentum, focus, suggested next move, quick actions.
 *
 * Positioned as a fixed overlay below PresenceBar — never clips on overflow-hidden parents.
 * TitleBar h-12 (48px) + PresenceBar h-9 (36px) = top 84px.
 */

import { useEffect, useState, useCallback } from 'react';
import { useAmbientStore, type AmbientStateValue } from '../../henry/ambientStateStore';
import { useExecutionModeStore, EXECUTION_MODE_CONFIGS, type ExecutionMode } from '../../henry/executionModeStore';
import { useInitiativeStore } from '../../henry/initiativeStore';
import { useStore } from '../../store';
import { getFocusNow } from '../../henry/getFocusNow';
import { getQuickInsight } from '../../henry/henryInsight';
import { computeMomentum, dismissMomentumBroken, type MomentumSnapshot } from '../../henry/momentumEngine';
import { computeInstinctFromState, type InstinctResult } from '../../henry/instinctEngine';
import { wakeWordManager } from '../../henry/wakeWord';

// ── State labels + descriptions ────────────────────────────────────────────
const STATE_COPY: Record<AmbientStateValue, { label: string; sub: string; color: string }> = {
  idle:             { label: 'Idle',             sub: 'Quiet and ready when you need me.',        color: 'text-henry-text-muted' },
  ready:            { label: 'Ready',            sub: 'I\'m here — talk or type anytime.',        color: 'text-henry-success' },
  listening:        { label: 'Listening',        sub: 'I can hear you. Go ahead.',                color: 'text-henry-error' },
  thinking:         { label: 'Thinking',         sub: 'Working through this for you.',            color: 'text-henry-warning' },
  responding:       { label: 'Responding',       sub: 'On it.',                                   color: 'text-henry-accent' },
  muted:            { label: 'Muted',            sub: 'Henry is paused. I\'ll resume when you\'re ready.', color: 'text-henry-text-muted' },
  blocked:          { label: 'Blocked',          sub: 'Something stopped me. Let\'s fix it.',     color: 'text-orange-400' },
  reconnect_needed: { label: 'Reconnect needed', sub: 'A connection expired. Tap to review.',     color: 'text-orange-400' },
  focused:          { label: 'Protecting focus', sub: 'I\'m guarding your concentration.',        color: 'text-indigo-400' },
};

const MOMENTUM_COLOR: Record<string, string> = {
  strong:   'text-henry-success',
  building: 'text-henry-accent',
  stalling: 'text-henry-warning',
  broken:   'text-henry-error',
};

const MOMENTUM_DOT: Record<string, string> = {
  strong:   'bg-henry-success',
  building: 'bg-henry-accent',
  stalling: 'bg-henry-warning',
  broken:   'bg-henry-error',
};

// ── Quick action button ────────────────────────────────────────────────────
function QuickAction({
  label,
  icon,
  onClick,
  active,
  danger,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1.5 px-3 py-2.5 rounded-xl border transition-all text-[11px] font-medium ${
        danger
          ? 'border-henry-error/30 text-henry-error bg-henry-error/5 hover:bg-henry-error/10'
          : active
          ? 'border-henry-accent/40 text-henry-accent bg-henry-accent/10 hover:bg-henry-accent/15'
          : 'border-henry-border/40 text-henry-text-muted bg-henry-surface/60 hover:bg-henry-hover/40 hover:text-henry-text hover:border-henry-border/60'
      }`}
    >
      <span className="w-5 h-5 flex items-center justify-center">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────
interface Props {
  onClose: () => void;
}

export default function HenryHomePanel({ onClose }: Props) {
  const ambientState   = useAmbientStore((s) => s.state);
  const isMuted        = useAmbientStore((s) => s.isMuted);
  const toggleMuted    = useAmbientStore((s) => s.toggleMuted);

  const execMode       = useExecutionModeStore((s) => s.mode);
  const execSource     = useExecutionModeStore((s) => s.source);
  const setExecMode    = useExecutionModeStore((s) => s.setMode);
  const initiativeMode = useInitiativeStore((s) => s.mode);

  const setCurrentView = useStore((s) => s.setCurrentView);

  const [focusLabel, setFocusLabel]   = useState<string | null>(null);
  const [momentum, setMomentum]       = useState<MomentumSnapshot | null>(null);
  const [instinct, setInstinct]       = useState<InstinctResult | null>(null);
  const [wakeActive, setWakeActive]   = useState(false);
  const [quickInsight, setQuickInsight] = useState(() => getQuickInsight());

  // Load live data
  useEffect(() => {
    const f = getFocusNow();
    setFocusLabel(f?.now ?? null);
    setMomentum(computeMomentum());
    setInstinct(computeInstinctFromState(execMode, initiativeMode));
  }, [execMode, initiativeMode]);

  // Wake word state
  useEffect(() => {
    function onWakeState(e: Event) {
      setWakeActive((e as CustomEvent<{ active: boolean }>).detail.active);
    }
    window.addEventListener('henry_wake_state', onWakeState);
    return () => window.removeEventListener('henry_wake_state', onWakeState);
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function handleClick(e: MouseEvent) {
      const target = e.target as Element;
      if (!target.closest('[data-henry-home]')) onClose();
    }
    document.addEventListener('keydown', handleKey);
    setTimeout(() => document.addEventListener('click', handleClick), 50);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('click', handleClick);
    };
  }, [onClose]);

  const toggleTalk = useCallback(async () => {
    if (wakeActive) {
      wakeWordManager.stop();
    } else {
      await wakeWordManager.start();
    }
  }, [wakeActive]);

  const openChat = useCallback(() => {
    setCurrentView('chat');
    onClose();
  }, [setCurrentView, onClose]);

  const setFocusMode = useCallback(() => {
    setExecMode('focus', 'manual');
    onClose();
  }, [setExecMode, onClose]);

  const openDebug = useCallback(() => {
    window.dispatchEvent(new CustomEvent('henry:debug:open'));
    onClose();
  }, [onClose]);

  const stateCopy = STATE_COPY[ambientState];
  const modeConfig = EXECUTION_MODE_CONFIGS[execMode];

  return (
    // Fixed overlay below TitleBar (48px) + PresenceBar (36px) = 84px
    <div
      className="fixed left-0 right-0 z-50"
      style={{ top: 84 }}
    >
          {quickInsight && (
            <div className={`p-3 rounded-xl border mb-3 text-left ${
              quickInsight.type === 'warning'
                ? 'border-red-500/25 bg-red-500/5'
                : 'border-henry-border/30 bg-henry-surface/30'
            }`}>
              <div className="flex items-start gap-2">
                <span className="text-sm mt-0.5">{quickInsight.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-henry-text leading-snug">{quickInsight.text}</p>
                  {quickInsight.action && (
                    <button
                      onClick={() => useStore.getState().setCurrentView(quickInsight.action!.view as any)}
                      className="text-[10px] text-henry-accent hover:underline mt-0.5"
                    >{quickInsight.action.label} →</button>
                  )}
                </div>
                <button onClick={() => setQuickInsight(null)} className="text-henry-text-muted hover:text-henry-text text-[10px]">✕</button>
              </div>
            </div>
          )}

      {/* Backdrop — click outside to close */}
      <div className="fixed inset-0 z-0" style={{ top: 84 }} />

      {/* Panel */}
      <div
        data-henry-home
        className="relative z-10 mx-auto max-w-lg border border-henry-border/50 rounded-b-2xl bg-henry-surface/95 shadow-2xl shadow-black/40 backdrop-blur-xl overflow-hidden"
        style={{ borderTop: 'none' }}
      >
        {/* ── State + mode header ─────────────────────────────────────── */}
        <div className="px-4 pt-4 pb-3 border-b border-henry-border/20">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className={`text-base font-semibold tracking-tight ${stateCopy.color}`}>
                {stateCopy.label}
              </p>
              <p className="text-[12px] text-henry-text-muted mt-0.5">{stateCopy.sub}</p>
            </div>

            {/* Mode + momentum badges */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                execMode === 'builder'  ? 'border-blue-500/30 bg-blue-500/10 text-blue-400' :
                execMode === 'operator' ? 'border-henry-success/30 bg-henry-success/10 text-henry-success' :
                execMode === 'recovery' ? 'border-orange-500/30 bg-orange-500/10 text-orange-400' :
                execMode === 'focus'    ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-400' :
                                          'border-purple-500/30 bg-purple-500/10 text-purple-400'
              }`}>
                {modeConfig.label}
              </span>
              {execSource === 'inferred' && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-henry-border/30 text-henry-text-muted bg-henry-surface">
                  auto
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── Focus ───────────────────────────────────────────────────── */}
        {focusLabel && (
          <div className="px-4 py-2.5 border-b border-henry-border/20">
            <p className="text-[10px] text-henry-text-muted uppercase tracking-wider mb-1">Focus</p>
            <p className="text-[12px] text-henry-text truncate">{focusLabel}</p>
          </div>
        )}

        {/* ── Momentum ────────────────────────────────────────────────── */}
        {momentum && (
          <div className="px-4 py-2.5 border-b border-henry-border/20">
            <p className="text-[10px] text-henry-text-muted uppercase tracking-wider mb-1.5">Momentum</p>
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${MOMENTUM_DOT[momentum.state]}`} />
              <span className={`text-[12px] font-medium capitalize ${MOMENTUM_COLOR[momentum.state]}`}>
                {momentum.state}
              </span>
              {/* R3-Fix 6: dismiss button only for the 'broken' state — the
                  other states are informational and don't need silencing. */}
              {momentum.state === 'broken' && (
                <button
                  type="button"
                  onClick={() => { dismissMomentumBroken(); setMomentum(computeMomentum()); }}
                  className="ml-auto text-[10px] text-henry-text-muted hover:text-henry-text px-2 py-0.5 rounded hover:bg-henry-border/20"
                  title="Hide this for 24 hours"
                >
                  Dismiss
                </button>
              )}
            </div>
            <p className="text-[11px] text-henry-text-muted leading-relaxed">{momentum.reason}</p>
            {momentum.oneNextStep && (
              <p className="text-[11px] text-henry-text mt-1.5 pl-3 border-l border-henry-border/40 leading-relaxed">
                {momentum.oneNextStep}
              </p>
            )}
          </div>
        )}

        {/* ── Instinct ────────────────────────────────────────────────── */}
        {instinct && instinct.decision !== 'quiet' && (
          <div className="px-4 py-2.5 border-b border-henry-border/20">
            <p className="text-[10px] text-henry-text-muted uppercase tracking-wider mb-1">Henry's read</p>
            <div className="flex items-center gap-2">
              <span className={`text-[11px] font-medium capitalize ${
                instinct.decision === 'act'      ? 'text-henry-success' :
                instinct.decision === 'ask'      ? 'text-henry-accent' :
                instinct.decision === 'escalate' ? 'text-henry-error'  :
                                                   'text-henry-text-muted'
              }`}>
                {instinct.decision}
              </span>
              <span className="text-henry-text-muted/40 text-[10px]">·</span>
              <span className="text-[11px] text-henry-text-muted">{instinct.confidence} confidence</span>
            </div>
            <p className="text-[11px] text-henry-text-dim mt-0.5">{instinct.reason}</p>
          </div>
        )}

        {/* ── Quick actions ────────────────────────────────────────────── */}
        <div className="px-4 py-3">
          <div className="grid grid-cols-5 gap-1.5">
            <QuickAction
              label={wakeActive ? 'Stop' : 'Talk'}
              active={wakeActive}
              onClick={toggleTalk}
              icon={
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              }
            />
            <QuickAction
              label="Chat"
              onClick={openChat}
              icon={
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              }
            />
            <QuickAction
              label="Focus"
              active={execMode === 'focus'}
              onClick={setFocusMode}
              icon={
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="6" />
                  <circle cx="12" cy="12" r="2" />
                </svg>
              }
            />
            <QuickAction
              label={isMuted ? 'Resume' : 'Pause'}
              active={isMuted}
              onClick={toggleMuted}
              icon={
                isMuted ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="4" width="4" height="16" />
                    <rect x="14" y="4" width="4" height="16" />
                  </svg>
                )
              }
            />
            <QuickAction
              label="Operator"
              onClick={openDebug}
              icon={
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41M12 2v2M12 20v2M2 12h2M20 12h2" />
                </svg>
              }
            />
          </div>
        </div>

        {/* ── Execution mode switcher ──────────────────────────────────── */}
        <div className="px-4 pb-4 border-t border-henry-border/20 pt-3">
          <p className="text-[10px] text-henry-text-muted uppercase tracking-wider mb-2">Mode</p>
          <div className="flex gap-1.5 flex-wrap">
            {(Object.keys(EXECUTION_MODE_CONFIGS) as ExecutionMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setExecMode(m, 'manual')}
                className={`text-[10px] px-2.5 py-1 rounded-lg border transition-all font-medium ${
                  execMode === m
                    ? m === 'builder'  ? 'border-blue-500/50 bg-blue-500/15 text-blue-300' :
                      m === 'operator' ? 'border-henry-success/50 bg-henry-success/15 text-henry-success' :
                      m === 'recovery' ? 'border-orange-500/50 bg-orange-500/15 text-orange-300' :
                      m === 'focus'    ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-300' :
                                         'border-purple-500/50 bg-purple-500/15 text-purple-300'
                    : 'border-henry-border/30 text-henry-text-muted bg-henry-surface hover:bg-henry-hover/40 hover:text-henry-text hover:border-henry-border/50'
                }`}
              >
                {EXECUTION_MODE_CONFIGS[m].label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-henry-text-dim mt-1.5 leading-relaxed">{modeConfig.description}</p>
        </div>
      </div>
    </div>
  );
}
