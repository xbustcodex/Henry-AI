import { useCallback, useEffect, useState } from 'react';
import { isMacOS } from '../../../utils/platform';

export type PermissionKind = 'accessibility' | 'screen';

interface Props {
  kind: PermissionKind;
  onNext: () => void;
  onSkip: () => void;
}

interface PermissionBridge {
  checkAccessibility?: () => Promise<{ granted: boolean }>;
  checkScreenRecording?: () => Promise<{ granted: boolean }>;
  openPermissions?: () => unknown;
  openScreenRecording?: () => unknown;
  computerRunShell?: (options: { command: string; timeout: number }) => unknown;
}

function bridge(): PermissionBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.henryAPI as unknown as PermissionBridge | undefined;
}

const COPY: Record<PermissionKind, {
  icon: string;
  title: string;
  blurb: string;
  settingsUri: string;
  openButton: string;
}> = {
  accessibility: {
    icon: '🔐',
    title: 'Accessibility access',
    blurb: `Required for ${isMacOS() ? '⌥Space' : 'Alt+C'} capture and for letting Henry control your computer when you ask.`,
    settingsUri: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    openButton: 'Open Accessibility Settings →',
  },
  screen: {
    icon: '📸',
    title: 'Screen Recording',
    blurb: 'Lets Henry see your screen when you say "look at this" or "take a screenshot". He never records without you asking.',
    settingsUri: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    openButton: 'Open Screen Recording Settings →',
  },
};

/**
 * The macOS permission consent stage.
 *
 * Polls the real grant rather than asking the user to confirm it, and advances
 * itself the moment the grant lands — while still offering an explicit skip,
 * because a user who declines must not be trapped. Off macOS this stage is not
 * in the plan at all (see `stages.ts`); there is no such toggle to grant, so
 * there is nothing honest to show.
 */
export default function PermissionsStage({ kind, onNext, onSkip }: Props) {
  const [granted, setGranted] = useState<boolean | null>(null);
  const copy = COPY[kind];

  const check = useCallback(async () => {
    try {
      const api = bridge();
      const result = kind === 'accessibility'
        ? await api?.checkAccessibility?.()
        : await api?.checkScreenRecording?.();
      setGranted(result?.granted === true);
    } catch {
      /* a failed check is not a denial — leave the last answer in place */
    }
  }, [kind]);

  useEffect(() => {
    void check();
    const timer = setInterval(() => { void check(); }, 2000);
    return () => clearInterval(timer);
  }, [check]);

  useEffect(() => {
    if (granted !== true) return;
    const timer = setTimeout(onNext, 1200);
    return () => clearTimeout(timer);
  }, [granted, onNext]);

  function openSettings() {
    const api = bridge();
    const opener = kind === 'accessibility' ? api?.openPermissions : api?.openScreenRecording;
    let opened = false;
    if (typeof opener === 'function') {
      try { opener(); opened = true; } catch { /* fall through to the URL */ }
    }
    if (!opened) {
      try { window.open(copy.settingsUri, '_blank'); } catch { /* nothing else to try */ }
    }
  }

  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-5xl mb-3">{copy.icon}</p>
        <h2 className="text-2xl font-bold text-white">{copy.title}</h2>
        <p className="text-white/55 text-sm mt-2 leading-relaxed">{copy.blurb}</p>
      </div>

      {granted === true ? (
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-5 text-center space-y-3">
          <p className="text-4xl">✓</p>
          <p className="text-green-400 font-semibold text-lg">{copy.title} enabled</p>
          <p className="text-white/50 text-xs">Detected. Moving on automatically…</p>
        </div>
      ) : (
        <>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-4">
            <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Step by step</p>
            <ol className="space-y-4">
              <li className="flex gap-3">
                <StepBadge n={1} />
                <p className="text-sm text-white/80 leading-relaxed">
                  Click <b className="text-white">Open Settings</b> below. System Settings opens to the{' '}
                  {kind === 'accessibility' ? 'Accessibility' : 'Screen Recording'} list.
                </p>
              </li>
              <li className="flex gap-3">
                <StepBadge n={2} />
                <p className="text-sm text-white/80 leading-relaxed">
                  Click the <b className="text-white">+</b> button and select <b className="text-white">Henry AI</b>.
                </p>
              </li>
              <li className="flex gap-3">
                <StepBadge n={3} />
                <p className="text-sm text-white/80 leading-relaxed">
                  Toggle it <b className="text-white">ON</b>.{' '}
                  <span className="text-henry-accent">This stage detects it automatically</span> — nothing to click here.
                </p>
              </li>
            </ol>
          </div>

          <button
            onClick={openSettings}
            className="w-full py-3.5 rounded-xl bg-henry-accent text-white font-bold text-sm hover:bg-henry-accent/85 transition-all"
          >
            {copy.openButton}
          </button>

          <div className="flex items-center justify-center gap-2 text-xs text-white/40 py-1">
            <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse flex-shrink-0" />
            <span>Watching for the permission… auto-advances when detected</span>
          </div>

          <button onClick={onNext} className="w-full py-3 rounded-xl border border-white/15 text-white/70 font-medium text-sm hover:border-white/30 hover:text-white transition-all">
            I enabled it — move on →
          </button>
          <button onClick={onSkip} className="block w-full text-center text-white/35 text-xs hover:text-white/60 transition-all">
            Skip — grant later
          </button>
        </>
      )}
    </div>
  );
}

function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-henry-accent/20 border border-henry-accent/40 text-henry-accent flex items-center justify-center text-[11px] font-bold mt-0.5">
      {n}
    </span>
  );
}