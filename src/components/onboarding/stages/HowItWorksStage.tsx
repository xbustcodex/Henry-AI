import { isMacOS } from '../../../utils/platform';
import {
  StageScreen,
  StageHeading,
  StageCard,
  StageNote,
  StageActions,
  StagePrimaryAction,
  StageSecondaryAction,
  STAGE_PROSE_LEADING,
  STAGE_PROSE_WIDTH,
} from '../layout';

interface Props {
  onNext: () => void;
  onSkip: () => void;
}

/** Shortcut labels come from the platform, never from an assumed one. */
const captureKey = isMacOS() ? '⌥ Space' : 'Alt+C';
const captureLabel = isMacOS() ? 'Option + Space' : 'Alt+C';
const openKey = isMacOS() ? '⌘⇧H' : 'Alt+H';
const openLabel = isMacOS() ? 'Cmd + Shift + H' : 'Alt+H';
const launcherDesc = isMacOS()
  ? "Henry lives in your Mac's dock. Click anytime to open the full app."
  : 'Henry lives in your app launcher. Click anytime to open the full app.';

const WAYS = [
  {
    key: captureKey,
    label: captureLabel,
    desc: `Works in any app, any screen. Selected text is pasted in so Henry can read it. Select something, press ${captureLabel}, ask about it.`,
  },
  {
    key: openKey,
    label: openLabel,
    desc: isMacOS()
      ? 'Opens the full Henry window from anywhere on your Mac.'
      : 'Opens the full Henry window from anywhere on your computer.',
  },
  { key: '🖱', label: 'Click the app icon', desc: launcherDesc },
];

export default function HowItWorksStage({ onNext, onSkip }: Props) {
  return (
    <StageScreen>
      <StageHeading icon="⌨️" title="How to use Henry">
        <p>Three ways to open him. Use whichever feels natural.</p>
      </StageHeading>

      <div className="space-y-4">
        {WAYS.map((way) => (
          <div
            key={way.key}
            className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 flex gap-4 items-start"
          >
            <div className="bg-henry-accent/15 border border-henry-accent/40 rounded-lg px-3 py-2 text-henry-accent font-mono font-bold text-sm flex-shrink-0 min-w-[56px] text-center">
              {way.key}
            </div>
            <div>
              <p className="text-henry-text text-sm font-semibold">{way.label}</p>
              <p className={`text-henry-text-dim text-sm mt-2 ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
                {way.desc}
              </p>
            </div>
          </div>
        ))}
      </div>

      <StageCard tone="accent" label="Tip — try this right now">
        <p className={`text-henry-text-dim text-sm ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
          Find any text on your screen — an email, a website, anything.{' '}
          <b className="text-henry-text">Select it</b>, then press{' '}
          <b className="text-henry-text">{captureLabel}</b>. Henry opens with that text already
          loaded. Ask him to summarize, reply, explain, or act on it.
        </p>
      </StageCard>

      <StageActions>
        <StagePrimaryAction onClick={onNext}>Got it — continue →</StagePrimaryAction>
        <StageSecondaryAction onClick={onSkip}>Skip — set up later</StageSecondaryAction>
      </StageActions>
    </StageScreen>
  );
}