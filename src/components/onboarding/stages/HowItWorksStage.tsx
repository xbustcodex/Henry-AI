import { isMacOS } from '../../../utils/platform';

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
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-5xl mb-3">⌨️</p>
        <h2 className="text-2xl font-bold text-white">How to use Henry</h2>
        <p className="text-white/55 text-sm mt-2 leading-relaxed">
          Three ways to open him. Use whichever feels natural.
        </p>
      </div>

      <div className="space-y-3">
        {WAYS.map((way) => (
          <div
            key={way.key}
            className="bg-white/5 border border-white/10 rounded-xl p-4 flex gap-4 items-start"
          >
            <div className="bg-henry-accent/20 border border-henry-accent/40 rounded-lg px-2.5 py-1.5 text-henry-accent font-mono font-bold text-sm flex-shrink-0 min-w-[52px] text-center">
              {way.key}
            </div>
            <div>
              <p className="text-white text-sm font-semibold">{way.label}</p>
              <p className="text-white/50 text-xs mt-0.5 leading-relaxed">{way.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-henry-accent/8 border border-henry-accent/20 rounded-xl p-4 space-y-2">
        <p className="text-henry-accent text-xs font-bold uppercase tracking-wider">
          {captureLabel} tip — try this right now
        </p>
        <p className="text-white/70 text-sm leading-relaxed">
          Find any text on your screen — an email, a website, anything.{' '}
          <b className="text-white">Select it</b>, then press{' '}
          <b className="text-white">{captureLabel}</b>. Henry opens with that text already loaded. Ask him to
          summarize, reply, explain, or act on it.
        </p>
      </div>

      <button onClick={onNext} className="w-full py-3.5 rounded-xl bg-henry-accent text-white font-bold text-sm hover:bg-henry-accent/85 transition-all">
        Got it — continue →
      </button>
      <button onClick={onSkip} className="block w-full text-center text-white/35 text-xs hover:text-white/60 transition-all">
        Skip — set up later
      </button>
    </div>
  );
}