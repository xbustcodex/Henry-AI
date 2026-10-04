interface WelcomeStepProps {
  onNext: () => void;
}

export default function WelcomeStep({ onNext }: WelcomeStepProps) {

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] animate-fade-in text-center px-4">

      {/* Henry speech bubble */}
      <div className="max-w-lg mx-auto mb-10 w-full">
        <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-7 text-left relative">
          <div className="absolute -top-3 left-6 text-xs font-medium text-henry-text-muted bg-henry-bg px-2">
            Henry
          </div>
          <p className="text-henry-text text-lg leading-relaxed mb-4">
            Hey. I'm Henry.
          </p>
          <p className="text-henry-text-dim leading-relaxed mb-4">
            I'm your personal AI — not a generic chatbot, but{' '}
            <span className="text-henry-text font-medium">your</span> AI.
            I can help you plan your day, draft anything, debug problems,
            research ideas, and keep track of what matters.
          </p>
          <p className="text-henry-text-dim leading-relaxed">
            It takes about 60 seconds to get me online. Pick how you want me to think.
          </p>
        </div>
        <div className="flex justify-start ml-7 mt-1">
          <div className="w-3 h-3 border-l border-b border-henry-border/30 rounded-bl-sm" />
        </div>
      </div>

      {/* Primary action — always go to provider setup */}
      <button
        onClick={onNext}
        onTouchEnd={(e) => { e.preventDefault(); onNext(); }}
        className="px-10 py-4 bg-henry-accent text-white rounded-2xl font-semibold text-lg hover:bg-henry-accent-hover transition-all shadow-lg shadow-henry-accent/20 touch-manipulation select-none"
      >
        Set up AI →
      </button>

      <p className="text-xs text-henry-text-muted mt-3">
        Takes about a minute · You choose the AI · Nothing leaves your computer unless you send it
      </p>
    </div>
  );
}
