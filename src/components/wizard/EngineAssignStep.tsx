import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { AVAILABLE_MODELS, PROVIDERS, formatPrice, type ProviderId } from '../../providers/models';
import type { AIModel } from '../../types';
import { localModelsToAIModels, localCatalogState, OLLAMA_PROVIDER_ID } from '../../providers/localModels';
import type { LocalCatalogState } from '../../providers/localModels';
import type { LocalModelInfo } from '../../../electron/ipc/ollamaCapabilities';

interface EngineAssignStepProps {
  onNext: () => void;
  onBack: () => void;
  /** This stage is optional, so leaving it must be a choice, not a dead end. */
  onSkip?: () => void;
}
export default function EngineAssignStep({ onNext, onBack, onSkip }: EngineAssignStepProps) {
  const { providers, settings, updateSetting } = useStore();
  const [localModel, setLocalModel] = useState(settings.companion_model || '');
  const [cloudModel, setCloudModel] = useState(settings.worker_model || '');
  const [localCustom, setLocalCustom] = useState('');

  const enabledProviderIds = providers.filter((p) => p.enabled).map((p) => p.id);
  const ollamaEnabled = enabledProviderIds.includes(OLLAMA_PROVIDER_ID);
  const cloudProviders = enabledProviderIds.filter((id) => id !== OLLAMA_PROVIDER_ID);

  // The local list is the runtime's, not a table's: what Ollama holds right now.
  // This step used to render `AVAILABLE_MODELS.filter(provider === 'ollama')`,
  // which offered models the user had never pulled and none they had.
  const [localModels, setLocalModels] = useState<LocalModelInfo[]>([]);
  const [localCatalog, setLocalCatalog] = useState<LocalCatalogState>({ kind: 'ok' });
  const localBaseUrl = settings.ollama_base_url || 'http://127.0.0.1:11434';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = await window.henryAPI.ollamaModels?.(localBaseUrl);
        if (cancelled) return;
        const models = found?.models ?? [];
        setLocalModels(models);
        setLocalCatalog(localCatalogState(models, found?.error));
      } catch (err: unknown) {
        if (!cancelled) {
          setLocalModels([]);
          setLocalCatalog({ kind: 'unreachable', message: err instanceof Error ? err.message : 'Could not reach Ollama' });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [localBaseUrl]);

  const localOptions = localModelsToAIModels(localModels);
  const cloudModels = AVAILABLE_MODELS.filter((m) => cloudProviders.includes(m.provider));

  const effectiveLocal = localCustom.trim() || localModel;
  const effectiveCloud = cloudModel;

  const localProvider = OLLAMA_PROVIDER_ID;
  const cloudProvider = AVAILABLE_MODELS.find((m) => m.id === cloudModel)?.provider ?? '';

  async function handleNext() {
    try {
      await window.henryAPI.saveSetting('companion_model', effectiveLocal);
      await window.henryAPI.saveSetting('companion_provider', effectiveLocal ? localProvider : '');
      await window.henryAPI.saveSetting('worker_model', effectiveCloud || effectiveLocal);
      await window.henryAPI.saveSetting('worker_provider', effectiveCloud ? cloudProvider : (effectiveLocal ? localProvider : ''));

      updateSetting('companion_model', effectiveLocal);
      updateSetting('companion_provider', effectiveLocal ? localProvider : '');
      updateSetting('worker_model', effectiveCloud || effectiveLocal);
      updateSetting('worker_provider', effectiveCloud ? cloudProvider : (effectiveLocal ? localProvider : ''));

      onNext();
    } catch (err) {
      console.error('Failed to save engine assignments:', err);
    }
  }

  const canContinue = !!(effectiveLocal) || cloudModels.length > 0 && !!effectiveCloud;

  return (
    <div className="animate-slide-up">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-henry-text mb-2">Pick Your Brains</h2>
        <p className="text-henry-text-dim max-w-md mx-auto">
          Henry uses two engines. Your <span className="text-henry-companion font-medium">Local Brain</span> runs
          free on your machine. Your <span className="text-henry-worker font-medium">Second Brain</span> is
          a cloud AI you call in when you want more power.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-5 mb-8">
        {/* Local Brain */}
        <div className="rounded-xl border border-henry-companion/30 bg-henry-companion/5 p-5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">🏠</span>
            <h3 className="font-semibold text-henry-text">Local Brain</h3>
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-henry-success/15 text-henry-success font-medium">Free</span>
          </div>
          <p className="text-xs text-henry-text-dim mb-4 leading-relaxed">
            Ollama runs on your computer. Private, free, always available — even offline.
          </p>

          {ollamaEnabled ? (
            <>
              <div className="mb-3">
                <div className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider mb-2">
                  Type your model name
                </div>
                <input
                  type="text"
                  value={localCustom}
                  onChange={(e) => { setLocalCustom(e.target.value); setLocalModel(''); }}
                  placeholder="e.g. llama3, mistral, phi4"
                  className="w-full text-xs rounded-lg border border-henry-border/50 bg-henry-bg/60 text-henry-text px-3 py-2 focus:outline-none focus:ring-1 focus:ring-henry-accent/50 placeholder:text-henry-text-muted/60 mb-2"
                />
                {localCustom.trim() && (
                  <p className="text-[10px] text-henry-success">
                    Will use: <code>{localCustom.trim()}</code>
                  </p>
                )}
              </div>

              {localOptions.length > 0 ? (
                <div>
                  <div className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider mb-2">
                    Or pick from what&apos;s installed ({localOptions.length})
                  </div>
                  <div className="space-y-1.5 max-h-44 overflow-y-auto">
                    {localOptions.map((model) => (
                      <ModelOption
                        key={model.id}
                        model={model}
                        selected={!localCustom.trim() && localModel === model.id}
                        onSelect={() => { setLocalModel(model.id); setLocalCustom(''); }}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-[10px] text-henry-text-dim">
                  {localCatalog.message ?? 'No local models found yet — pull one, or type a name above.'}
                </p>
              )}
            </>
          ) : (
            <div className="rounded-lg bg-henry-bg/50 border border-henry-border/30 p-3 text-xs text-henry-text-dim">
              Enable Ollama on the previous step to use local models.
            </div>
          )}
        </div>

        {/* Second Brain */}
        <div className="rounded-xl border border-henry-worker/30 bg-henry-worker/5 p-5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">☁️</span>
            <h3 className="font-semibold text-henry-text">Second Brain</h3>
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-henry-hover text-henry-text-muted font-medium">optional</span>
          </div>
          <p className="text-xs text-henry-text-dim mb-4 leading-relaxed">
            A cloud AI (GPT-4, Claude, Gemini) for when you want sharper, more powerful answers.
            You pick which one to use for each message.
          </p>

          {cloudModels.length > 0 ? (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {cloudModels.map((model) => (
                <ModelOption
                  key={model.id}
                  model={model}
                  selected={cloudModel === model.id}
                  onSelect={() => setCloudModel(model.id)}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-lg bg-henry-bg/50 border border-henry-border/30 p-3 text-xs text-henry-text-dim leading-relaxed">
              Add a cloud provider (OpenAI, Anthropic, Google) on the previous step to unlock the Second Brain.
              <br /><br />
              You can also skip this and add one later in Settings.
            </div>
          )}
        </div>
      </div>

      {!effectiveLocal && cloudModels.length > 0 && effectiveCloud && (
        <p className="text-xs text-henry-text-muted text-center mb-4">
          No local model set — cloud will handle all requests.
        </p>
      )}

      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="px-6 py-2.5 text-henry-text-dim hover:text-henry-text transition-colors text-sm"
        >
          ← Back
        </button>
        <button
          onClick={handleNext}
          disabled={!canContinue}
          className={`px-8 py-2.5 rounded-xl font-medium text-sm transition-all ${
            canContinue
              ? 'bg-henry-accent text-white hover:bg-henry-accent-hover'
              : 'bg-henry-hover text-henry-text-muted cursor-not-allowed'
          }`}
        >
          Continue →
        </button>
      </div>

      {onSkip && (
        <p className="text-center mt-4">
          <button onClick={onSkip} className="text-xs text-henry-text-muted hover:text-henry-text transition-colors underline underline-offset-4">
            Skip — use one model for everything for now
          </button>
        </p>
      )}
    </div>
  );
}

function ModelOption({
  model,
  selected,
  onSelect,
}: {
  model: AIModel;
  selected: boolean;
  onSelect: () => void;
}) {
  const providerInfo = PROVIDERS[model.provider as ProviderId];

  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-2.5 p-2.5 rounded-lg text-left transition-all ${
        selected
          ? 'bg-henry-accent/10 border border-henry-accent/30'
          : 'bg-henry-bg/50 border border-transparent hover:bg-henry-hover/50'
      }`}
    >
      <div
        className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
          selected ? 'border-henry-accent' : 'border-henry-border'
        }`}
      >
        {selected && <div className="w-1.5 h-1.5 rounded-full bg-henry-accent" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs">{providerInfo?.icon}</span>
          <span className="text-xs font-medium text-henry-text truncate">{model.name}</span>
        </div>
        <div className="text-[10px] text-henry-text-muted">
          {model.local ? 'Free (local)' : `${formatPrice(model.inputPricePer1M)} in / ${formatPrice(model.outputPricePer1M)} out per 1M`}
        </div>
      </div>
    </button>
  );
}
