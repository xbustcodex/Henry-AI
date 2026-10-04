import {
  StageScreen,
  StageActions,
  StagePrimaryAction,
  STAGE_PROSE_LEADING,
  STAGE_PROSE_WIDTH,
} from '../onboarding/layout';

interface WelcomeStepProps {
  onNext: () => void;
}

export default function WelcomeStep({ onNext }: WelcomeStepProps) {

  return (
    <StageScreen className="animate-fade-in">

      {/* Henry speech bubble */}
      <div className="w-full mx-auto">
        <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-7 text-left relative">
          <div className="absolute -top-3 left-6 text-xs font-medium text-henry-text-muted bg-henry-bg px-2">
            Henry
          </div>
          <p className={`text-henry-text text-lg leading-relaxed ${STAGE_PROSE_WIDTH} mb-5`}>
            Hey. I'm Henry.
          </p>
          <p className={`text-henry-text-dim ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH} mb-5`}>
            I'm your personal AI — not a generic chatbot, but{' '}
            <span className="text-henry-text font-medium">your</span> AI.
            I can help you plan your day, draft anything, debug problems,
            research ideas, and keep track of what matters.
          </p>
          <p className={`text-henry-text-dim ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
            It takes about 60 seconds to get me online. Pick how you want me to think.
          </p>
        </div>
        <div className="flex justify-start ml-7 mt-1">
          <div className="w-3 h-3 border-l border-b border-henry-border/30 rounded-bl-sm" />
        </div>
      </div>

      {/* The action, in its own block away from the bubble above */}
      <StageActions>
        <StagePrimaryAction
          onClick={onNext}
          onTouchEnd={(e) => { e.preventDefault(); onNext(); }}
          className="py-5 text-base"
        >
          Set up AI →
        </StagePrimaryAction>
        <p
          className={`text-xs text-henry-text-muted text-center mx-auto ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}
        >
          Takes about a minute · You choose the AI · Nothing leaves your computer unless you send it
        </p>
      </StageActions>
    </StageScreen>
  );
}
