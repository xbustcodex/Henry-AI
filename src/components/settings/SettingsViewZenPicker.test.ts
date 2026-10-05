// @vitest-environment jsdom
/**
 * The model picker — Defect B's real hop.
 *
 * An earlier acceptance pass counted Zen models from the discovery endpoint and
 * reported success. Discovery was never the problem: the installed build listed
 * 108 Zen models, correctly flagged `isZen`, in the correct group.
 *
 * The picker was. Every discovered model was stamped `provider: 'opencode'`, so
 * `PROVIDERS['opencode-zen']` was unreachable, every Zen row rendered under the
 * plain "OpenCode" label, and picking one wrote the literal `'opencode'` into
 * `companion_provider` / `worker_provider` — so nothing downstream could ever
 * tell a Zen model from any other opencode model again.
 *
 * This mounts the real component against a real store, reads the real `<option>`
 * list the user sees, selects a real Zen model, and asserts what actually got
 * persisted. A count from discovery would pass against every one of those bugs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { EngineRow } from './SettingsView';
import { useStore } from '../../store';
import type { OpencodeModelInfo } from '../../types';
import { OPENCODE_PROVIDER_ID, OPENCODE_ZEN_PROVIDER_ID } from '../../../electron/providers/classification';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What discovery actually returns, verbatim in shape: Zen ids carry NO slash,
 * so `provider` is only meaningful because the group resolves it. openrouter
 * entries carry a real `provider/` prefix.
 */
const DISCOVERED: OpencodeModelInfo[] = [
  { id: 'deepseek-v4-flash-free', provider: 'opencode-zen', name: 'deepseek-v4-flash-free', isZen: true, group: 'opencode-zen' },
  { id: 'hy3-free', provider: 'opencode-zen', name: 'hy3-free', isZen: true, group: 'opencode-zen' },
  { id: 'openrouter/qwen3-235b-a22b', provider: 'openrouter', name: 'qwen3-235b-a22b', isZen: false, group: 'openrouter' },
];

/** Every saveSetting call, in order, as `(key, value)`. */
let savedSettings: Array<[string, string]> = [];
/** Every saveProvider call, as the payload the main process would persist. */
let savedProviders: Array<{ id: string; name: string; apiKey: string; models: string }> = [];

beforeEach(() => {
  savedSettings = [];
  savedProviders = [];

  window.henryAPI = {
    opencodeStatus: async () => ({ available: true }),
    opencodeModels: async () => ({ ok: true, models: DISCOVERED }),
    saveSetting: async (key: string, value: string) => {
      savedSettings.push([key, value]);
      useStore.getState().updateSetting(key, value);
      return true;
    },
    saveProvider: async (p: { id: string; name: string; apiKey?: string; models: string }) => {
      savedProviders.push({ id: p.id, name: p.name, apiKey: p.apiKey ?? '', models: p.models });
      // Mirror the main process: the row becomes visible to the picker.
      const existing = useStore.getState().providers.find((x) => x.id === p.id);
      useStore.getState().setProviders(
        existing
          ? useStore.getState().providers.map((x) => (x.id === p.id ? { ...x, apiKey: p.apiKey ?? '' } : x))
          : [...useStore.getState().providers, { id: p.id, name: p.name, apiKey: p.apiKey ?? '', enabled: true, models: p.models } as never],
      );
      return { ok: true };
    },
    getProviders: async () => {
      const ps = useStore.getState().providers;
      return ps.map((p) => ({ ...p, api_key: p.apiKey }));
    },
  } as unknown as typeof window.henryAPI;

  useStore.setState({
    providers: [{ id: 'opencode-zen', name: 'OpenCode Zen', apiKey: 'zen-key-abc', enabled: true, models: '[]' } as never],
    settings: { companion_provider: '', companion_model: '' },
  });
});

afterEach(cleanup);

/** The engine select the user picks a model from. */
const engineSelect = () => screen.getByRole('combobox') as HTMLSelectElement;

describe('a Zen model is offered in the picker', () => {
  it('lists every discovered Zen model as a selectable option', async () => {
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/hy3-free/)).toBeTruthy());

    const options = Array.from(engineSelect().options).map((o) => o.value);
    for (const model of DISCOVERED.filter((m) => m.isZen)) {
      expect(options, `Zen model ${model.id} is missing from the picker`).toContain(model.id);
    }
  });

  it('lists ordinary opencode models alongside the Zen ones', async () => {
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/hy3-free/)).toBeTruthy());
    const options = Array.from(engineSelect().options).map((o) => o.value);
    expect(options).toContain('openrouter/qwen3-235b-a22b');
  });

  it('shows Zen under its own provider name, not under plain OpenCode', async () => {
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/hy3-free/)).toBeTruthy());

    const labels = Array.from(engineSelect().options).map((o) => o.textContent ?? '');
    const zenLabel = labels.find((l) => l.includes('hy3-free'));
    // Both classes of model were rendered as "OpenCode — …", which is why the
    // provider panel looked right while the catalogue looked like one undifferentiated list.
    expect(zenLabel).toContain('OpenCode Zen');
  });

  it('puts Zen ahead of the bulk catalogue', async () => {
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/hy3-free/)).toBeTruthy());
    const options = Array.from(engineSelect().options).map((o) => o.value);
    expect(options.indexOf('hy3-free')).toBeLessThan(options.indexOf('openrouter/qwen3-235b-a22b'));
  });
});

describe('selecting a Zen model persists it as a Zen model', () => {
  it('writes opencode-zen, not opencode, to the engine provider setting', async () => {
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/hy3-free/)).toBeTruthy());

    fireEvent.change(engineSelect(), { target: { value: 'hy3-free' } });

    await waitFor(() => {
      expect(savedSettings).toContainEqual(['companion_provider', OPENCODE_ZEN_PROVIDER_ID]);
    });
    expect(savedSettings).not.toContainEqual(['companion_provider', OPENCODE_PROVIDER_ID]);
  });

  it('persists the exact model id that was selected', async () => {
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/deepseek-v4-flash-free/)).toBeTruthy());

    fireEvent.change(engineSelect(), { target: { value: 'deepseek-v4-flash-free' } });

    await waitFor(() => expect(savedSettings).toContainEqual(['companion_model', 'deepseek-v4-flash-free']));
  });

  it('creates a provider row the engine can actually resolve', async () => {
    // Consumers do `providers.find(p => p.id === <provider>)`; saving only the
    // setting left every chat surface reporting "No model configured".
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/hy3-free/)).toBeTruthy());

    fireEvent.change(engineSelect(), { target: { value: 'hy3-free' } });

    await waitFor(() => expect(savedProviders.length).toBeGreaterThan(0));
    expect(savedProviders[0].id).toBe(OPENCODE_ZEN_PROVIDER_ID);
    expect(savedProviders[0].models).toContain('hy3-free');
  });

  it('does not blank a Zen key that was already saved', async () => {
    // The row is re-saved on every pick. Writing apiKey: '' there would silently
    // downgrade a configured user to the unauthenticated subset of the catalogue.
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/hy3-free/)).toBeTruthy());

    fireEvent.change(engineSelect(), { target: { value: 'hy3-free' } });

    await waitFor(() => expect(savedProviders.length).toBeGreaterThan(0));
    expect(savedProviders[0].apiKey).toBe('zen-key-abc');
  });

  it('keeps only the models that belong to the persisted provider', async () => {
    // A Zen row listing openrouter ids would resolve the wrong backend for them.
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/hy3-free/)).toBeTruthy());

    fireEvent.change(engineSelect(), { target: { value: 'hy3-free' } });

    await waitFor(() => expect(savedProviders.length).toBeGreaterThan(0));
    const models = JSON.parse(savedProviders[0].models) as string[];
    expect(models).toContain('hy3-free');
    expect(models).not.toContain('openrouter/qwen3-235b-a22b');
  });

  it('persists a non-Zen opencode model as opencode, not as Zen', async () => {
    // The opposite error: relabelling ordinary models as Zen would hand paid
    // Zen routing to a model the Zen credential does not cover.
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/qwen3-235b-a22b/)).toBeTruthy());

    fireEvent.change(engineSelect(), { target: { value: 'openrouter/qwen3-235b-a22b' } });

    await waitFor(() => expect(savedSettings).toContainEqual(['companion_provider', OPENCODE_PROVIDER_ID]));
    expect(savedSettings).not.toContainEqual(['companion_provider', OPENCODE_ZEN_PROVIDER_ID]);
  });
});

describe('the picker needs the opencode CLI, and says so when it is absent', () => {
  it('offers no opencode models when the CLI is not installed', async () => {
    window.henryAPI.opencodeStatus = async () => ({ available: false });
    render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));
    await waitFor(() => expect(screen.getByText(/Choose a model/)).toBeTruthy());
    const options = Array.from(engineSelect().options).map((o) => o.value);
    expect(options).not.toContain('hy3-free');
  });
});