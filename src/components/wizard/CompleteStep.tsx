import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { loadProjects } from '../../henry/richMemory';
import {
  StageScreen,
  StageCard,
  StageSecondaryAction,
  StageNote,
  StageActions,
  StagePrimaryAction,
  StageTextAction,
  STAGE_PROSE_LEADING,
  STAGE_PROSE_WIDTH,
} from '../onboarding/layout';

/** What this machine actually ended up with, read from real state. */
export interface SetupOutcome {
  provider: string;
  model: string;
  hasCredential: boolean;
  localModels: number;
  opencodeInstalled: boolean;
  skipped: string[];
}

interface CompleteStepProps {
  onBack: () => void;
  onDone?: () => void;
  outcome?: SetupOutcome;
}
export default function CompleteStep({ onBack, onDone, outcome }: CompleteStepProps) {
  const { settings, providers, updateSetting, setSetupComplete } = useStore();
  const [completing, setCompleting] = useState(false);
  const [visible, setVisible] = useState(false);

  // Two clicks land before the first `await` resolves, so `completing` is not
  // enough on its own: without this, setup was marked complete twice.
  const finished = useRef(false);

  const localModel = settings.companion_model || '';
  const provider = settings.companion_provider || '';
  const isOllama = provider === 'ollama';
  const cloudHasKey = providers.some((p) => p.id === provider && p.apiKey?.trim());
  const showKeyNudge = !isOllama && !cloudHasKey;
  const noModelAtAll = !localModel && !provider;
  // unused but kept for future use
  void loadProjects;

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(t);
  }, []);

  const brainDescription = isOllama
    ? `Ollama · ${localModel || 'local model'}`
    : localModel
    ? `${provider.charAt(0).toUpperCase() + provider.slice(1)} · ${localModel}`
    : null;

  async function handleComplete() {
    if (finished.current) return;
    finished.current = true;
    setCompleting(true);
    try {
      await window.henryAPI.saveSetting('setup_complete', 'true');
      await window.henryAPI.saveSetting('henry_first_launch', 'true');
      updateSetting('setup_complete', 'true');
      updateSetting('henry_first_launch', 'true');
      setSetupComplete(true);
      onDone?.();
    } catch (err) {
      console.error('Failed to complete setup:', err);
      finished.current = false;
      setCompleting(false);
    }
  }

  return (
    <StageScreen className="animate-slide-up">

      {/* Status icon — reflect the real state */}
      <div className="text-center">
        <div className="text-5xl mb-6">
          {noModelAtAll ? '⚡' : showKeyNudge ? '🔑' : '✅'}
        </div>

        <h2 className="text-2xl font-bold text-henry-text">
          {brainDescription
            ? `Running on ${brainDescription}`
            : showKeyNudge
            ? 'Almost ready — one thing left'
            : "You're all set"}
        </h2>
        <p className={`text-sm text-henry-text-muted mt-4 ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH} mx-auto`}>
          {noModelAtAll
            ? 'You can add an AI provider in Settings anytime.'
            : showKeyNudge
            ? `${provider.charAt(0).toUpperCase() + provider.slice(1)} is selected — just add your API key to unlock it.`
            : 'You can add more providers or change settings anytime.'}
        </p>
      </div>

      {/* What this machine actually ended up with — never a generic claim */}
      {outcome && (
        <StageCard label="On this computer">
          <p className="text-sm text-henry-text">{outcome.provider ? `${brainDescription ?? outcome.provider} ` : 'No provider selected'}</p>
          <p className={`text-sm text-henry-text-muted ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
            {outcome.provider === 'ollama'
              ? `Running locally — ${outcome.localModels} model${outcome.localModels === 1 ? '' : 's'} found on this machine, nothing sent anywhere.`
              : outcome.hasCredential
              ? 'Using your own key, stored on this machine.'
              : 'Running without a key.'}
          </p>
          {outcome.opencodeInstalled && (
            <p className={`text-sm text-henry-text-muted ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
              OpenCode was detected on this machine.
            </p>
          )}
          {outcome.skipped.length > 0 && (
            <p className={`text-sm text-henry-text-muted ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
              Deferred: {outcome.skipped.join(', ')} — every one of them is in Settings whenever you
              want it.
            </p>
          )}
        </StageCard>
      )}

      {/* Henry's first words — shown when fully configured */}
      {!showKeyNudge && !noModelAtAll && (
        <div className={`transition-all duration-700 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
          <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-7 text-left relative">
            <div className="absolute -top-3 left-6 text-xs font-medium text-henry-text-muted bg-henry-bg px-2">
              Henry
            </div>
            <p className={`text-henry-text leading-relaxed ${STAGE_PROSE_WIDTH} mb-5`}>Alright. I'm up.</p>
            <p className={`text-henry-text-dim ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH} mb-5`}>
              I'm here whenever you need to think something through, write something, plan a
              project, debug a problem, or work through a decision. No special commands — just talk
              to me like you would a smart colleague.
            </p>
            <p className={`text-henry-text-dim ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
              Hit the button and we'll get started.
            </p>
          </div>
        </div>
      )}

      {/* Key nudge — prominent when AI key is missing */}
      {showKeyNudge && (
        <StageCard tone="warning">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <div className="space-y-2">
              <p className="text-sm font-semibold text-amber-400">API key needed</p>
              <p className={`text-sm text-henry-text-dim ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
                Henry can't respond without your{' '}
                {provider
                  ? `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key`
                  : 'AI provider API key'
                }
                . Add it in <strong className="text-henry-text">Settings → AI Providers</strong> —
                takes about 30 seconds.
              </p>
            </div>
          </div>
          <StageSecondaryAction onClick={onBack}>← Go back and add key</StageSecondaryAction>
        </StageCard>
      )}

      {/* No-model nudge */}
      {noModelAtAll && (
        <StageNote tone="accent">
          You can connect an AI provider anytime from{' '}
          <strong className="text-henry-text">Settings → AI Providers</strong>. Henry works with
          OpenRouter, OpenCode Zen, Ollama (local), OpenAI, Anthropic, and Google.
        </StageNote>
      )}

      <StageActions>
        {!showKeyNudge && <StageTextAction onClick={onBack}>← Back</StageTextAction>}
        <StagePrimaryAction onClick={handleComplete} disabled={completing}>
          {completing ? 'Starting up...' : showKeyNudge ? 'Continue anyway →' : 'Meet Henry →'}
        </StagePrimaryAction>
        {showKeyNudge && (
          <p className={`text-xs text-henry-text-muted text-center ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
            You can add the key later in Settings — Henry just won't be able to respond until then.
          </p>
        )}
      </StageActions>
    </StageScreen>
  );
}
