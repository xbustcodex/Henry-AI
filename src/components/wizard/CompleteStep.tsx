import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { loadProjects } from '../../henry/richMemory';

interface CompleteStepProps {
  onBack: () => void;
}

export default function CompleteStep({ onBack }: CompleteStepProps) {
  const { settings, providers, updateSetting, setSetupComplete } = useStore();
  const [completing, setCompleting] = useState(false);
  const [visible, setVisible] = useState(false);

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
    setCompleting(true);
    try {
      await window.henryAPI.saveSetting('setup_complete', 'true');
      await window.henryAPI.saveSetting('henry_first_launch', 'true');
      updateSetting('setup_complete', 'true');
      updateSetting('henry_first_launch', 'true');
      setSetupComplete(true);
    } catch (err) {
      console.error('Failed to complete setup:', err);
      setCompleting(false);
    }
  }

  return (
    <div className="text-center animate-slide-up">

      {/* Status icon — reflect the real state */}
      <div className="text-5xl mb-6">
        {noModelAtAll ? '⚡' : showKeyNudge ? '🔑' : '✅'}
      </div>

      <h2 className="text-xl font-bold text-henry-text mb-2">
        {brainDescription
          ? `Running on ${brainDescription}`
          : showKeyNudge
          ? 'Almost ready — one thing left'
          : "You're all set"}
      </h2>
      <p className="text-sm text-henry-text-muted mb-10">
        {noModelAtAll
          ? 'You can add an AI provider in Settings anytime.'
          : showKeyNudge
          ? `${provider.charAt(0).toUpperCase() + provider.slice(1)} is selected — just add your API key to unlock it.`
          : 'You can add more providers or change settings anytime.'}
      </p>

      {/* Henry's first words — shown when fully configured */}
      {!showKeyNudge && !noModelAtAll && (
        <div className={`max-w-lg mx-auto mb-10 transition-all duration-700 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
          <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-6 text-left relative">
            <div className="absolute -top-3 left-6 text-xs font-medium text-henry-text-muted bg-henry-bg px-2">
              Henry
            </div>
            <p className="text-henry-text leading-relaxed mb-3">
              Alright. I'm up.
            </p>
            <p className="text-henry-text-dim leading-relaxed mb-3">
              I'm here whenever you need to think something through, write something,
              plan a project, debug a problem, or work through a decision.
              No special commands — just talk to me like you would a smart colleague.
            </p>
            <p className="text-henry-text-dim leading-relaxed">
              Hit the button and we'll get started.
            </p>
          </div>
        </div>
      )}

      {/* Key nudge — prominent when AI key is missing */}
      {showKeyNudge && (
        <div className="max-w-lg mx-auto mb-8">
          <div className="bg-amber-500/5 border border-amber-500/30 rounded-2xl p-5 text-left space-y-3">
            <div className="flex items-start gap-3">
              <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <div>
                <p className="text-sm font-semibold text-amber-400 mb-1">API key needed</p>
                <p className="text-sm text-henry-text-dim leading-relaxed">
                  Henry can't respond without your{' '}
                  {provider
                    ? `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key`
                    : 'AI provider API key'
                  }.
                  Add it in <strong className="text-henry-text">Settings → AI Providers</strong>{' '}
                  — takes about 30 seconds.
                </p>
              </div>
            </div>
            <button
              onClick={onBack}
              className="w-full py-3 bg-henry-accent text-white rounded-xl text-sm font-semibold hover:bg-henry-accent/90 transition-colors"
            >
              ← Go back and add key
            </button>
          </div>
        </div>
      )}

      {/* No-model nudge */}
      {noModelAtAll && (
        <div className="max-w-lg mx-auto mb-8">
          <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 text-left">
            <p className="text-sm text-henry-text-dim leading-relaxed">
              You can connect an AI provider anytime from{' '}
              <strong className="text-henry-text">Settings → AI Providers</strong>.
              Henry works with Groq (free), Ollama (local), OpenAI, Anthropic, and Google.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-center gap-4">
        {!showKeyNudge && (
          <button
            onClick={onBack}
            className="px-6 py-2.5 text-henry-text-dim hover:text-henry-text transition-colors text-sm"
          >
            ← Back
          </button>
        )}
        <button
          onClick={handleComplete}
          disabled={completing}
          className="px-12 py-4 bg-henry-accent text-white rounded-2xl font-semibold text-lg hover:bg-henry-accent-hover transition-all shadow-lg shadow-henry-accent/20 disabled:opacity-60"
        >
          {completing
            ? 'Starting up...'
            : showKeyNudge
            ? 'Continue anyway →'
            : 'Meet Henry →'}
        </button>
      </div>

      {showKeyNudge && (
        <p className="text-xs text-henry-text-muted mt-3">
          You can add the key later in Settings — Henry just won't be able to respond until then.
        </p>
      )}
    </div>
  );
}
