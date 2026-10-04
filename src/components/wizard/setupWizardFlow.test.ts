// @vitest-environment jsdom
/**
 * The first-launch flow, rendered.
 *
 * `stages.test.ts` proves the plan; this proves the machine walks it. The
 * failure it guards is the one a fresh install actually hit: the flow never
 * appearing at all, because something decided the profile was already set up,
 * and a required stage being skippable because its Continue button was wired
 * straight to `next()`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import { createElement } from 'react';
import { useStore } from '../../store';
import SetupWizard from './SetupWizard';
import type { LocalModelInfo } from '../../../electron/ipc/ollamaCapabilities';
import { AI_STAGE_BLOCKED_REASON } from '../onboarding/stages';
import { OLLAMA_PROVIDER_ID } from '../../providers/localModels';
import { FIRST_RUN_KEY } from '../../firstRun';

const BLOCKED = AI_STAGE_BLOCKED_REASON;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(): string {
  return document.body.textContent ?? '';
}

const discoveredModel: LocalModelInfo = {
  provider: OLLAMA_PROVIDER_ID,
  runtime: 'ollama',
  id: 'deepseek-r1:7b',
  name: 'deepseek-r1:7b',
  displayName: 'DeepSeek R1 7B',
  local: true,
  requiresApiKey: false,
  sizeBytes: 4_700_000_000,
  sizeGB: '4.7 GB',
  contextLength: 8192,
  capabilities: ['completion'],
  capabilitySource: 'runtime',
  detailStatus: 'ok',
  loadable: true,
};

beforeEach(() => {
  localStorage.clear();
  window.henryAPI = {
    ollamaModels: async () => ({ models: [discoveredModel], baseUrl: 'http://127.0.0.1:11434', runtime: 'ollama' as const }),
    ollamaIsInstalled: async () => ({ installed: true, running: true }),
    opencodeStatus: async () => ({ available: false }),
    opencodeModels: async () => ({ ok: false, models: [] }),
    saveSetting: async () => true,
    saveProvider: async () => ({ ok: true }),
    getProviders: async () => [],
    getSettings: async () => ({}),
    saveMemoryFact: async () => ({ ok: true }),
    computerRunShell: async () => undefined,
  } as unknown as typeof window.henryAPI;
  useStore.setState({ providers: [], settings: {}, setupComplete: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderFlow(onComplete = vi.fn()) {
  render(createElement(SetupWizard, { onComplete }));
  await waitFor(() => expect(text()).toContain("Hey. I'm Henry"));
  return onComplete;
}

describe('a profile with nothing in it', () => {
  it('reaches the first stage', async () => {
    await renderFlow();
    expect(text()).toContain("Hey. I'm Henry");
  });

  it('cannot leave the first stage without being told what comes next', async () => {
    await renderFlow();
    expect(text()).not.toContain('Pick Your Brains');
  });

  it('walks to the provider stage and stops there, because it is the required one', async () => {
    await renderFlow();
    fireEvent.click(screen.getByText('Set up AI →'));
    await waitFor(() => expect(text()).toContain('How to use Henry'));

    // The optional stage before it can be declined outright.
    fireEvent.click(screen.getByText('Skip — set up later'));
    await waitFor(() => expect(text()).toContain('Cloud AI'));
  });
});

describe('the required stage', () => {
  async function reachProvider() {
    const onComplete = await renderFlow();
    fireEvent.click(screen.getByText('Set up AI →'));
    await waitFor(() => expect(text()).toContain('How to use Henry'));
    fireEvent.click(screen.getByText('Skip — set up later'));
    await waitFor(() => expect(text()).toContain('Cloud AI'));
    return onComplete;
  }

  it('says why it cannot be skipped', async () => {
    await reachProvider();
    expect(text()).toContain('Henry cannot answer a single message without a provider');
  });

  it('blocks continuing while no provider has been chosen', async () => {
    await reachProvider();
    expect(text()).toContain(BLOCKED);

    const continueButton = screen.getByText('Continue →') as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
  });

  it('stops blocking once the profile holds a real provider and model', async () => {
    await reachProvider();
    useStore.setState({
      settings: { companion_provider: 'ollama', companion_model: 'deepseek-r1:7b' },
      providers: [{ id: 'ollama', name: 'Ollama', apiKey: '', enabled: true, models: [] } as never],
    });

    // The stage is still required — what changes is that it is satisfied, so
    // the "you cannot leave yet" sentence goes away while the reason it is here
    // stays.
    await waitFor(() => expect(text()).not.toContain(BLOCKED));
    expect(text()).toContain('Henry cannot answer a single message without a provider');
  });
});

describe('the whole sequence, end to end', () => {
  it('runs from a blank profile to the app, choosing nothing on the user\'s behalf', async () => {
    const onComplete = await renderFlow();

    fireEvent.click(screen.getByText('Set up AI →'));
    await waitFor(() => expect(text()).toContain('How to use Henry'));
    fireEvent.click(screen.getByText('Got it — continue →'));
    await waitFor(() => expect(text()).toContain('Cloud AI'));

    // The user's own key, entered by the user. Until it exists, the stage
    // holds them here.
    fireEvent.click(screen.getByText('Paste it here'));
    const keyField = await screen.findByPlaceholderText('sk-or-…');
    fireEvent.change(keyField, { target: { value: 'sk-or-not-a-real-key' } });
    fireEvent.click(screen.getByText('Continue →'));
    await waitFor(() => expect(text()).toContain('Pick Your Brains'));

    fireEvent.click(screen.getByText('Skip — use one model for everything for now'));
    await waitFor(() => expect(text()).toContain('Henry on your phone'));
    fireEvent.click(screen.getByText("Skip — I'll pair my phone later"));
    await waitFor(() => expect(text()).toContain('Everything in the sidebar'));
    fireEvent.click(screen.getByText('Skip the tour'));
    await waitFor(() => expect(text()).toContain('Teach Henry about you'));
    fireEvent.click(screen.getByText('Skip — continue →'));
    await waitFor(() => expect(text()).toMatch(/Running on|Almost ready|all set/));

    fireEvent.click(screen.getByText(/Meet Henry|Continue anyway/));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // The marker is what stops the next launch re-gating this profile.
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('true');
  }, 30_000);
});