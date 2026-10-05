// @vitest-environment jsdom
/**
 * The first-launch flow walked all the way forward, with no Back pressed.
 *
 * `setupWizardFlow.test.ts` covers the individual screens; this covers the walk.
 * The defect it exists for was a flow that asked a new user to choose a provider
 * and a model twice before reaching the app, which reads as a wizard that loops:
 * the stage plan carried both `ai` and `engines`, and the first-launch gate and
 * the onboarding overlay were two independent mounts of the same machine, so
 * finishing the first one dropped the user straight into a second identical run.
 *
 * The assertions are about the walk, not about markup: how many times the brain
 * is asked for, whether the required stage can be walked past, whether every
 * optional stage can be declined, and whether completion happens once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import { createElement } from 'react';
import { useStore } from '../../store';
import SetupWizard from './SetupWizard';
import { FIRST_RUN_KEY } from '../../firstRun';
import { AI_STAGE_BLOCKED_REASON } from '../onboarding/stages';
import type { LocalModelInfo } from '../../../electron/ipc/ollamaCapabilities';
import { OLLAMA_PROVIDER_ID } from '../../providers/localModels';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const saveSetting = vi.fn(async (_key: string, _value: string) => true);

/**
 * The one call in this flow that would read the user's disk if it were ever
 * pressed. Declared on the bridge so the walk can prove that it was not.
 */
const startSystemMapScan = vi.fn(async () => ({ status: 'cancelled' as const }));

beforeEach(() => {
  localStorage.clear();
  saveSetting.mockClear();
  startSystemMapScan.mockClear();
  window.henryAPI = {
    ollamaModels: async () => ({ models: [discoveredModel], baseUrl: 'http://127.0.0.1:11434', runtime: 'ollama' as const }),
    ollamaIsInstalled: async () => ({ installed: true, running: true }),
    opencodeStatus: async () => ({ available: false }),
    opencodeModels: async () => ({ ok: false, models: [] }),
    saveSetting,
    saveProvider: async () => ({ ok: true }),
    getProviders: async () => [],
    getSettings: async () => ({}),
    saveMemoryFact: async () => ({ ok: true }),
    computerRunShell: async () => undefined,
    startSystemMapScan,
  } as unknown as typeof window.henryAPI;
  useStore.setState({ providers: [], settings: {}, setupComplete: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function text(): string {
  return document.body.textContent ?? '';
}

/** One entry per screen the walk lands on, in the order it saw them. */
async function walkForward(): Promise<string[]> {
  const seen: string[] = [];
  const arrive = async () => {
    await waitFor(() => expect(text().trim().length).toBeGreaterThan(0));
    seen.push(text());
  };

  await arrive();                                            // welcome
  fireEvent.click(screen.getByText('Set up AI →'));
  await waitFor(() => expect(text()).toContain('How to use Henry'));
  seen.push(text());

  // The optional stage before the brain can be declined outright.
  fireEvent.click(screen.getByText('Skip — set up later'));
  await waitFor(() => expect(text()).toContain('Cloud AI'));
  seen.push(text());

  // Satisfy the required stage with the user's own key.
  fireEvent.click(screen.getByText('Paste it here'));
  fireEvent.change(await screen.findByPlaceholderText('sk-or-…'), {
    target: { value: 'sk-or-not-a-real-key' },
  });
  fireEvent.click(screen.getByText('Continue →'));

  // The System Map stage sits directly after the required one and is optional.
  // Declining it is one click, and it reads the disk not at all.
  await waitFor(() => expect(text()).toContain('Build Henry'));
  seen.push(text());
  fireEvent.click(screen.getByText('Skip'));

  await waitFor(() => expect(text()).toContain('Henry on your phone'));
  seen.push(text());
  expect(startSystemMapScan).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("Skip — I'll pair my phone later"));
  await waitFor(() => expect(text()).toContain('Everything in the sidebar'));
  seen.push(text());

  fireEvent.click(screen.getByText('Skip the tour'));
  await waitFor(() => expect(text()).toContain('Teach Henry about you'));
  seen.push(text());

  fireEvent.click(screen.getByText('Skip — teach Henry later'));
  await waitFor(() => expect(text()).toMatch(/Running on|Almost ready|all set/));
  seen.push(text());

  return seen;
}

describe('walking the whole flow forward, never backwards', () => {
  it('asks for a brain exactly once', async () => {
    const onComplete = vi.fn();
    render(createElement(SetupWizard, { onComplete }));

    const screens = await walkForward();

    // The provider screen is the brain decision. One screen, one decision.
    const brainScreens = screens.filter((screen_) => screen_.includes('Cloud AI'));
    expect(brainScreens).toHaveLength(1);
    expect(screens.some((screen_) => screen_.includes('Pick Your Brains'))).toBe(false);
  }, 30_000);

  it('reaches the app without a second run of the flow appearing', async () => {
    const onComplete = vi.fn();
    render(createElement(SetupWizard, { onComplete }));

    await walkForward();

    fireEvent.click(screen.getByText(/Meet Henry|Continue anyway/));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    // Nothing took the user back to the first screen behind the completion.
    expect(text()).not.toContain("Hey. I'm Henry");
    expect(text()).not.toContain('Teach Henry about you');
  }, 30_000);
});

describe('the required stage in the middle of that walk', () => {
  async function reachBrain() {
    const onComplete = vi.fn();
    render(createElement(SetupWizard, { onComplete }));
    await waitFor(() => expect(text()).toContain("Hey. I'm Henry"));
    fireEvent.click(screen.getByText('Set up AI →'));
    await waitFor(() => expect(text()).toContain('How to use Henry'));
    fireEvent.click(screen.getByText('Skip — set up later'));
    await waitFor(() => expect(text()).toContain('Cloud AI'));
    return onComplete;
  }

  it('refuses to let the user past it until a provider and a model exist', async () => {
    await reachBrain();

    expect(text()).toContain(AI_STAGE_BLOCKED_REASON);
    const cont = screen.getByText('Continue →') as HTMLButtonElement;
    expect(cont.disabled).toBe(true);

    fireEvent.click(cont);
    expect(text()).toContain('Cloud AI');
  });

  it('stays put even when the user tries to walk out of it with Back', async () => {
    await reachBrain();

    fireEvent.click(screen.getByText('← Back'));
    await waitFor(() => expect(text()).toContain('How to use Henry'));

    // And the required stage is still required when they come back.
    fireEvent.click(screen.getByText('Got it — continue →'));
    await waitFor(() => expect(text()).toContain(AI_STAGE_BLOCKED_REASON));
  });
});

describe('the optional second brain, on the one brain stage', () => {
  it('stores the choice the user made there, without being asked to pick a brain again', async () => {
    useStore.setState({
      providers: [{ id: 'openai', name: 'OpenAI', apiKey: 'sk-user-key', enabled: true, models: [] } as never],
    });
    const onComplete = vi.fn();
    render(createElement(SetupWizard, { onComplete }));
    await waitFor(() => expect(text()).toContain("Hey. I'm Henry"));
    fireEvent.click(screen.getByText('Set up AI →'));
    await waitFor(() => expect(text()).toContain('How to use Henry'));
    fireEvent.click(screen.getByText('Skip — set up later'));
    await waitFor(() => expect(text()).toContain('Cloud AI'));

    fireEvent.change(screen.getByLabelText('Second brain'), { target: { value: 'gpt-4o' } });
    fireEvent.click(screen.getByText('Paste it here'));
    fireEvent.change(await screen.findByPlaceholderText('sk-or-…'), {
      target: { value: 'sk-or-not-a-real-key' },
    });
    fireEvent.click(screen.getByText('Continue →'));

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('worker_model', 'gpt-4o'));
    expect(saveSetting).toHaveBeenCalledWith('worker_provider', 'openai');
    // Forward navigation continues past it — it is not another stage. The
    // optional System Map stage is declined on the way, as it is everywhere.
    fireEvent.click(screen.getByText('Skip'));
    await waitFor(() => expect(text()).toContain('Henry on your phone'));
  }, 30_000);

  it('leaves the second brain alone when the user never touches it', async () => {
    useStore.setState({
      providers: [{ id: 'openai', name: 'OpenAI', apiKey: 'sk-user-key', enabled: true, models: [] } as never],
    });
    render(createElement(SetupWizard, { onComplete: vi.fn() }));
    await walkForward();

    const workerWrites = saveSetting.mock.calls.filter(
      ([key, value]) => key === 'worker_model' && value !== 'meta-llama/llama-3.3-70b-instruct:free',
    );
    expect(workerWrites).toEqual([]);
  }, 30_000);
});

describe('completing the flow', () => {
  it('marks setup complete once, however many times the button is pressed', async () => {
    const onComplete = vi.fn();
    render(createElement(SetupWizard, { onComplete }));

    await walkForward();

    const finish = screen.getByText(/Meet Henry|Continue anyway/);
    fireEvent.click(finish);
    fireEvent.click(finish);

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(saveSetting.mock.calls.filter(([key]) => key === 'setup_complete')).toHaveLength(1);
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('true');
  }, 30_000);
});