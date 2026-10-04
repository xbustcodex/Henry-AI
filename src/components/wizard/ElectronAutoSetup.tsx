/**
 * ElectronAutoSetup — shown on first launch in the desktop app.
 *
 * Runs Ollama detection/install/pull automatically with no user clicks.
 * When done, saves all settings and calls onComplete() → enters Henry.
 * Escape hatch: "Use cloud AI instead" → onWantCloud().
 */
import { useState } from 'react';
import { useStore } from '../../store';
import OllamaElectronSetup from './OllamaElectronSetup';

interface Props {
  onComplete: () => void;
}

export default function ElectronAutoSetup({ onComplete }: Props) {
  const { updateSetting, setProviders, setSetupComplete } = useStore();
  const [saving, setSaving] = useState(false);
  const [wantCloud, setWantCloud] = useState(false);

  // Cloud state (shown only if user hits escape hatch)
  const [cloudProvider, setCloudProvider] = useState<'openai' | 'anthropic' | 'google'>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [cloudSaving, setCloudSaving] = useState(false);

  async function handleModelReady(model: string) {
    setSaving(true);
    try {
      await window.henryAPI.saveSetting('ollama_base_url', 'http://127.0.0.1:11434');
      await window.henryAPI.saveSetting('companion_model', model);
      await window.henryAPI.saveSetting('companion_provider', 'ollama');
      await window.henryAPI.saveSetting('worker_model', model);
      await window.henryAPI.saveSetting('worker_provider', 'ollama');
      await window.henryAPI.saveSetting('setup_complete', 'true');
      await window.henryAPI.saveProvider({
        id: 'ollama', name: 'Ollama', apiKey: '', enabled: true,
        models: JSON.stringify([model]),
      });

      updateSetting('ollama_base_url', 'http://127.0.0.1:11434');
      updateSetting('companion_model', model);
      updateSetting('companion_provider', 'ollama');
      updateSetting('worker_model', model);
      updateSetting('worker_provider', 'ollama');
      updateSetting('setup_complete', 'true');

      const rawProviders = await window.henryAPI.getProviders();
      setProviders(rawProviders.map((p: any) => ({
        id: p.id, name: p.name,
        apiKey: p.api_key ?? p.apiKey ?? '',
        enabled: Boolean(p.enabled),
        models: typeof p.models === 'string' ? JSON.parse(p.models || '[]') : (p.models || []),
      })));

      setSetupComplete(true);
      onComplete();
    } catch (err) {
      console.error('ElectronAutoSetup: failed to save settings', err);
      setSaving(false);
    }
  }

  async function handleCloudSave() {
    setCloudSaving(true);
    const models: Record<string, string> = {
      openai: 'gpt-4o',
      anthropic: 'claude-3-5-sonnet-20241022',
      google: 'gemini-1.5-pro',
    };
    const names: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };
    const model = models[cloudProvider];
    try {
      await window.henryAPI.saveSetting('companion_model', model);
      await window.henryAPI.saveSetting('companion_provider', cloudProvider);
      await window.henryAPI.saveSetting('worker_model', model);
      await window.henryAPI.saveSetting('worker_provider', cloudProvider);
      await window.henryAPI.saveSetting('setup_complete', 'true');
      await window.henryAPI.saveProvider({
        id: cloudProvider, name: names[cloudProvider],
        apiKey: apiKey.trim(), enabled: true,
        models: JSON.stringify([model]),
      });

      updateSetting('companion_model', model);
      updateSetting('companion_provider', cloudProvider);
      updateSetting('worker_model', model);
      updateSetting('worker_provider', cloudProvider);
      updateSetting('setup_complete', 'true');

      const rawProviders = await window.henryAPI.getProviders();
      setProviders(rawProviders.map((p: any) => ({
        id: p.id, name: p.name,
        apiKey: p.api_key ?? p.apiKey ?? '',
        enabled: Boolean(p.enabled),
        models: typeof p.models === 'string' ? JSON.parse(p.models || '[]') : (p.models || []),
      })));

      setSetupComplete(true);
      onComplete();
    } catch (err) {
      console.error('ElectronAutoSetup: cloud save failed', err);
      setCloudSaving(false);
    }
  }

  return (
    <div className="h-screen w-screen bg-henry-bg flex flex-col items-center justify-center px-6">
      <div className="titlebar-drag h-12 shrink-0 absolute top-0 w-full" />

      <div className="w-full max-w-md animate-fade-in">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-5xl mb-4">🧠</div>
          <h1 className="text-xl font-bold text-henry-text mb-1">Henry AI</h1>
          <p className="text-sm text-henry-text-dim">
            {wantCloud ? 'Choose your cloud AI provider' : 'Getting your local AI ready…'}
          </p>
        </div>

        {/* ── Local Ollama auto-setup ── */}
        {!wantCloud && (
          <>
            {saving ? (
              <div className="flex flex-col items-center gap-3 py-10 text-henry-text-dim text-sm">
                <div className="w-6 h-6 border-2 border-henry-accent border-t-transparent rounded-full animate-spin" />
                <p>Saving settings…</p>
              </div>
            ) : (
              <OllamaElectronSetup
                onModelReady={handleModelReady}
                onFallback={() => setWantCloud(true)}
              />
            )}

            <div className="mt-5 text-center">
              <button
                onClick={() => setWantCloud(true)}
                className="text-xs text-henry-text-muted hover:text-henry-text transition-colors underline underline-offset-4"
              >
                Use cloud AI instead (OpenAI / Anthropic) →
              </button>
            </div>
          </>
        )}

        {/* ── Cloud escape hatch ── */}
        {wantCloud && (
          <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 space-y-4">
            {/* Provider selector */}
            <div className="flex gap-2">
              {(['openai', 'anthropic', 'google'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setCloudProvider(p)}
                  className={`flex-1 py-2 rounded-xl text-xs font-medium transition-all ${
                    cloudProvider === p
                      ? 'bg-henry-accent text-white'
                      : 'bg-henry-hover text-henry-text-dim hover:text-henry-text'
                  }`}
                >
                  {p === 'openai' ? 'OpenAI' : p === 'anthropic' ? 'Anthropic' : 'Google'}
                </button>
              ))}
            </div>

            {/* API key */}
            <div>
              <label className="text-xs text-henry-text-dim block mb-2">
                API Key <span className="text-henry-text-muted">(optional — add later in Settings)</span>
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste key or skip for now…"
                className="w-full bg-henry-bg border border-henry-border rounded-xl px-4 py-3 text-sm text-henry-text outline-none focus:border-henry-accent/50"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setWantCloud(false)}
                className="flex-1 py-2.5 rounded-xl border border-henry-border text-xs text-henry-text-muted hover:text-henry-text transition-all"
              >
                ← Back to local AI
              </button>
              <button
                onClick={handleCloudSave}
                disabled={cloudSaving}
                className="flex-1 py-2.5 rounded-xl bg-henry-accent text-white text-sm font-medium hover:bg-henry-accent-hover transition-all disabled:opacity-50"
              >
                {cloudSaving ? 'Saving…' : 'Enter Henry →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
