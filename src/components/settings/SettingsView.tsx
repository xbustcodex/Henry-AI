/**
 * SettingsView — Settings tab content.
 *
 * Rebuilt 2026-06-08 after the original 2,026-line file was lost in an
 * iCloud file-churn incident and only a 3-panel placeholder remained. The
 * earlier file depended on ~9 modules that no longer exist (proxyUsage,
 * priority/*, initiativeStore, sessionModeStore, richMemory, …), so rather
 * than resurrect dead code this is a focused, current rebuild covering the
 * settings that actually matter for a working app:
 *
 *   - Profile        — your name + location (feeds memory & weather)
 *   - AI Providers   — enter/update the API key for each provider
 *   - Engines        — assign a provider+model to the Companion and Worker
 *   - Pairing/Health — the existing RemoteControl / DeviceLink / Health panels
 *
 * Everything persists through the same IPC the setup wizard uses
 * (`providers:save`, `settings:save`) and mirrors into the Zustand store so the
 * rest of the app sees changes immediately.
 */

import { useEffect, useState, useMemo } from 'react';
import { saveUserProfile } from '../../henry/userProfile';
import { useStore } from '../../store';
import type { AIProvider } from '../../types';
import { PROVIDERS, AVAILABLE_MODELS, formatPrice } from '../../providers/models';
import {
  OPENCODE_ZEN_PROVIDER_ID,
  opencodeProviderIdForModel,
} from '../../../electron/providers/classification';
import {
  localModelsToAIModels,
  localModelLabel,
  localCatalogState,
  OLLAMA_PROVIDER_ID,
  type LocalCatalogState,
} from '../../providers/localModels';
import type { LocalModelInfo } from '../../../electron/ipc/ollamaCapabilities';
import { toast } from '../ui/Toast';
import RemoteControlPanel from './RemoteControlPanel';
import DeviceLinkPanel from './DeviceLinkPanel';
import HealthPanel from './HealthPanel';
import GoogleConnectionPanel from './GoogleConnectionPanel';
import SecurityPanel from './SecurityPanel';
import PrivacyPanel from './PrivacyPanel';
import LogsPanel from './LogsPanel';
import AppLockGate from '../lock/AppLockGate';
import KnowledgePanel from '../knowledge/KnowledgePanel';
import { isMacOS, getPlatformName } from '../../utils/platform';
import type { EndpointingSettings } from '../../henry/voiceEndpointing';
import { getEndpointingSettings, saveEndpointingSettings } from '../../henry/voice';
import {
  ASSISTANT_NAME_SETTING_KEY,
  DEFAULT_ASSISTANT_NAME,
  MAX_ASSISTANT_NAME_LENGTH,
  assistantNameFrom,
  normalizeAssistantName,
} from '../../henry/assistantName';

import {
  CODER_ENGINE_LABELS,
  CODER_ENGINE_SETTING_KEY,
  coderAvailable,
  getCoderStatus,
  isCoderEngineChoice,
  type CoderEngineChoice,
} from '../../henry/coderEngine';
import {
  voiceIpcAvailable,
  getVoiceSttStatus,
  getVoiceTtsStatus,
  runVoiceSetup,
  speak as voiceSpeak,
  stopSpeaking as voiceStopSpeaking,
  startVoiceRecording,
  stopVoiceRecording,
  transcribeLocal,
} from '../../henry/voice';
/**
 * The Voice panel describes what this machine can actually do. Whisper and the
 * system voice are macOS binaries bundled in resources/bin, so on Windows and
 * Linux those settings do nothing until something equivalent is installed —
 * saying otherwise sends people looking for settings that aren't there.
 */
function voiceSubtitle(): string {
  if (isMacOS()) {
    return 'Henry talks and listens. Listening runs FREE on your Mac (whisper.cpp). Speaking uses the free macOS voice — or ElevenLabs automatically when a key is saved.';
  }
  return `Henry talks and listens. ElevenLabs works on ${getPlatformName()} once a key is saved. Free local listening and speech need an engine installed on this ${getPlatformName()} — see the options below.`;
}


// Providers that take an API key and can drive chat. (Ollama is local/keyless.)
const CLOUD_PROVIDER_IDS = ['openai', 'anthropic', 'google', 'opencode-zen'] as const;

const inputCls =
  'w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm ' +
  'text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all';
const labelCls = 'block text-xs font-medium text-henry-text-dim mb-1';
const cardCls = 'bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4';
const btnCls =
  'px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent/20 text-henry-accent ' +
  'hover:bg-henry-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

/** Refresh the store's providers list from the DB (post-save). */
async function refreshProviders(setProviders: (p: AIProvider[]) => void) {
  try {
    const raw = await window.henryAPI.getProviders?.();
    if (!raw) return;
    setProviders(
      raw.map((p) => ({
        id: p.id,
        name: p.name,
        apiKey: p.api_key ?? p.apiKey ?? '',
        enabled: Boolean(p.enabled),
        models: Array.isArray(p.models)
          ? p.models
          : ((): string[] => { try { return JSON.parse(p.models || '[]'); } catch { return []; } })(),
      })),
    );
  } catch {
    /* non-fatal — store keeps its current value */
  }
}

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-henry-text">{title}</h2>
      {sub && <p className="text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">{sub}</p>}
    </div>
  );
}

// ── Profile ──────────────────────────────────────────────────────────────────

function ProfileSection() {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);
  const [name, setName] = useState(settings.owner_name || settings.user_name || '');
  const [location, setLocation] = useState(settings.location || '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      // The same writer first launch uses, so "where Henry keeps a name" has
      // one answer. Settings edits an existing profile, so it writes the
      // settings rows only — saving twice must not pile up duplicate memories.
      const saved = await saveUserProfile({ name, location }, { source: 'settings', remember: false });
      if (saved.failures.length > 0) throw new Error(saved.failures.join('; '));

      // An empty box here is a deliberate edit of a profile that already
      // exists, so it clears. In first launch the same empty box means "I did
      // not say", and `saveUserProfile` leaves it alone.
      const pairs: Array<[string, string]> = [
        ['owner_name', name.trim()],
        ['user_name', name.trim()],
        ['location', location.trim()],
      ];
      for (const [key, value] of pairs) {
        if (!value) await window.henryAPI.saveSetting?.(key, '');
        updateSetting(key, value);
      }
      toast.success('Profile saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save profile');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cardCls}>
      <SectionHeader title="Profile" sub="Henry uses these for memory and local context like weather." />
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Your name</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Topher" />
        </div>
        <div>
          <label className={labelCls}>Location</label>
          <input className={inputCls} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Portland, OR" />
        </div>
        <button className={btnCls} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
      </div>
    </div>
  );
}

// ── AI Providers (API keys) ──────────────────────────────────────────────────

function ProviderKeyRow({ providerId }: { providerId: (typeof CLOUD_PROVIDER_IDS)[number] }) {
  const meta = PROVIDERS[providerId];
  const providers = useStore((s) => s.providers);
  const setProviders = useStore((s) => s.setProviders);
  const existing = providers.find((p) => p.id === providerId);
  const hasKey = Boolean(existing?.apiKey);

  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const key = value.trim();
    if (!key) return;
    setBusy(true);
    try {
      const models = AVAILABLE_MODELS.filter((m) => m.provider === providerId).map((m) => m.id);
      await window.henryAPI.saveProvider?.({
        id: providerId,
        name: meta.name,
        apiKey: key,
        enabled: true,
        models: JSON.stringify(models),
      });
      await refreshProviders(setProviders);
      setValue('');
      toast.success(`${meta.name} key saved`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save key');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-henry-border/20 last:border-0">
      <span className="text-lg leading-none mt-0.5" aria-hidden>{meta.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-henry-text">{meta.name}</span>
          {hasKey ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">key set</span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-henry-border/30 text-henry-text-muted">no key</span>
          )}
        </div>
        <div className="flex gap-2 mt-1.5">
          <input
            type="password"
            className={inputCls + ' flex-1'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={hasKey ? 'Enter a new key to replace…' : `${meta.keyPrefix ?? ''}…`}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
          />
          <button className={btnCls} onClick={save} disabled={busy || !value.trim()}>
            {busy ? 'Saving…' : hasKey ? 'Replace' : 'Save'}
          </button>
        </div>
        {meta.keyUrl && (
          <a
            href={meta.keyUrl}
            onClick={(e) => { e.preventDefault(); window.henryAPI.computerOpenUrl?.(meta.keyUrl); }}
            className="text-[10px] text-henry-text-muted hover:text-henry-accent mt-1 inline-block"
          >
            Get a {meta.name} key →
          </a>
        )}
      </div>
    </div>
  );
}

function ProvidersSection() {
  return (
    <div className={cardCls}>
      <SectionHeader title="AI Providers" sub="Keys are stored locally on this device. Add at least one to use Henry." />
      <div>
        {CLOUD_PROVIDER_IDS.map((id) => <ProviderKeyRow key={id} providerId={id} />)}
      </div>
    </div>
  );
}

// ── Engine assignment ────────────────────────────────────────────────────────

// Exported for the picker seam test: this is the only model picker in the app,
// and it is mounted in isolation rather than through the whole settings shell so
// a test exercises the select itself rather than unrelated panels.
export function EngineRow({ engine, label, hint }: { engine: 'companion' | 'worker'; label: string; hint: string }) {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);
  const providers = useStore((s) => s.providers);
  const setProviders = useStore((s) => s.setProviders);
  const configuredIds = new Set(providers.filter((p) => p.apiKey || p.id === 'ollama').map((p) => p.id));

  const currentProvider = settings[`${engine}_provider`] || '';
  const currentModel = settings[`${engine}_model`] || '';

  // Only offer models from providers that actually have a key (plus Ollama).
  const baseModels = AVAILABLE_MODELS.filter(
    (m) => configuredIds.size === 0 || configuredIds.has(m.provider),
  );

  // opencode models are discovered at runtime and shown in this same list, so
  // they sit alongside every other model rather than behind a separate picker.
  // opencode is listed whenever its CLI is present — it needs no API key of its
  // own, so it is not gated on `configuredIds`.
  const [opencodeModels, setOpencodeModels] = useState<import('../../types').OpencodeModelInfo[]>([]);
  const [opencodeReady, setOpencodeReady] = useState(false);
  const [testingModel, setTestingModel] = useState<string | null>(null);

  // Proves the model is actually reachable before committing to it, since
  // opencode models come and go and some are served by overloaded providers.
  const testOpencode = async (modelId: string) => {
    setTestingModel(modelId);
    try {
      const r = await window.henryAPI.opencodeTest?.(modelId);
      if (r?.ok) toast.success(`${modelId} → ${(r.reply || '').trim().slice(0, 40) || 'ok'}`);
      else toast.error(`${modelId}: ${r?.error ?? 'no response'}`);
    } finally {
      setTestingModel(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const st = await window.henryAPI.opencodeStatus?.();
        if (cancelled) return;
        setOpencodeReady(!!st?.available);
        if (!st?.available) return;
        const res = await window.henryAPI.opencodeModels?.();
        if (!cancelled && res?.ok) setOpencodeModels(res.models);
      } catch { /* opencode is optional */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Local models, discovered from the running runtime ─────────────────────
  //
  // There used to be a hand-written list of local models here and a separate
  // fetch whose result was thrown away except for the names. Both are gone:
  // the runtime is asked what it holds, and what it says — id, capabilities,
  // context length — is what is shown and what is persisted.
  const [localModels, setLocalModels] = useState<LocalModelInfo[]>([]);
  const [localCatalog, setLocalCatalog] = useState<LocalCatalogState>({ kind: 'ok' });
  const localBaseUrl = settings.ollama_base_url || 'http://localhost:11434';

  // Always asked, never gated on an API key: Ollama is an unauthenticated
  // local server, so a user with no provider rows configured at all still sees
  // the models sitting on their own disk.
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
        if (cancelled) return;
        setLocalModels([]);
        setLocalCatalog({
          kind: 'unreachable',
          message: err instanceof Error ? err.message : 'Could not reach Ollama',
        });
      }
    })();
    return () => { cancelled = true; };
  }, [localBaseUrl]);

  const localById = new Map(localModels.map((m) => [m.id, m]));

  // A discovered model keeps the provider id it actually belongs to. Zen is a
  // distinct provider to the user — its own key, its own catalogue, its own
  // entry in the AI Providers panel — so stamping every discovered model
  // `opencode` here is what made all 108 Zen models render under the plain
  // OpenCode label and persist as the wrong provider.
  const opencodeAsModels = useMemo(
    () =>
      opencodeModels.map((m) => ({
        id: m.id,
        name: m.name,
        provider: opencodeProviderIdForModel(m),
        contextWindow: 0,
        inputPricePer1M: null,
        outputPricePer1M: null,
        description: m.isZen ? 'opencode zen' : m.provider,
      })),
    [opencodeModels],
  );

  // Order: what the user's own machine holds (free, offline, already here),
  // then opencode Zen (free, no key), then the rest of opencode, then the
  // statically-known cloud providers. Every one of these lists is the runtime's
  // or the user's, never a set of names somebody typed out in advance.
  const localAsModels = useMemo(() => localModelsToAIModels(localModels), [localModels]);
  const zenModels = opencodeAsModels.filter((m) => m.provider === OPENCODE_ZEN_PROVIDER_ID);
  const otherOpencodeModels = opencodeAsModels.filter((m) => m.provider !== OPENCODE_ZEN_PROVIDER_ID);
  // De-dupe by id: a discovered local tag and a cloud id can share a string,
  // which would render two <option>s with the same value.
  const seenModelIds = new Set<string>();
  const models = [
    ...localAsModels,
    ...(opencodeReady ? [...zenModels, ...otherOpencodeModels] : []),
    ...baseModels,
  ].filter((m) => {
    if (seenModelIds.has(m.id)) return false;
    seenModelIds.add(m.id);
    return true;
  });


  const onPick = async (modelId: string) => {
    // opencode models are dynamic, so they are not in AVAILABLE_MODELS. They
    // are matched by ID, which can collide with the static `openrouter/...`
    // entries — so prefer the static entry when the id exists in both, since
    // that one has a real API key path.
    const discovered = opencodeModels.find((o) => o.id === modelId);
    const isOpencodePick = discovered != null && !AVAILABLE_MODELS.some((m) => m.id === modelId);

    if (isOpencodePick) {
      // The model decides its own provider, not the other way round. A Zen model
      // persists as `opencode-zen`; hardcoding `opencode` here was the second
      // place Zen identity was destroyed, and it is the one that survives a
      // restart — so it is the reason a previously-working Zen selection came
      // back as a plain OpenCode model.
      const providerId = opencodeProviderIdForModel(discovered);
      const isZen = providerId === OPENCODE_ZEN_PROVIDER_ID;
      // A provider row is REQUIRED, not optional: consumers resolve the engine
      // with `providers.find(p => p.id === <provider>)`, so saving the setting
      // alone left every chat surface reporting "No model configured".
      //
      // An existing Zen key is carried across rather than blanked: re-saving
      // the row with an empty key would silently downgrade the catalogue to the
      // unauthenticated subset every time a Zen model was picked.
      const existingKey = providers.find((p) => p.id === providerId)?.apiKey ?? '';
      const modelsForProvider = opencodeModels
        .filter((o) => opencodeProviderIdForModel(o) === providerId)
        .map((o) => o.id);
      await window.henryAPI.saveProvider?.({
        id: providerId,
        name: isZen ? 'OpenCode Zen' : 'OpenCode (CLI)',
        apiKey: existingKey,
        enabled: true,
        models: JSON.stringify(modelsForProvider),
      });
      await refreshProviders(setProviders);
      await window.henryAPI.saveSetting?.(`${engine}_provider`, providerId);
      await window.henryAPI.saveSetting?.(`${engine}_model`, modelId);
      updateSetting(`${engine}_provider`, providerId);
      updateSetting(`${engine}_model`, modelId);
      toast.success(`Engine → ${modelId}`);
      return;
    }
    // A discovered local model is, by construction, already installed — it came
    // from the runtime's own inventory. There is nothing to pull, and no fuzzy
    // `startsWith` matching against a list of names that may not be installed.
    const local = localById.get(modelId);
    if (local) {
      if (local.loadable === false) {
        toast.error(local.warning ?? `${local.id} cannot be loaded by Ollama.`);
        return;
      }
      try {
        // The provider row is required: consumers resolve the engine with
        // `providers.find(p => p.id === <provider>)`. `apiKey: ''` is correct
        // and deliberate — Ollama has no account and reads no credential.
        await window.henryAPI.saveProvider?.({
          id: OLLAMA_PROVIDER_ID,
          name: 'Ollama (Local)',
          apiKey: '',
          enabled: true,
          models: JSON.stringify(localModels.map((m) => m.id)),
        });
        await refreshProviders(setProviders);
        await window.henryAPI.saveSetting?.(`${engine}_provider`, OLLAMA_PROVIDER_ID);
        await window.henryAPI.saveSetting?.(`${engine}_model`, local.id);
        updateSetting(`${engine}_provider`, OLLAMA_PROVIDER_ID);
        updateSetting(`${engine}_model`, local.id);
        toast.success(`${label} → ${local.displayName}`);
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : 'Could not set engine');
      }
      return;
    }

    const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (!model) return;

    try {
      await window.henryAPI.saveSetting?.(`${engine}_provider`, model.provider);
      await window.henryAPI.saveSetting?.(`${engine}_model`, model.id);
      updateSetting(`${engine}_provider`, model.provider);
      updateSetting(`${engine}_model`, model.id);

      toast.success(`${label} → ${model.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not set engine');
    }
  };

  return (
    <div className="py-2.5 border-b border-henry-border/20 last:border-0">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-henry-text">{label}</span>
        <span className="text-[10px] text-henry-text-muted">{currentProvider || 'unset'}</span>
      </div>
      <p className="text-[11px] text-henry-text-muted mb-1.5">{hint}</p>
      <select className={inputCls} value={currentModel} onChange={(e) => onPick(e.target.value)}>
        <option value="" disabled>Choose a model…</option>
        {models.map((m) => {
          // A local model's label comes from what the runtime reported, so the
          // row shows the capability set the user will actually get rather than
          // one a former static table guessed.
          const local = localById.get(m.id);
          return (
            <option
              key={`${m.provider}:${m.id}`}
              value={m.id}
              disabled={local?.loadable === false}
            >
              {local
                ? localModelLabel(local)
                : `${(PROVIDERS as Record<string, { name?: string }>)[m.provider]?.name ?? m.provider} — ${m.name}` +
                  (m.inputPricePer1M != null ? ` (${formatPrice(m.inputPricePer1M)}/1M in)` : '')}
            </option>
          );
        })}
      </select>
      {localCatalog.message && (
        <p
          className={
            localCatalog.kind === 'degraded'
              ? 'mt-1.5 text-[11px] text-henry-text-muted'
              : 'mt-1.5 text-[11px] text-henry-accent'
          }
        >
          Local models: {localCatalog.message}
        </p>
      )}
      {opencodeModels.some((o) => o.id === currentModel) && (
        <button
          onClick={() => void testOpencode(currentModel)}
          disabled={testingModel != null}
          className="mt-1.5 px-2.5 py-1 rounded-lg text-[11px] border border-henry-border/40 text-henry-text hover:border-henry-accent/50 disabled:opacity-40"
        >
          {testingModel === currentModel ? 'Testing…' : 'Test this model'}
        </button>
      )}
    </div>
  );
}

function EnginesSection() {
  return (
    <div className={cardCls}>
      <SectionHeader
        title="Engines"
        sub="Companion is the chat brain you talk to. Worker runs background tasks and Routines."
      />
      <div>
        <EngineRow engine="companion" label="Companion engine" hint="Used for live conversation in Chat." />
        <EngineRow engine="worker" label="Worker engine" hint="Used for tasks, the queue, and scheduled Routines." />
      </div>
      <RelayRow />
    </div>
  );
}

/**
 * Optional hosted relay. Off until a URL is set — Henry runs entirely on your
 * own providers or local Ollama by default, and nothing here is required.
 */
function RelayRow() {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);
  const [url, setUrl] = useState(settings.relay_base_url || '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const value = url.trim();
    if (value && !/^https?:\/\//i.test(value)) {
      toast.error('Relay URL must start with http:// or https://');
      return;
    }
    setBusy(true);
    try {
      await window.henryAPI.saveSetting?.('relay_base_url', value);
      updateSetting('relay_base_url', value);
      toast.success(value ? 'Hosted relay enabled' : 'Hosted relay disabled');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the relay URL');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 p-3 rounded-xl border border-henry-border/25 bg-henry-surface/30">
      <p className="text-xs font-semibold text-henry-text">Hosted relay (optional)</p>
      <p className="text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">
        Route requests through any OpenAI-compatible endpoint you control — a self-hosted
        gateway, a corporate proxy, or a service you already pay for. Leave blank to stay
        entirely on your own keys and local Ollama.
      </p>
      <div className="flex items-center gap-2 mt-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-relay.example.com/v1"
          spellCheck={false}
          className="flex-1 bg-henry-bg border border-henry-border/30 rounded-lg px-2.5 py-1.5 text-xs text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50"
        />
        <button
          onClick={() => void save()}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ── Coder Engine ─────────────────────────────────────────────────────────────

function CoderEngineSection() {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);
  const [status, setStatus] = useState<HenryCoderStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const choice: CoderEngineChoice = isCoderEngineChoice(settings[CODER_ENGINE_SETTING_KEY])
    ? (settings[CODER_ENGINE_SETTING_KEY] as CoderEngineChoice)
    : 'auto';

  const refresh = async (force = false) => {
    setChecking(true);
    try {
      setStatus(await getCoderStatus(force));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (coderAvailable()) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!coderAvailable()) return null;

  const pick = async (value: string) => {
    if (!isCoderEngineChoice(value)) return;
    try {
      await window.henryAPI.saveSetting?.(CODER_ENGINE_SETTING_KEY, value);
      updateSetting(CODER_ENGINE_SETTING_KEY, value);
      toast.success(`Coder engine → ${CODER_ENGINE_LABELS[value]}`);
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not set coder engine');
    }
  };

  return (
    <div className={cardCls}>
      <SectionHeader
        title="Coder Engine"
        sub="Code mode in chat writes code with the Claude Code CLI, opencode, or a free local model via Ollama."
      />
      <div className="space-y-3">
        <select className={inputCls} value={choice} onChange={(e) => void pick(e.target.value)}>
          <option value="auto">Auto — Claude Code, then opencode, else local (recommended)</option>
          <option value="claude-code">Claude Code CLI only</option>
          <option value="opencode">opencode only</option>
          <option value="local">Local only — free qwen coder via Ollama</option>
        </select>

        <div className="text-[11px] text-henry-text-muted space-y-1">
          <div>
            opencode:{' '}
            {status?.opencode?.available ? (
              <span className="text-emerald-400">detected — {status.opencode.version ?? 'installed'}</span>
            ) : (
              <span>
                not found — install from{' '}
                <span className="text-henry-text-dim">opencode.ai</span>
              </span>
            )}
          </div>
          <div>
            Claude Code CLI:{' '}
            {status?.claude.available ? (
              <span className="text-emerald-400">detected — {status.claude.version ?? 'installed'}</span>
            ) : (
              <span>
                not found — install with{' '}
                <span className="text-henry-text-dim">npm install -g @anthropic-ai/claude-code</span>
              </span>
            )}
          </div>
          <div>
            Local coder:{' '}
            {status?.local.model ? (
              <span className="text-emerald-400">{status.local.model} installed</span>
            ) : status?.local.ollamaRunning ? (
              <span>model missing — {status.local.hint ?? 'run: ollama pull qwen2.5-coder:7b'}</span>
            ) : (
              <span>{status?.local.hint ?? 'Ollama not running'}</span>
            )}
          </div>
          {status && (
            <div>
              Active now:{' '}
              <span className="text-henry-text-dim">
                {status.active === 'none' ? 'no engine available' : status.active === 'claude-code' ? 'Claude Code' : `Local (${status.local.model})`}
              </span>
              {' · '}Auto-applied edits are limited to{' '}
              <span className="text-henry-text-dim">~/HenryAI/coder-projects</span>
            </div>
          )}
        </div>

        <button className={btnCls} onClick={() => void refresh(true)} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>
    </div>
  );
}

// ── Voice ────────────────────────────────────────────────────────────────────

function VoiceSection() {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);
  const setProviders = useStore((s) => s.setProviders);

  const [endpoint, setEndpointState] = useState<EndpointingSettings>(getEndpointingSettings());
  const setEndpoint = async (next: EndpointingSettings) => {
    setEndpointState(next);
    await saveEndpointingSettings(next);
  };
  const [stt, setStt] = useState<HenryVoiceSttStatus | null>(null);
  const [tts, setTts] = useState<HenryVoiceTtsStatus | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupProgress, setSetupProgress] = useState<HenryVoiceSetupProgress | null>(null);
  const [elevenKey, setElevenKey] = useState('');
  const [elevenBusy, setElevenBusy] = useState(false);
  const [speakBusy, setSpeakBusy] = useState(false);
  const [listenTest, setListenTest] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [listenResult, setListenResult] = useState<string | null>(null);
  // The stored value is the truth; the draft is what the input is editing.
  // `useEffect` re-syncs it when the setting changes elsewhere, so a save
  // made in another panel is not silently clobbered by a stale draft.
  const [assistantNameDraft, setAssistantNameDraft] = useState(assistantNameFrom(settings));
  useEffect(() => setAssistantNameDraft(assistantNameFrom(settings)), [settings]);

  /**
   * Persist the assistant's own name, then drop the cached greeting audio.
   * The cache is content-addressed on the rendered text, so a new name already
   * misses — but clearing keeps a rename from leaving yesterday's voice on disk
   * for the variants it no longer applies to.
   */
  const commitAssistantName = async () => {
    const next = normalizeAssistantName(assistantNameDraft);
    if (next === assistantNameFrom(settings)) {
      setAssistantNameDraft(next);
      return;
    }
    setAssistantNameDraft(next);
    await saveVoiceSetting(ASSISTANT_NAME_SETTING_KEY, next);
    await window.henryAPI.voiceGreetingClearCache?.();
  };

  const refresh = async (refreshBinary = false) => {
    const [s, t] = await Promise.all([getVoiceSttStatus(refreshBinary), getVoiceTtsStatus()]);
    setStt(s);
    setTts(t);
  };

  useEffect(() => {
    if (voiceIpcAvailable()) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!voiceIpcAvailable()) return null;

  const saveVoiceSetting = async (key: string, value: string) => {
    try {
      await window.henryAPI.saveSetting?.(key, value);
      updateSetting(key, value);
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const runSetup = async () => {
    setSetupBusy(true);
    try {
      await runVoiceSetup((p) => setSetupProgress(p));
      toast.success('Free voice is ready');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Voice setup failed');
    } finally {
      setSetupBusy(false);
      setSetupProgress(null);
      void refresh(true);
    }
  };

  const greetingOn = settings.voice_greeting === 'on';

  const toggleGreeting = async () => {
    const next = greetingOn ? 'off' : 'on';
    await saveVoiceSetting('voice_greeting', next);
    if (!greetingOn) await window.henryAPI.voiceGreetingClearCache?.();
  };

  const saveElevenKey = async () => {
    const key = elevenKey.trim();
    if (!key) return;
    setElevenBusy(true);
    try {
      // Stored exactly like every other provider key (encrypted at rest).
      await window.henryAPI.saveProvider?.({
        id: 'elevenlabs',
        name: 'ElevenLabs',
        apiKey: key,
        enabled: true,
        models: '[]',
      });
      await refreshProviders(setProviders);
      setElevenKey('');
      toast.success('ElevenLabs key saved — Henry will use it for his speaking voice');
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save key');
    } finally {
      setElevenBusy(false);
    }
  };

  const testSpeaking = async () => {
    setSpeakBusy(true);
    try {
      // Self-identifying, so it follows the configured name rather than a
      // literal — this is the voice panel claiming to be the voice.
      await voiceSpeak(`Hi, it's ${assistantNameFrom(settings)}. This is how I sound.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Speaking test failed');
    } finally {
      setSpeakBusy(false);
    }
  };

  const testListening = async () => {
    if (listenTest === 'recording') {
      setListenTest('transcribing');
      try {
        const blob = await stopVoiceRecording();
        if (!blob) {
          setListenResult('No audio captured — try speaking a bit longer.');
        } else {
          const text = await transcribeLocal(blob);
          setListenResult(text ? `Heard: “${text}”` : 'Heard silence — try again closer to the mic.');
        }
      } catch (e) {
        setListenResult(e instanceof Error ? e.message : String(e));
      } finally {
        setListenTest('idle');
      }
      return;
    }
    setListenResult(null);
    try {
      await startVoiceRecording();
      setListenTest('recording');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Microphone unavailable');
    }
  };

  const englishVoices = (tts?.sayVoices ?? []).filter((v) => v.lang.toLowerCase().startsWith('en'));
  const engine = settings.voice_tts_engine === 'local' || settings.voice_tts_engine === 'elevenlabs'
    ? settings.voice_tts_engine
    : 'auto';

  return (
    <div className={cardCls}>
      <SectionHeader
        title="Voice"
        sub={voiceSubtitle()}
      />
      <div className="space-y-4">
        {/* ── Assistant identity ── */}
        <div>
          <label className={labelCls}>Assistant name</label>
          <input
            className={inputCls}
            value={assistantNameDraft}
            onChange={(e) => setAssistantNameDraft(e.target.value)}
            onBlur={() => void commitAssistantName()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitAssistantName();
            }}
            maxLength={MAX_ASSISTANT_NAME_LENGTH}
            placeholder={DEFAULT_ASSISTANT_NAME}
          />
          <p className="text-[10px] text-henry-text-muted mt-1">
            What the greeting calls itself, and the name the wake word listens for. Leave it blank
            to go back to {DEFAULT_ASSISTANT_NAME}.
          </p>
        </div>
        {/* ── Listening (STT) ── */}
        <div>
          <label className={labelCls}>Listening (speech-to-text)</label>
          <div className="text-[11px] text-henry-text-muted space-y-1">
            <div>
              Whisper engine:{' '}
              {stt?.binaryPresent ? (
                <span className="text-emerald-400">installed ({stt.binaryPath})</span>
              ) : (
                <span>not installed</span>
              )}
            </div>
            <div>
              Speech model (base.en, ~148MB):{' '}
              {stt?.modelPresent ? (
                <span className="text-emerald-400">downloaded</span>
              ) : (
                <span>not downloaded</span>
              )}
            </div>
          </div>
          {setupBusy && (
            <div className="mt-2">
              <div className="h-1.5 rounded-full bg-henry-border/40 overflow-hidden">
                <div className="h-full bg-henry-accent transition-all" style={{ width: `${setupProgress?.pct ?? 5}%` }} />
              </div>
              <p className="text-[10px] text-henry-text-muted mt-1">{setupProgress?.message ?? 'Preparing…'}</p>
            </div>
          )}
          <div className="flex gap-2 mt-2">
            {!stt?.ready && (
              <button className={btnCls} onClick={() => void runSetup()} disabled={setupBusy}>
                {setupBusy ? 'Setting up…' : 'Set up free voice (~150MB, one-time)'}
              </button>
            )}
            <button className={btnCls} onClick={() => void refresh(true)}>Re-check</button>
            <button className={btnCls} onClick={() => void testListening()} disabled={!stt?.ready || listenTest === 'transcribing'}>
              {listenTest === 'recording' ? 'Stop + transcribe' : listenTest === 'transcribing' ? 'Transcribing…' : 'Test listening'}
            </button>
          </div>
          {listenResult && <p className="text-[11px] text-henry-text-dim mt-1.5">{listenResult}</p>}
        </div>

        {/* ── Hands-free endpointing ── */}
        <div className="border-t border-henry-border/20 pt-3">
          <label className={labelCls}>Hands-free ending</label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-henry-text">
              <input
                type="checkbox"
                checked={endpoint.enabled}
                onChange={(e) => void setEndpoint({ ...endpoint, enabled: e.target.checked })}
              />
              Stop recording when you stop talking
            </label>
            {endpoint.enabled && (
              <>
                <label className="block text-[11px] text-henry-text-muted">
                  Ends after {endpoint.silenceMs}ms of quiet
                  <input
                    type="range"
                    min={400}
                    max={5000}
                    step={100}
                    value={endpoint.silenceMs}
                    onChange={(e) => void setEndpoint({ ...endpoint, silenceMs: Number(e.target.value) })}
                    className="w-full mt-1"
                  />
                </label>
                <label className="block text-[11px] text-henry-text-muted">
                  Microphone sensitivity — {Math.round(endpoint.sensitivity * 100)}%
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={endpoint.sensitivity}
                    onChange={(e) => void setEndpoint({ ...endpoint, sensitivity: Number(e.target.value) })}
                    className="w-full mt-1"
                  />
                </label>
                <p className="text-[10px] text-henry-text-muted">
                  Raise this in a noisy room; lower it if Henry cuts you off while you are still
                  thinking.
                </p>
              </>
            )}
          </div>
        </div>

        {/* ── Speaking (TTS) ── */}
        <div className="border-t border-henry-border/20 pt-3">
          <label className={labelCls}>Speaking voice</label>
          <select
            className={inputCls}
            value={engine}
            onChange={(e) => void saveVoiceSetting('voice_tts_engine', e.target.value)}
          >
            <option value="auto">Auto — ElevenLabs when a key is saved, else the free local voice</option>
            <option value="local">Local only — free local voice (offline)</option>
            <option value="elevenlabs">ElevenLabs only</option>
          </select>
          <p className="text-[10px] text-henry-text-muted mt-1">
            Active now:{' '}
            <span className="text-henry-text-dim">
              {tts?.active === 'elevenlabs' ? 'ElevenLabs' : 'Free local voice'}
            </span>
            {tts && !tts.elevenLabsKeyPresent && ' · no ElevenLabs key saved'}
          </p>

          <div className="grid grid-cols-2 gap-2 mt-2">
            <div>
              <label className={labelCls}>Local voice</label>
              <select
                className={inputCls}
                value={settings.voice_say_voice || tts?.sayVoice || 'Samantha'}
                onChange={(e) => void saveVoiceSetting('voice_say_voice', e.target.value)}
              >
                {englishVoices.length === 0 && <option value="Samantha">Samantha</option>}
                {englishVoices.map((v) => (
                  <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Rate (words/min)</label>
              <input
                type="number"
                min={90}
                max={400}
                className={inputCls}
                value={settings.voice_say_rate || String(tts?.sayRate ?? 175)}
                onChange={(e) => void saveVoiceSetting('voice_say_rate', e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-2 mt-2">
            <button className={btnCls} onClick={() => void testSpeaking()} disabled={speakBusy}>
              {speakBusy ? 'Speaking…' : 'Test speaking'}
            </button>
            <button className={btnCls} onClick={() => void voiceStopSpeaking()}>Stop</button>
            <button
              className={btnCls + (greetingOn ? ' text-henry-accent border-henry-accent/50' : '')}
              onClick={() => void toggleGreeting()}
              title="Speak a short greeting when Henry starts. Audio is generated once and cached."
            >
              {greetingOn ? '✓ Greeting on' : 'Greeting off'}
            </button>
          </div>
        </div>

        {/* ── ElevenLabs ── */}
        <div className="border-t border-henry-border/20 pt-3">
          <div className="flex items-center gap-2">
            <label className={labelCls + ' mb-0'}>ElevenLabs (optional — premium voice)</label>
            {tts?.elevenLabsKeyPresent ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">key set</span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-henry-border/30 text-henry-text-muted">no key</span>
            )}
          </div>
          <div className="flex gap-2 mt-1.5">
            <input
              type="password"
              className={inputCls + ' flex-1'}
              value={elevenKey}
              onChange={(e) => setElevenKey(e.target.value)}
              placeholder={tts?.elevenLabsKeyPresent ? 'Enter a new key to replace…' : 'xi-…'}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveElevenKey(); }}
            />
            <button className={btnCls} onClick={() => void saveElevenKey()} disabled={elevenBusy || !elevenKey.trim()}>
              {elevenBusy ? 'Saving…' : tts?.elevenLabsKeyPresent ? 'Replace' : 'Save'}
            </button>
          </div>
          <div className="mt-2">
            <label className={labelCls}>ElevenLabs voice ID</label>
            <input
              className={inputCls}
              value={settings.voice_tts_voice || tts?.elevenVoiceId || '21m00Tcm4TlvDq8ikWAM'}
              onChange={(e) => void saveVoiceSetting('voice_tts_voice', e.target.value)}
              placeholder="21m00Tcm4TlvDq8ikWAM (Rachel)"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
// ── Quit ─────────────────────────────────────────────────────────────────────

/**
 * In-app quit (row 11.13).
 *
 * `quitApp` refuses while a Routine or task is in flight and returns the list,
 * so the first click tells the user what would be interrupted rather than
 * silently dropping it. The second, visually distinct button is the only thing
 * that forces the quit — abandoning work should never be the path of least
 * resistance.
 */
function QuitSection() {
  const [activeWork, setActiveWork] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [quitting, setQuitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await window.henryAPI.appActiveWork();
        if (!cancelled) setActiveWork(r.activeWork);
      } catch {
        // Not being able to ask is not a reason to hide the button — the main
        // process still refuses the quit if work IS running.
      }
    };
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    // The main process sends this just before tearing down, so the user sees
    // why the window is about to go away rather than watching it hang.
    return window.henryAPI.onAppQuitting(() => setQuitting(true));
  }, []);

  const quit = async (force: boolean) => {
    try {
      const res = await window.henryAPI.quitApp(force ? { force: true } : {});
      if (res.needsConfirmation) {
        setActiveWork(res.activeWork ?? []);
        setConfirming(true);
        return;
      }
      if (!res.ok) toast.error(res.error ?? 'Could not quit');
      else setQuitting(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not quit');
    }
  };

  const dangerBtn =
    'px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-40';

  return (
    <div className={cardCls}>
      <SectionHeader
        title="Quit Henry"
        sub="Closes the app cleanly: stops Routines, closes machine connections, and flushes the database before exiting."
      />

      {activeWork.length > 0 && (
        <div className="mb-3 text-[11px] text-amber-400 leading-relaxed">
          Still running: {activeWork.join(', ')}
        </div>
      )}

      {confirming && activeWork.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[11px] text-henry-text-muted leading-relaxed">
            Quitting now abandons the work above. It cannot be resumed.
          </p>
          <div className="flex gap-2">
            <button className={btnCls} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className={dangerBtn} onClick={() => void quit(true)}>
              Quit anyway
            </button>
          </div>
        </div>
      ) : (
        <button className={dangerBtn} onClick={() => void quit(false)} disabled={quitting}>
          {quitting ? 'Quitting…' : 'Quit Henry'}
        </button>
      )}
    </div>
  );
}

/**
 * A ONE-TIME pointer to the silent-tool setting, shown next to System health.
 *
 * Deliberately once: the dismissal is recorded in localStorage, so this can
 * never become the nagging banner pattern. It exists because the default here
 * is permissive and a user should meet that fact once without hunting for it.
 */
function SilentToolsNotice() {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem('henry:security-notice-dismissed') === '1');
    } catch {
      // Storage unavailable (private mode / web mock) — show it rather than
      // hiding a security-relevant default behind a failure to read a flag.
      setDismissed(false);
    }
  }, []);

  if (dismissed !== false) return null;

  return (
    <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
<div className="text-sm text-henry-text">Some tools run without asking</div>
 <p className="text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">
   By default a group of tools Henry considers low-risk run silently, so you are not asked
   to approve ordinary work. If you would rather approve every one, Security has a switch
   for it.
          </p>
        </div>
  <button
   className="px-3 py-1.5 rounded-lg text-xs font-medium text-henry-text-muted hover:text-henry-text shrink-0"
  onClick={() => {
        try {
            window.localStorage.setItem('henry:security-notice-dismissed', '1');
     } catch { /* nothing to do */ }
    setDismissed(true);
       }}
      >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function SettingsView() {
  return (
    <>
      {/*
        The app lock has to be enforced in the UI somewhere reachable while
        `main.ts` refuses every non-exempt channel. Settings is where the lock
        is configured, so it is also where the user comes looking for it.

        NOTE FOR MAIN: this must also be mounted in `src/App.tsx` at the app
        root. Settings is one tab — a lock taken while the user is on Chat
        leaves every panel dead until they navigate here. See the handover.
      */}
      <AppLockGate />
      <div className="h-full overflow-y-auto bg-henry-bg">
      <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-henry-text">Settings</h1>
          <p className="text-xs text-henry-text-muted mt-1">
            Profile, AI providers, engine assignment, pairing, and system health.
          </p>
        </div>

        <ProfileSection />
        <ProvidersSection />
        <EnginesSection />
        <CoderEngineSection />
        <VoiceSection />

        <div className={cardCls}>
          <SectionHeader title="Companion device" sub="Pair and control Henry from your phone." />
        </div>

        <div className="mt-4">
          <GoogleConnectionPanel />
        </div>

        <div>
          <div className="space-y-5">
            <RemoteControlPanel />
            <DeviceLinkPanel />
          </div>
        </div>

 <div className={cardCls}>
      <SectionHeader title="System health" />
          <HealthPanel />
     </div>

        <SilentToolsNotice />

        <div className={cardCls}>
          <SectionHeader
            title="Security"
            sub="Confirmations, network access, and the app lock. These change what Henry is allowed to do, not just how it looks."
          />
        <SecurityPanel />
        </div>

 <div className={cardCls}>
          <SectionHeader title="Privacy" sub="What Henry stores on this machine, and what it sends." />
  <PrivacyPanel />
     </div>

    <div className={cardCls}>
          <SectionHeader title="Logs & debug" />
          <LogsPanel />
     </div>

        <QuitSection />
      </div>
      </div>
    </>
  );
}
