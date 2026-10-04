// @vitest-environment jsdom
/**
 * The model picker — the local-model defect's real hop.
 *
 * Discovery was never the only half. An earlier acceptance pass counted models
 * from `/api/tags` and called it done while the picker was still rendering 19
 * hand-written entries: models the user had never pulled, with capabilities and
 * context windows nobody had verified, and none of the seven models actually on
 * this machine.
 *
 * So this mounts the real component, feeds it a mocked runtime, and reads the
 * real `<option>` list the user sees. The `dynamic inventory` block is the one
 * the campaign requires: it changes what the mocked runtime holds between two
 * renders and asserts the picker's options follow. A table cannot pass that.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { EngineRow } from './SettingsView';
import { useStore } from '../../store';
import type { LocalModelInfo } from '../../../electron/ipc/ollamaCapabilities';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the live Ollama on this machine reports, field for field. Used as a
 * fixture, never as an expectation about the future: the assertions below read
 * whatever the mock currently holds.
 */
function discovered(over: Partial<LocalModelInfo> & { id: string }): LocalModelInfo {
  const { id, ...rest } = over;
  return {
    provider: 'ollama',
    runtime: 'ollama',
    id,
    name: id,
    displayName: id,
    local: true,
    requiresApiKey: false,
    sizeBytes: 2_000_000_000,
    sizeGB: '2.0',
    family: 'llama',
    parameterSize: '3.2B',
    contextLength: 131072,
    capabilities: ['completion', 'tools'],
    capabilitySource: 'runtime',
    detailStatus: 'ok',
    loadable: true,
    ...rest,
  };
}

/** The mocked runtime's current inventory. Every test may swap it. */
let runtimeHolds: LocalModelInfo[] = [];
let runtimeError: string | undefined;

let savedSettings: Array<[string, string]> = [];
let savedProviders: Array<{ id: string; name: string; apiKey: string; models: string }> = [];

beforeEach(() => {
  savedSettings = [];
  savedProviders = [];
  runtimeError = undefined;

  window.henryAPI = {
    // opencode is absent on purpose: this file is about the local branch, and a
    // missing opencode CLI must not affect what local models are offered.
    opencodeStatus: async () => ({ available: false }),
    ollamaModels: async () => ({
      models: runtimeHolds,
      baseUrl: 'http://127.0.0.1:11434',
      runtime: 'ollama' as const,
      error: runtimeError,
    }),
    saveSetting: async (key: string, value: string) => {
      savedSettings.push([key, value]);
      useStore.getState().updateSetting(key, value);
      return true;
    },
    saveProvider: async (p: { id: string; name: string; apiKey?: string; models: string }) => {
      savedProviders.push({ id: p.id, name: p.name, apiKey: p.apiKey ?? '', models: p.models });
      useStore.getState().setProviders(
        [...useStore.getState().providers, { id: p.id, name: p.name, apiKey: p.apiKey ?? '', enabled: true, models: p.models } as never]
      );
      return { ok: true };
    },
    getProviders: async () => useStore.getState().providers.map((p) => ({ ...p, api_key: p.apiKey })),
  } as unknown as typeof window.henryAPI;

  useStore.setState({
    // No provider rows at all: no API key is configured anywhere, which is
    // exactly the case in which a local model must still be offered.
    providers: [],
    settings: { companion_provider: '', companion_model: '', ollama_base_url: 'http://127.0.0.1:11434' },
  });
});

afterEach(cleanup);

const engineSelect = () => screen.getByRole('combobox') as HTMLSelectElement;
const renderPicker = () =>
  render(createElement(EngineRow, { engine: 'companion', label: 'Companion engine', hint: 'Used for live conversation in Chat.' }));

describe('the picker exposes exactly what the runtime holds', () => {
  it('offers every discovered local model as an option', async () => {
    runtimeHolds = [
      discovered({ id: 'moondream:latest', capabilities: ['completion', 'vision'], parameterSize: '1B', contextLength: 2048 }),
      discovered({ id: 'llama3.2:3b' }),
      discovered({ id: 'gpt-oss:20b', capabilities: ['completion', 'tools', 'thinking'] }),
    ];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/llama3\.2:3b/)).toBeTruthy());

    const options = Array.from(engineSelect().options).map((o) => o.value);
    for (const m of runtimeHolds) {
      expect(options, `${m.id} is installed but missing from the picker`).toContain(m.id);
    }
    // Exactly the N the runtime reported — not N minus a stale one, and not a
    // picker padded with local models that were never pulled.
    const localOptions = Array.from(engineSelect().options).filter((o) =>
      (o.textContent ?? '').startsWith('Ollama (Local)')
    );
    expect(localOptions.map((o) => o.value).sort()).toEqual(runtimeHolds.map((m) => m.id).sort());
  });

  it('offers no local model the runtime does not hold', async () => {
    runtimeHolds = [discovered({ id: 'moondream:latest' })];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/moondream/)).toBeTruthy());

    const options = Array.from(engineSelect().options).map((o) => o.value);
    // Every one of these was offered by the old static table regardless of what
    // was actually pulled.
    for (const phantom of ['mistral', 'codellama:34b', 'qwen2.5:72b', 'phi4', 'llama3.1:70b', 'gemma2:9b']) {
      expect(options).not.toContain(phantom);
    }
  });

  it('labels a model with the capabilities the runtime reported, not its name', async () => {
    runtimeHolds = [discovered({ id: 'moondream:latest', displayName: 'Moondream', capabilities: ['completion', 'vision'] })];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/Moondream/)).toBeTruthy());

    const labels = Array.from(engineSelect().options).map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('completion') && l.includes('vision'))).toBe(true);
  });

  it('labels a vision-named model without vision as text-only, because the runtime says so', async () => {
    runtimeHolds = [
      discovered({ id: 'llama3.2-vision-but-not:3b', displayName: 'Llama3.2 Vision But Not', capabilities: ['completion', 'tools'] }),
    ];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/Llama3\.2 Vision But Not/)).toBeTruthy());

    const labels = Array.from(engineSelect().options).map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('Llama3.2 Vision But Not'))).toBe(true);
    expect(labels.some((l) => l.includes('Llama3.2 Vision But Not') && l.includes('vision'))).toBe(false);
  });

  it('marks an assumed capability set as assumed', async () => {
    runtimeHolds = [
      discovered({ id: 'moondream:latest', displayName: 'Moondream', capabilitySource: 'fallback', detailStatus: 'assumed', warning: 'capabilities assumed' }),
    ];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/Moondream/)).toBeTruthy());

    const labels = Array.from(engineSelect().options).map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('assumed'))).toBe(true);
  });
});

describe('dynamic inventory — the picker follows the runtime, not a table', () => {
  it('shows a model added to the runtime on a later render', async () => {
    runtimeHolds = [discovered({ id: 'llama3.2:3b' })];
    const { unmount } = renderPicker();
    await waitFor(() => expect(screen.getByText(/llama3\.2:3b/)).toBeTruthy());
    expect(Array.from(engineSelect().options).map((o) => o.value)).not.toContain('moondream:latest');
    unmount();

    runtimeHolds = [...runtimeHolds, discovered({ id: 'moondream:latest', displayName: 'Moondream' })];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/Moondream/)).toBeTruthy());
    expect(Array.from(engineSelect().options).map((o) => o.value)).toContain('moondream:latest');
  });

  it('drops a model the user deleted, which a table would keep offering', async () => {
    runtimeHolds = [discovered({ id: 'llama3.2:3b' }), discovered({ id: 'gpt-oss:20b', displayName: 'Gpt Oss 20b' })];
    const { unmount } = renderPicker();
    await waitFor(() => expect(screen.getByText(/Gpt Oss 20b/)).toBeTruthy());
    expect(Array.from(engineSelect().options).map((o) => o.value)).toContain('gpt-oss:20b');
    unmount();

    runtimeHolds = runtimeHolds.filter((m) => m.id !== 'gpt-oss:20b');
    renderPicker();

    await waitFor(() => expect(screen.getByText(/llama3\.2:3b/)).toBeTruthy());
    expect(Array.from(engineSelect().options).map((o) => o.value)).not.toContain('gpt-oss:20b');
  });
});

describe('a local model is never gated on an API key', () => {
  it('offers local models with no provider row and no key configured anywhere', async () => {
    runtimeHolds = [discovered({ id: 'llama3.2:3b' })];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/llama3\.2:3b/)).toBeTruthy());

    expect(useStore.getState().providers).toEqual([]);
    expect(Array.from(engineSelect().options).map((o) => o.value)).toContain('llama3.2:3b');
  });

  it('persists a picked local model under the local provider, with no key', async () => {
    runtimeHolds = [discovered({ id: 'qwen2.5-coder:7b', displayName: 'Qwen2.5 Coder 7B' })];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/Qwen2\.5 Coder 7B/)).toBeTruthy());
    fireEvent.change(engineSelect(), { target: { value: 'qwen2.5-coder:7b' } });

    await waitFor(() => expect(savedSettings.length).toBeGreaterThan(0));
    expect(savedSettings).toContainEqual(['companion_provider', 'ollama']);
    // The runtime's own id — not a display name, not a shortened tag.
    expect(savedSettings).toContainEqual(['companion_model', 'qwen2.5-coder:7b']);

    const row = savedProviders.find((p) => p.id === 'ollama');
    expect(row).toBeDefined();
    expect(row!.apiKey).toBe('');
    // The provider row records the discovered inventory, so a restart resolves
    // the same models without re-guessing them.
    expect(JSON.parse(row!.models)).toEqual(['qwen2.5-coder:7b']);
  });

  it('persists the whole discovered inventory, not just the model picked', async () => {
    runtimeHolds = [discovered({ id: 'a:1b' }), discovered({ id: 'b:1b' }), discovered({ id: 'c:1b' })];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/a:1b/)).toBeTruthy());
    fireEvent.change(engineSelect(), { target: { value: 'a:1b' } });

    await waitFor(() => expect(savedProviders.length).toBeGreaterThan(0));
    expect(JSON.parse(savedProviders[0]!.models)).toEqual(['a:1b', 'b:1b', 'c:1b']);
  });
});

describe('an unreachable or unloadable local model gets a state, not a hang', () => {
  it('says so when Ollama is not running, instead of showing an empty picker', async () => {
    runtimeHolds = [];
    runtimeError = 'Ollama at http://127.0.0.1:11434 did not respond within 8s. Is it running? (ollama serve)';
    renderPicker();

    await waitFor(() => expect(screen.getByText(/ollama serve/i)).toBeTruthy());
  });

  it('disables a model the runtime says it cannot load, and says how to fix it', async () => {
    runtimeHolds = [
      discovered({ id: 'good:1b', displayName: 'Good' }),
      discovered({
        id: 'corrupt:7b',
        displayName: 'Corrupt',
        loadable: false,
        detailStatus: 'missing',
        warning: 'corrupt:7b is listed by Ollama but cannot be loaded. Re-run: ollama pull corrupt:7b',
      }),
    ];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/Corrupt/)).toBeTruthy());

    const corrupt = Array.from(engineSelect().options).find((o) => o.value === 'corrupt:7b');
    expect(corrupt?.disabled).toBe(true);
    expect(screen.getByText(/ollama pull corrupt:7b/)).toBeTruthy();
  });

  it('keeps a model selectable when the runtime merely failed to answer about it', async () => {
    runtimeHolds = [
      discovered({ id: 'unknown-but-fine:7b', displayName: 'Unknown But Fine', loadable: null, detailStatus: 'unreachable', warning: 'could not reach Ollama' }),
    ];
    renderPicker();

    await waitFor(() => expect(screen.getByText(/Unknown But Fine/)).toBeTruthy());

    const option = Array.from(engineSelect().options).find((o) => o.value === 'unknown-but-fine:7b');
    expect(option?.disabled).toBe(false);
  });
});