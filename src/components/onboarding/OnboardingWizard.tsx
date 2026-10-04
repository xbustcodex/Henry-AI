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
 * overlay, so a relaunch from the Setup panel walks the same stages in the same
 * order and skips the same ones.
 */

export const ONBOARDING_DONE_KEY = 'henry:onboarding_v1_complete';

export function shouldShowOnboarding(): boolean {
  return !localStorage.getItem(ONBOARDING_DONE_KEY);
}

interface Props {
  onComplete: () => void;
}

export default function OnboardingWizard({ onComplete }: Props) {
  return (
    <div className="fixed inset-0 z-[200]">
      <SetupWizard
        onComplete={() => {
          localStorage.setItem(ONBOARDING_DONE_KEY, 'true');
          onComplete();
        }}
      />
    </div>
  );
}