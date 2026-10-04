import { useCallback, useEffect, useState } from 'react';
import {
  StageScreen,
  StageHeading,
  StageCard,
  StageActions,
  StagePrimaryAction,
  StageSecondaryAction,
  StageStep,
  STAGE_PROSE_LEADING,
  STAGE_PROSE_WIDTH,
} from '../layout';
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
    <StageScreen>
      <StageHeading icon={copy.icon} title={copy.title}>
        <p>{copy.blurb}</p>
      </StageHeading>

      {granted === true ? (
        <StageCard tone="success" className="text-center">
          <p className="text-4xl">✓</p>
          <p className="text-green-400 font-semibold text-lg">{copy.title} enabled</p>
          <p className="text-henry-text-dim text-sm">Detected. Moving on automatically…</p>
        </StageCard>
      ) : (
        <>
          <StageCard label="Step by step">
            <ol className="space-y-5">
              <StageStep n={1}>
                Click <b className="text-henry-text">Open Settings</b> below. System Settings opens
                to the {kind === 'accessibility' ? 'Accessibility' : 'Screen Recording'} list.
              </StageStep>
              <StageStep n={2}>
                Click the <b className="text-henry-text">+</b> button and select{' '}
                <b className="text-henry-text">Henry AI</b>.
              </StageStep>
              <StageStep n={3}>
                Toggle it <b className="text-henry-text">ON</b>.{' '}
                <span className="text-henry-accent">This stage detects it automatically</span> —
                nothing to click here.
              </StageStep>
            </ol>
          </StageCard>

          <StageActions>
            <StagePrimaryAction onClick={openSettings}>{copy.openButton}</StagePrimaryAction>

            <div className="flex items-center justify-center gap-2.5 text-xs text-henry-text-muted py-2">
              <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse flex-shrink-0" />
              <span className={`${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
                Watching for the permission… auto-advances when detected
              </span>
            </div>

            <StageSecondaryAction onClick={onNext}>I enabled it — move on →</StageSecondaryAction>
            <StageSecondaryAction onClick={onSkip} className="border-transparent">
              Skip — grant later
            </StageSecondaryAction>
          </StageActions>
        </>
      )}
    </StageScreen>
  );
}