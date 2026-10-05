// @vitest-environment jsdom
/**
 * The System Map: consent, exclusions, progress, and the runtime offers.
 *
 * These are the assertions that were impossible to make before, because there
 * was nothing to make them about:
 *
 *   - the stage is in the plan exactly once, and skipping it is a real choice;
 *   - skipping it does NOT let anyone past the required AI stage;
 *   - skipping performs no scan at all — not a scan that runs fast, none;
 *   - pressing "Build System Map" scans with the exclusions the user actually
 *     reviewed, including the ones they edited;
 *   - a cancelled scan keeps nothing;
 *   - discovery of a new agent runtime offers it and changes nothing until the
 *     user accepts it.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { createElement } from 'react';
import {
  buildStagePlan,
  availableStages,
  blockingReason,
  nextStageId,
  type MachineDiscovery,
  type AiChoiceState,
} from './stages';
import SystemMapStage from './stages/SystemMapStage';
import SystemMapPanel from '../settings/SystemMapPanel';
import RuntimeOffers from '../systemMap/RuntimeOffers';
import ScanProgressView from '../systemMap/ScanProgressView';
import {
  CONTENTS_NEVER_READ,
  DEFAULT_EXCLUSION_CATEGORIES,
  includeCategory,
  excludeCategory,
  addFolderExclusion,
  removeFolderExclusion,
  sameExclusions,
  defaultExclusions,
  type SystemMapContents,
  type SystemMapExclusions,
  type SystemMapScanProgress,
  type SystemMapScanOutcome,
} from '../../henry/systemMap';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DESKTOP: MachineDiscovery = {
  platform: 'linux',
  ollamaInstalled: true,
  localModelIds: ['deepseek-r1:7b'],
  opencodeInstalled: true,
  zenModelIds: [],
};

const NO_AI: AiChoiceState = {
  providerId: '',
  modelId: '',
  credentialRequired: false,
  hasCredential: false,
};


const MAP: SystemMapContents = {
  builtAt: 1_700_000_000_000,
  folders: [{ path: '/home/buster/Documents', label: 'Documents', fileCount: 12, totalBytes: 4096 }],
  fileCount: 12,
  totalBytes: 4096,
  apps: [{ name: 'Firefox', version: '128.0' }],
  devTools: [{ name: 'git', version: '2.43.0' }],
  aiSoftware: [{ id: 'ollama', name: 'Ollama' }],
  fileTypes: [{ type: '.txt', count: 12 }],
};

/**
 * A promise plus the means to settle it from outside.
 *
 * Hand-rolled rather than `Promise.withResolvers`, which is ES2024 and this
 * project compiles against ES2022.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A stand-in bridge. Every method is a spy, so "was this called?" is a question
 * a test can answer — which is the only way to prove that *skipping* scans
 * nothing rather than merely appearing not to.
 */
interface FakeBridge {
  calls: {
    startSystemMapScan: Mock;
    saveSystemMapExclusions: Mock;
    cancelSystemMapScan: Mock;
    getSystemMapExclusions: Mock;
    getSystemMapContents: Mock;
    onSystemMapProgress: Mock;
  };
  api: Record<string, unknown>;
  emitProgress: (progress: SystemMapScanProgress) => void;
}

function makeBridge(overrides: Record<string, unknown> = {}): FakeBridge {
  let emit: (progress: SystemMapScanProgress) => void = () => {};
  const calls = {
    startSystemMapScan: vi.fn(async () => ({ status: 'completed', contents: MAP })),
    saveSystemMapExclusions: vi.fn(async () => true),
    cancelSystemMapScan: vi.fn(async () => {}),
    getSystemMapExclusions: vi.fn(async () => defaultExclusions()),
    getSystemMapContents: vi.fn(async () => MAP as SystemMapContents | null),
    onSystemMapProgress: vi.fn((cb: (progress: SystemMapScanProgress) => void) => {
      emit = cb;
      return () => {};
    }),
  };
  return {
    calls: calls as unknown as FakeBridge['calls'],
    api: { ...calls, ...overrides },
    emitProgress: (progress) => emit(progress),
  };
}

let bridge: FakeBridge;

/**
 * Press "Build System Map" the way a person does: wait for it to become
 * available, then click. It unlocks only once the exclusion set has actually
 * loaded, because pressing it earlier would scan something the user had not
 * been shown.
 */
async function clickBuildSystemMap(): Promise<void> {
  const button = await screen.findByRole('button', { name: 'Build System Map' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

/** The exclusion row carrying a given plain-English label. */
function exclusionRow(label: string): HTMLElement {
  const row = screen.getByText(label).closest('div')?.parentElement;
  if (!row) throw new Error(`no exclusion row for "${label}"`);
  return row as HTMLElement;
}

function installBridge() {
  bridge = makeBridge();
  (window as unknown as { henryAPI: unknown }).henryAPI = bridge.api;
}

beforeEach(() => {
  installBridge();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { henryAPI?: unknown }).henryAPI;
  vi.restoreAllMocks();
});

describe('the stage sits in the plan', () => {
  it('appears exactly once', () => {
    const walk = availableStages(buildStagePlan(DESKTOP)).map((s) => s.id);
    expect(walk.filter((id) => id === 'systemMap')).toHaveLength(1);
  });

  it('is optional, and sits directly after the required AI stage', () => {
    const plan = buildStagePlan(DESKTOP);
    const walk = availableStages(plan).map((s) => s.id);
    expect(plan.find((s) => s.id === 'systemMap')?.required).toBe(false);
    expect(walk.indexOf('systemMap')).toBe(walk.indexOf('ai') + 1);
  });

  it('carries no blocking reason of its own — it is skippable', () => {
    const plan = buildStagePlan(DESKTOP);
    expect(blockingReason(plan, 'systemMap', NO_AI)).toBeNull();
  });

  it('is not offered in a browser, where there is no disk to scan', () => {
    const plan = buildStagePlan({ ...DESKTOP, platform: 'web' });
    const stage = plan.find((s) => s.id === 'systemMap');
    expect(stage?.available).toBe(false);
    expect(stage?.unavailableReason).toBeTruthy();
    expect(availableStages(plan).map((s) => s.id)).not.toContain('systemMap');
  });

  it('the AI stage still blocks, and skipping System Map does not get past it', () => {
    const plan = buildStagePlan(DESKTOP);
    // The System Map stage itself is never the thing standing in the way…
    expect(blockingReason(plan, 'systemMap', NO_AI)).toBeNull();
    // …but the required stage on the way there still is.
    expect(blockingReason(plan, 'ai', NO_AI)).toBeTruthy();
    // And walking past System Map does not reclassify the walk: `ai` is still the
    // only required stage, and it is still required.
    expect(availableStages(plan).filter((s) => s.required).map((s) => s.id)).toEqual(['ai']);
    expect(nextStageId(plan, 'ai')).toBe('systemMap');
  });

  it('is offered on every desktop platform', () => {
    for (const platform of ['macos', 'linux', 'windows'] as const) {
      const plan = buildStagePlan({ ...DESKTOP, platform });
      expect(availableStages(plan).map((s) => s.id)).toContain('systemMap');
    }
  });
});

describe('what the stage says before anything happens', () => {
  it('offers both a Build action and an explicit Skip', async () => {
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    expect(await screen.findByRole('button', { name: 'Build System Map' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
  });

  it('shows the default excluded categories in plain language, not paths', async () => {
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await screen.findByRole('button', { name: 'Build System Map' });
    for (const category of DEFAULT_EXCLUSION_CATEGORIES) {
      expect(screen.getByText(category.label)).toBeTruthy();
    }
    // Nothing on screen leaks a path pattern for a default category.
    expect(document.body.textContent).not.toContain('/home/*');
  });

  it('states that file contents are never read', async () => {
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await screen.findByRole('button', { name: 'Build System Map' });
    expect(CONTENTS_NEVER_READ).toContain('not file contents');
    expect(document.body.textContent).toContain(CONTENTS_NEVER_READ);
  });
});

describe('Skip performs no scan', () => {
  it('leaves the stage without starting anything', async () => {
    const onSkip = vi.fn();
    const onNext = vi.fn();
    render(createElement(SystemMapStage, { onNext, onSkip }));

    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
    expect(bridge.calls.startSystemMapScan).not.toHaveBeenCalled();
    expect(bridge.calls.getSystemMapContents).not.toHaveBeenCalled();
  });

  it('scans nothing merely by being mounted', async () => {
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await screen.findByRole('button', { name: 'Build System Map' });
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.calls.startSystemMapScan).not.toHaveBeenCalled();
  });
});

describe('Build System Map scans with the reviewed exclusions', () => {
  it('sends the default set when the user changes nothing', async () => {
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await clickBuildSystemMap();

    await waitFor(() => expect(bridge.calls.startSystemMapScan).toHaveBeenCalledTimes(1));
    const sent = bridge.calls.startSystemMapScan.mock.calls[0][0] as SystemMapExclusions;
    expect(sent.folders).toEqual([]);
    expect(sent.categories.map((c) => c.id)).toEqual(
      defaultExclusions().categories.map((c) => c.id),
    );
    expect(sent.categories.every((c) => c.isDefault)).toBe(true);
  });

  it('sends the set the user edited — a removed category is really gone', async () => {
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await waitFor(() => expect(bridge.calls.getSystemMapExclusions).toHaveBeenCalled());
    fireEvent.click(
      within(exclusionRow("Other people's folders")).getByRole('button', {
        name: 'Scan it anyway',
      }),
    );

    await clickBuildSystemMap();

    await waitFor(() => expect(bridge.calls.startSystemMapScan).toHaveBeenCalledTimes(1));
    const sent = bridge.calls.startSystemMapScan.mock.calls[0][0] as SystemMapExclusions;
    expect(sent.categories.map((c) => c.id)).not.toContain('otherUsers');
    expect(sent.categories.map((c) => c.id)).toContain('secrets');
  });

  it('sends a folder the user added by hand', async () => {
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    fireEvent.change(await screen.findByLabelText('Folder to leave out'), {
      target: { value: '/home/buster/Private' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Build System Map' }));

    await waitFor(() => expect(bridge.calls.startSystemMapScan).toHaveBeenCalledTimes(1));
    const sent = bridge.calls.startSystemMapScan.mock.calls[0][0] as SystemMapExclusions;
    expect(sent.folders).toEqual([{ path: '/home/buster/Private' }]);
  });

  it('persists the reviewed set so it can be re-opened later', async () => {
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await clickBuildSystemMap();
    await waitFor(() => expect(bridge.calls.saveSystemMapExclusions).toHaveBeenCalled());
  });
});

describe('exclusions can be reviewed and changed', () => {
  it('lets a user put an excluded category back into the scan', async () => {
    const start = defaultExclusions();
    const after = includeCategory(start, 'secrets');
    expect(after.categories.map((c) => c.id)).not.toContain('secrets');
    // Everything else is untouched — one removal must not clear the list.
    expect(after.categories).toHaveLength(start.categories.length - 1);
  });

  it('lets a user put a category back out of the scan', () => {
    const category = DEFAULT_EXCLUSION_CATEGORIES[0];
    const included = includeCategory(defaultExclusions(), category.id);
    // Order is not part of the set — what matters is the membership.
    expect(sameExclusions(excludeCategory(included, category), defaultExclusions())).toBe(true);
  });

  it('adds and removes user folders, ignoring blanks and duplicates', () => {
    let exclusions = defaultExclusions();
    exclusions = addFolderExclusion(exclusions, '/a');
    exclusions = addFolderExclusion(exclusions, '/a');
    exclusions = addFolderExclusion(exclusions, '   ');
    expect(exclusions.folders).toEqual([{ path: '/a' }]);
    exclusions = removeFolderExclusion(exclusions, '/a');
    expect(exclusions.folders).toEqual([]);
  });

  it('compares two sets by membership, not by order', () => {
    const a: SystemMapExclusions = {
      categories: [{ id: 'x', label: 'X', isDefault: true }, { id: 'y', label: 'Y', isDefault: true }],
      folders: [{ path: '/p' }],
    };
    const b: SystemMapExclusions = {
      categories: [{ id: 'y', label: 'Y', isDefault: true }, { id: 'x', label: 'X', isDefault: true }],
      folders: [{ path: '/p' }],
    };
    expect(sameExclusions(a, b)).toBe(true);
    expect(sameExclusions(a, { ...b, folders: [] })).toBe(false);
  });
});

describe('progress is live, and the scan can be stopped', () => {
  it('shows a scanning state and the folder being read', async () => {
    const scan = deferred<SystemMapScanOutcome>();
    bridge.api.startSystemMapScan = vi.fn(() => scan.promise);
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await clickBuildSystemMap();

    await screen.findByRole('button', { name: 'Cancel scan' });

    bridge.emitProgress({
      phase: 'scanning',
      foldersScanned: 3,
      filesScanned: 120,
      bytesScanned: 2048,
      totalFiles: 400,
      currentFolder: '/home/buster/Documents',
      appsFound: 2,
      devToolsFound: 1,
    });

    await waitFor(() => expect(document.body.textContent).toContain('/home/buster/Documents'));
    expect(document.body.textContent).toContain('120');

    scan.resolve({ status: 'completed', contents: MAP });
    await waitFor(() => screen.getByRole('button', { name: 'Continue →' }));
  });

  it('admits it has no total rather than inventing one', async () => {
    const scan = deferred<SystemMapScanOutcome>();
    bridge.api.startSystemMapScan = vi.fn(() => scan.promise);
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await clickBuildSystemMap();
    await screen.findByRole('button', { name: 'Cancel scan' });

    // The scanner reports `totalFiles: null` on every event, on both the first
    // crawl and the incremental rebuild — it genuinely cannot know what is left.
    bridge.emitProgress({
      phase: 'scanning',
      foldersScanned: 9,
      filesScanned: 640,
      bytesScanned: 8192,
      totalFiles: null,
      currentFolder: '/home/buster/Pictures',
      appsFound: 5,
      devToolsFound: 3,
    });

    await waitFor(() => expect(document.body.textContent).toContain('640 files found so far'));
    // An indeterminate bar reports no value, rather than claiming 0%.
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+% —/);

    scan.resolve({ status: 'completed', contents: MAP });
    await waitFor(() => screen.getByRole('button', { name: 'Continue →' }));
  });

  it('shows a real percentage the moment a real total exists', () => {
    const { container } = render(
      createElement(ScanProgressView, {
        progress: {
          phase: 'scanning',
          foldersScanned: 1,
          filesScanned: 50,
          bytesScanned: 1024,
          totalFiles: 200,
          currentFolder: null,
          appsFound: 0,
          devToolsFound: 0,
        },
      }),
    );
    expect(container.textContent).toContain('25% — 50 of 200 files');
  });

  it('cancels on request, keeps nothing, and does not slip a second scan through', async () => {
    const scan = deferred<SystemMapScanOutcome>();
    const startScan = vi.fn(() => scan.promise);
    bridge.api.startSystemMapScan = startScan;
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await clickBuildSystemMap();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel scan' }));

    expect(bridge.calls.cancelSystemMapScan).toHaveBeenCalledTimes(1);
    scan.resolve({ status: 'cancelled' });

    // Back on the review screen, told plainly that nothing was kept, and no map
    // is on offer — a truncated inventory must not be presented as a real one.
    await waitFor(() => screen.getByRole('button', { name: 'Build System Map' }));
    expect(document.body.textContent).toContain('Nothing was kept');
    expect(screen.queryByRole('button', { name: 'Continue →' })).toBeNull();
    // And the stage has settled: no second scan was started behind the cancel.
    expect(startScan).toHaveBeenCalledTimes(1);
  });

  it('reports a failed scan and does not claim to be ready', async () => {
    bridge.api.startSystemMapScan = vi.fn(async () => ({
      status: 'failed',
      error: 'the disk could not be read',
    }));
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await clickBuildSystemMap();

    await waitFor(() =>
      expect(document.body.textContent).toContain('the disk could not be read'),
    );
    expect(screen.queryByRole('button', { name: 'Continue →' })).toBeNull();
  });
});

describe('the finished map is visible, and a rebuild is available after it', () => {
  it('shows what the map contains', async () => {
    render(createElement(SystemMapStage, { onNext: vi.fn(), onSkip: vi.fn() }));
    await clickBuildSystemMap();

    await waitFor(() => screen.getByRole('button', { name: 'Continue →' }));
    expect(document.body.textContent).toContain('Firefox');
    expect(document.body.textContent).toContain('Documents');
  });

  it('offers Rebuild System Map in Settings once a map exists', async () => {
    render(createElement(SystemMapPanel));

    const rebuild = await screen.findByRole('button', { name: 'Rebuild System Map' });
    expect((rebuild as HTMLButtonElement).disabled).toBe(false);
  });

  it('rebuilds with the exclusions shown on screen', async () => {
    render(createElement(SystemMapPanel));
    const rebuild = await screen.findByRole('button', { name: 'Rebuild System Map' });
    fireEvent.click(rebuild);

    await waitFor(() => expect(bridge.calls.startSystemMapScan).toHaveBeenCalledTimes(1));
    const sent = bridge.calls.startSystemMapScan.mock.calls[0][0] as SystemMapExclusions;
    expect(sent.categories.map((c) => c.id)).toEqual(
      defaultExclusions().categories.map((c) => c.id),
    );
  });

  it('re-opens the exclusions so they can be changed before a rebuild', async () => {
    render(createElement(SystemMapPanel));
    fireEvent.click(await screen.findByRole('button', { name: 'Exclusions' }));

    expect(await screen.findByLabelText('Folder to leave out')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Folder to leave out'), {
      target: { value: '/home/buster/Secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and rebuild' }));

    await waitFor(() => expect(bridge.calls.startSystemMapScan).toHaveBeenCalledTimes(1));
    const sent = bridge.calls.startSystemMapScan.mock.calls[0][0] as SystemMapExclusions;
    expect(sent.folders).toEqual([{ path: '/home/buster/Secret' }]);
  });

  it('says plainly when no map has been built, instead of showing a blank box', async () => {
    bridge.api.getSystemMapContents = vi.fn(async () => null);
    render(createElement(SystemMapPanel));

    await waitFor(() =>
      expect(document.body.textContent).toContain('No system map has been built'),
    );
    expect((screen.getByRole('button', { name: 'Rebuild System Map' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('a cancelled rebuild keeps the existing map and is not treated as a failure', async () => {
    const scan = deferred<SystemMapScanOutcome>();
    bridge.api.startSystemMapScan = vi.fn(() => scan.promise);
    render(createElement(SystemMapPanel));
    fireEvent.click(await screen.findByRole('button', { name: 'Rebuild System Map' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel scan' }));
    scan.resolve({ status: 'cancelled' });

    // Reported as stopped, not as an error to retry — the user asked for it, so
    // nothing has gone wrong and nothing is offered to retry.
    await waitFor(() => expect(document.body.textContent).toContain('Scan cancelled'));
    expect(document.body.textContent).not.toContain('did not finish');
    // And the map that was already there is still there.
    expect(document.body.textContent).toContain('Firefox');
    expect((screen.getByRole('button', { name: 'Rebuild System Map' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });
});

describe('newly discovered agent runtimes are offered, never applied', () => {
  /** A discovery result naming three runtimes: one in use, one new, one absent. */
  function installRuntimeDiscovery(selectedRuntimeId: string | null) {
    const selectAgentRuntime = vi.fn(async (id: string) => ({ ok: true, selectedRuntimeId: id }));
    bridge.api.selectAgentRuntime = selectAgentRuntime;
    bridge.api.discoverAgentRuntimes = vi.fn(async () => ({
      runtimes: [
        {
          id: 'omp',
          displayName: 'OpenCode',
          available: true,
          capabilities: {
            run: { verified: true },
            listModels: { verified: true, modelCount: 3 },
          },
        },
        {
          id: 'pi',
          displayName: 'Pi',
          available: true,
          description: 'A second agent runtime installed here.',
          capabilities: { run: { verified: false }, listModels: { verified: false } },
        },
        {
          id: 'absent',
          displayName: 'Not Installed',
          available: false,
          unavailableReason: 'No binary found.',
          capabilities: { run: { verified: false }, listModels: { verified: false } },
        },
      ],
      installedRuntimeIds: ['omp', 'pi'],
      selectedRuntimeId,
      discoveredAt: 0,
    }));
    return { selectAgentRuntime };
  }

  it('offers a runtime that is installed and not already chosen', async () => {
    installRuntimeDiscovery(null);
    render(createElement(RuntimeOffers));

    const buttons = await screen.findAllByRole('button', { name: 'Use this runtime' });
    expect(buttons).toHaveLength(2);
  });

  it('does not offer a runtime that is not installed', async () => {
    installRuntimeDiscovery(null);
    render(createElement(RuntimeOffers));

    await screen.findAllByRole('button', { name: 'Use this runtime' });
    expect(document.body.textContent).not.toContain('Not Installed');
  });

  it('does not offer the runtime already in use', async () => {
    installRuntimeDiscovery('omp');
    render(createElement(RuntimeOffers));

    await screen.findByText('Pi');
    expect(document.body.textContent).not.toContain('OpenCode');
    expect(screen.getAllByRole('button', { name: 'Use this runtime' })).toHaveLength(1);
  });

  it('changes nothing at all until the accept button is pressed', async () => {
    const { selectAgentRuntime } = installRuntimeDiscovery(null);
    render(createElement(RuntimeOffers));

    await screen.findAllByRole('button', { name: 'Use this runtime' });
    // Discovery is read-only: having found a runtime must not select one.
    expect(selectAgentRuntime).not.toHaveBeenCalled();
  });

  it('accepting is the only thing that changes the selection', async () => {
    const { selectAgentRuntime } = installRuntimeDiscovery(null);
    render(createElement(RuntimeOffers));

    const pi = await screen.findByText('Pi');
    fireEvent.click(
      within(pi.closest('li') as HTMLElement).getByRole('button', { name: 'Use this runtime' }),
    );

    await waitFor(() => expect(selectAgentRuntime).toHaveBeenCalledTimes(1));
    expect(selectAgentRuntime).toHaveBeenCalledWith('pi');
    // The accepted runtime leaves the offer list rather than being offered twice,
    // and the one that was never accepted is still there.
    await waitFor(() => expect(screen.queryByText('Pi')).toBeNull());
    expect(screen.getByText('OpenCode')).toBeTruthy();
  });

  it('says nothing at all when there is nothing new to offer', async () => {
    installRuntimeDiscovery('omp');
    bridge.api.discoverAgentRuntimes = vi.fn(async () => ({
      runtimes: [],
      installedRuntimeIds: [],
      selectedRuntimeId: 'omp',
      discoveredAt: 0,
    }));
    const { container } = render(createElement(RuntimeOffers));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });
});
