import { useEffect, useState, useRef } from 'react';
import { useAmbientStore, type AmbientStateValue } from '../../henry/ambientStateStore';
import { useDebugStore } from '../../henry/debugStore';
import { useExecutionModeStore } from '../../henry/executionModeStore';
import { getFocusNow } from '../../henry/getFocusNow';
import { useStore } from '../../store';
import HenryHomePanel from './HenryHomePanel';

// ── Keyframes injected once ────────────────────────────────────────────────
const KEYFRAMES = `
@keyframes henry-wave {
  0%, 100% { height: 3px; }
  50% { height: 11px; }
}
@keyframes henry-think {
  0%, 100% { transform: translateY(0px); opacity: 1; }
  50% { transform: translateY(-4px); opacity: 0.5; }
}
@keyframes henry-resp-ring {
  0% { transform: scale(0.8); opacity: 0.8; }
  100% { transform: scale(1.8); opacity: 0; }
}
@keyframes henry-ready-ring {
  0%, 100% { transform: scale(1); opacity: 0.3; }
  50% { transform: scale(1.4); opacity: 0.7; }
}
@keyframes henry-blink-slow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
@keyframes henry-blink-fast {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.1; }
}
`;

// ── State config ───────────────────────────────────────────────────────────
interface StateVisual {
  label: string;
  color: string;       // CSS color value
  textClass: string;   // Tailwind text class
  indicator: 'dot' | 'wave' | 'think' | 'respond' | 'blink-slow' | 'blink-fast' | 'focused-dot';
  pulse: boolean;
}

function stateVisual(state: AmbientStateValue): StateVisual {
  switch (state) {
    case 'idle':
      return { label: 'Idle', color: 'rgba(148,163,184,0.3)', textClass: 'text-henry-text-muted/50', indicator: 'dot', pulse: false };
    case 'ready':
      return { label: 'Ready', color: '#22c55e', textClass: 'text-henry-success', indicator: 'dot', pulse: true };
    case 'listening':
      return { label: 'Listening', color: '#ef4444', textClass: 'text-henry-error', indicator: 'wave', pulse: false };
    case 'thinking':
      return { label: 'Thinking', color: '#f59e0b', textClass: 'text-henry-warning', indicator: 'think', pulse: false };
    case 'responding':
      return { label: 'Responding', color: '#60a5fa', textClass: 'text-henry-accent', indicator: 'respond', pulse: false };
    case 'muted':
      return { label: 'Muted', color: 'rgba(148,163,184,0.2)', textClass: 'text-henry-text-muted/30', indicator: 'dot', pulse: false };
    case 'blocked':
      return { label: 'Blocked', color: '#f97316', textClass: 'text-orange-400', indicator: 'blink-slow', pulse: false };
    case 'reconnect_needed':
      return { label: 'Reconnect', color: '#f97316', textClass: 'text-orange-400', indicator: 'blink-fast', pulse: false };
    case 'focused':
      return { label: 'Focus', color: '#818cf8', textClass: 'text-indigo-400', indicator: 'focused-dot', pulse: false };
  }
}

// ── Mode accent ────────────────────────────────────────────────────────────
function modeAccent(mode: string): { pill: string; text: string } {
  switch (mode) {
    case 'builder':   return { pill: 'bg-blue-500/10 border-blue-500/20',    text: 'text-blue-400' };
    case 'operator':  return { pill: 'bg-henry-success/10 border-henry-success/20', text: 'text-henry-success' };
    case 'recovery':  return { pill: 'bg-orange-500/10 border-orange-500/20', text: 'text-orange-400' };
    case 'focus':     return { pill: 'bg-indigo-500/10 border-indigo-500/20', text: 'text-indigo-400' };
    case 'review':    return { pill: 'bg-purple-500/10 border-purple-500/20', text: 'text-purple-400' };
    default:          return { pill: 'bg-henry-surface border-henry-border/30', text: 'text-henry-text-muted' };
  }
}

// ── Animated state indicator ───────────────────────────────────────────────
function StateIndicator({ visual }: { visual: StateVisual }) {
  const c = visual.color;

  if (visual.indicator === 'wave') {
    return (
      <div className="flex items-end gap-px" style={{ height: 14, color: c }}>
        {[0, 150, 300].map((delay, i) => (
          <div
            key={i}
            style={{
              width: 2.5,
              height: 3,
              borderRadius: 2,
              backgroundColor: c,
              animation: `henry-wave 0.75s ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </div>
    );
  }

  if (visual.indicator === 'think') {
    return (
      <div className="flex items-center gap-0.5">
        {[0, 200, 400].map((delay, i) => (
          <div
            key={i}
            style={{
              width: 3.5,
              height: 3.5,
              borderRadius: '50%',
              backgroundColor: c,
              animation: `henry-think 1s ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </div>
    );
  }

  if (visual.indicator === 'respond') {
    return (
      <div className="relative flex items-center justify-center" style={{ width: 16, height: 16 }}>
        <div className="henry-heartbeat" style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: c }} />
        <div
          style={{
            position: 'absolute',
            width: 16,
            height: 16,
            borderRadius: '50%',
            border: `1.5px solid ${c}`,
            animation: 'henry-resp-ring 1.2s ease-out infinite',
          }}
        />
      </div>
    );
  }

  if (visual.indicator === 'blink-slow') {
    return (
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          backgroundColor: c,
          animation: 'henry-blink-slow 2s ease-in-out infinite',
        }}
      />
    );
  }

  if (visual.indicator === 'blink-fast') {
    return (
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          backgroundColor: c,
          animation: 'henry-blink-fast 0.7s ease-in-out infinite',
        }}
      />
    );
  }

  if (visual.indicator === 'focused-dot') {
    return <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: c, opacity: 0.7 }} />;
  }

  // 'dot' — ready gets the ring pulse
  if (visual.pulse) {
    return (
      <div className="relative flex items-center justify-center" style={{ width: 16, height: 16 }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: c }} />
        <div
          style={{
            position: 'absolute',
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: `1px solid ${c}`,
            animation: 'henry-ready-ring 2.5s ease-in-out infinite',
          }}
        />
      </div>
    );
  }

  return <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: c }} />;
}

// ── Main bar ───────────────────────────────────────────────────────────────
export default function PresenceBar() {
  const ambientState   = useAmbientStore((s) => s.state);
  const activeBrain    = useAmbientStore((s) => s.activeBrain);
  const isMuted        = useAmbientStore((s) => s.isMuted);
  const presenceExpanded = useAmbientStore((s) => s.presenceExpanded);
  const toggleExpanded = useAmbientStore((s) => s.toggleExpanded);
  const toggleMuted    = useAmbientStore((s) => s.toggleMuted);

  const lastModels = useDebugStore((s) => s.lastModels);
  const settings   = useStore((s) => s.settings);
  const setCurrentView = useStore((s) => s.setCurrentView);
  const execMode   = useExecutionModeStore((s) => s.mode);

  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const keyframesInjected = useRef(false);

  // Inject keyframes once
  useEffect(() => {
    if (keyframesInjected.current) return;
    keyframesInjected.current = true;
    const style = document.createElement('style');
    style.textContent = KEYFRAMES;
    document.head.appendChild(style);
  }, []);

  // Focus label refresh
  useEffect(() => {
    function refresh() {
      const f = getFocusNow();
      setFocusLabel(f?.now ?? null);
    }
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  const visual = stateVisual(ambientState);
  const accent = modeAccent(execMode);

  // Brain label
  const companionEntry = lastModels.find((m) => m.role === 'companion');
  let brainLabel = activeBrain;
  if (!brainLabel && companionEntry) {
    brainLabel = companionEntry.provider === 'ollama'
      ? `Local AI · ${companionEntry.model}`
      : `Cloud AI · ${companionEntry.model}${companionEntry.isFallback ? ' ⚡' : ''}`;
  }
  if (!brainLabel) {
    const cp = settings.companion_provider;
    const cm = settings.companion_model;
    if (cp === 'ollama') brainLabel = cm ? `Local AI · ${cm}` : 'Local AI';
    else if (cp) brainLabel = cm ? `Cloud AI · ${cm}` : 'Cloud AI';
  }

  // In focus mode: minimal bar — only show indicator + expand
  const isFocusMode = execMode === 'focus';

  return (
    <>
      <div
        className="shrink-0 h-9 flex items-center px-3 gap-2.5 border-b border-henry-border/30 transition-colors duration-300"
        style={{ backgroundColor: 'rgba(var(--henry-bg-rgb, 15,18,23), 0.7)' }}
      >
        {/* State indicator — clickable to expand */}
        <button
          onClick={toggleExpanded}
          className="flex items-center gap-2 shrink-0 hover:opacity-80 transition-opacity"
          title={`Henry · ${visual.label} — click for home panel`}
        >
          <StateIndicator visual={visual} />
          {!isFocusMode && (
            <span className={`text-[11px] font-medium transition-colors ${visual.textClass}`}>
              {visual.label}
            </span>
          )}
        </button>

        {/* Live activity label — shows when Henry is actively working */}
        {(ambientState === 'responding' || ambientState === 'thinking') && !isFocusMode && (
          <span className="text-[10px] text-henry-text-muted/70 truncate max-w-[200px] henry-heartbeat italic">
            {ambientState === 'thinking' ? 'Henry is thinking…' : 'Henry is responding…'}
          </span>
        )}

        {/* Mode pill — hidden in focus mode */}
        {!isFocusMode && (
          <>
            <div className="w-px h-3 bg-henry-border/30 shrink-0" />
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium shrink-0 ${accent.pill} ${accent.text}`}
            >
              {execMode.charAt(0).toUpperCase() + execMode.slice(1)}
            </span>
          </>
        )}

        {/* Brain label */}
        {!isFocusMode && brainLabel && (
          <>
            <div className="w-px h-3 bg-henry-border/30 shrink-0" />
            <span className="text-[11px] text-henry-text-muted shrink-0 truncate max-w-[160px]" title={brainLabel}>
              {brainLabel}
            </span>
          </>
        )}

        {/* Focus label — expands to fill remaining space */}
        {!isFocusMode && focusLabel && (
          <>
            <div className="w-px h-3 bg-henry-border/30 shrink-0" />
            <span className="text-[11px] text-henry-text-dim truncate flex-1 min-w-0" title={focusLabel}>
              {focusLabel}
            </span>
          </>
        )}
        {isFocusMode && <div className="flex-1" />}

        {/* Right actions */}
        <div className="flex items-center gap-1 shrink-0 ml-auto">
          {/* Chat shortcut */}
          {!isFocusMode && (
            <button
              onClick={() => setCurrentView('chat')}
              title="Open chat"
              className="flex items-center justify-center w-6 h-6 rounded-md text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/40 transition-all"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}

          {/* Mute toggle */}
          <button
            onClick={toggleMuted}
            title={isMuted ? 'Henry muted — click to resume' : 'Pause Henry'}
            className={`flex items-center justify-center w-6 h-6 rounded-md transition-all ${
              isMuted
                ? 'text-henry-warning bg-henry-warning/10 hover:bg-henry-warning/20'
                : 'text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/40'
            }`}
          >
            {isMuted ? (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            )}
          </button>

          {/* Expand chevron */}
          <button
            onClick={toggleExpanded}
            title={presenceExpanded ? 'Close Henry home' : 'Open Henry home'}
            className="flex items-center justify-center w-6 h-6 rounded-md text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/40 transition-all"
          >
            <svg
              className={`w-3 h-3 transition-transform duration-200 ${presenceExpanded ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      {/* Expandable home panel */}
      {presenceExpanded && <HenryHomePanel onClose={toggleExpanded} />}
    </>
  );
}
