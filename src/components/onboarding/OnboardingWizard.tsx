import SetupWizard from '../wizard/SetupWizard';

/**
 * The onboarding overlay.
 *
 * This used to be a second, independent wizard: nine stages of its own, with its
 * own navigation, its own idea of which stages exist, and its own idea of when
 * setup was finished — while the first-launch path ran a different, three-step
 * wizard. Two machines meant "did the user see setup?" had two answers, and
 * neither was the whole list.
 *
 * It is now the same machine as first launch (`SetupWizard`), presented as an
 * overlay. It also no longer decides *whether* it should appear: that was a
 * second gate reading a second completion marker, so finishing the first-launch
 * flow dropped the user straight into a second, identical run. One gate in
 * `App.tsx` owns that decision now, and this file is only the frame.
 */

interface Props {
  onComplete: () => void;
}

export default function OnboardingWizard({ onComplete }: Props) {
  return (
    <div className="fixed inset-0 z-[200]">
      <SetupWizard onComplete={onComplete} />
    </div>
  );
}