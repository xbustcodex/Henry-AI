import { useState } from 'react';
import WelcomeStep from './WelcomeStep';
import ProviderStep from './ProviderStep';
import CompleteStep from './CompleteStep';

const STEPS = ['Hello', 'Power Me Up', 'First Contact'];

export default function SetupWizard() {
  const [currentStep, setCurrentStep] = useState(0);

  function next() {
    setCurrentStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function back() {
    setCurrentStep((s) => Math.max(s - 1, 0));
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-henry-bg overflow-hidden">
      <div className="titlebar-drag h-12 shrink-0" />

      <div className="flex-1 flex flex-col items-center justify-center px-6 overflow-y-auto">
        <div className="w-full max-w-2xl">
          {/* Progress dots */}
          {currentStep > 0 && (
            <div className="flex items-center justify-center gap-3 mb-10">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className={`transition-all rounded-full ${
                    i === currentStep
                      ? 'w-6 h-2 bg-henry-accent'
                      : i < currentStep
                      ? 'w-2 h-2 bg-henry-success/50'
                      : 'w-2 h-2 bg-henry-border'
                  }`}
                />
              ))}
            </div>
          )}

          <div className="animate-fade-in">
            {currentStep === 0 && <WelcomeStep onNext={next} />}
            {currentStep === 1 && <ProviderStep onNext={next} onBack={back} />}
            {currentStep === 2 && <CompleteStep onBack={back} />}
          </div>
        </div>
      </div>
    </div>
  );
}
