/**
 * The abstraction is real: adding a runtime touches no core code.
 *
 * An architecture like this degrades in one specific, quiet way — someone adds a
 * runtime and "just" adds a branch to the router, a check in chat, a special
 * case in the settings panel, because the registry felt like the wrong place.
 * Nothing breaks; the coupling simply creeps back in one `if` at a time.
 *
 * These tests read the actual source of the core modules and fail if that
 * creep starts. They are deliberately source-level: a runtime that leaks into
 * the router would still pass every behavioural test, because the router would
 * produce the right answer on the machines anyone happened to test on.
 *
 * The second half proves the registry genuinely drives discovery — a runtime
 * added at runtime appears in discovery output with no edit to discovery or to
 * any core module.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { discoverRuntimes } from './discovery';
import {
  registerRuntimeAdapter,
  unregisterRuntimeAdapter,
  resetRuntimeRegistry,
  listRuntimeAdapters,
} from './registry';
import type { AgentRuntimeAdapter } from './types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Read a module's source, or '' when it does not exist. */
function sourceOf(relativePath: string): string {
  const abs = path.join(REPO_ROOT, relativePath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

/**
 * Henry's core Chat / routing / provider modules — the code that must stay
 * ignorant of any particular runtime.
 */
const CORE_MODULES = [
  'src/henry/agentRouting.ts',
  'src/henry/modelRouter.ts',
  'src/henry/backendStatus.ts',
  'src/henry/agentRuntimes.ts',
  'electron/ipc/ai.ts',
  'electron/coder/index.ts',
  'electron/coder/claudeCode.ts',
];

/**
 * Runtime-specific spellings that must not appear outside the adapter
 * directory. Each is a fact about ONE CLI's command line, so a core module
 * containing one is coupling by definition.
 */
const RUNTIME_SPECIFIC_TOKENS = [
  '--mode json',
  '--format',
  'OPENCODE_API_KEY',
  'PI_CODING_AGENT',
  '--list-models',
];

describe('core modules import no adapter internals', () => {
  it('finds every core module it is checking', () => {
    // Otherwise the assertions below would pass by checking nothing.
    const missing = CORE_MODULES.filter((m) => sourceOf(m).length === 0);
    expect(missing).toEqual([]);
  });

  it.each(CORE_MODULES)('%s does not import from the adapters directory', (mod) => {
    const src = sourceOf(mod);
    const adapterImports = src
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line) || /\brequire\s*\(/.test(line))
      .filter((line) => line.includes('adapters/'));

    expect(adapterImports, `${mod} imports an adapter directly`).toEqual([]);
  });

  it.each(CORE_MODULES)('%s does not reference a runtime id', (mod) => {
    const src = sourceOf(mod);
    // A runtime's ADAPTER ID (`omp`, `pi`) must never appear in core code: the
    // registry maps a stored setting value onto a runtime, so core never needs
    // to know which runtime that is.
    //
    // The legacy stored value `'opencode'` IS allowed — it is a persisted user
    // choice that predates the adapter layer, and renaming it would invalidate
    // every existing `coder_engine` setting. What is forbidden is reaching past
    // the registry, which is what the adapter-import check above catches.
    const runtimeIds = src
      .split('\n')
      .filter((line) => /['"]omp['"]|['"]pi['"]/.test(line));
    expect(runtimeIds, `${mod} references a runtime id`).toEqual([]);
  });
});

describe('adding an adapter changes discovery with no core edit', () => {
  const NEW_RUNTIME: AgentRuntimeAdapter = {
    id: 'future-runtime',
    displayName: 'Future Runtime',
    description: 'A runtime that does not exist yet.',
    candidateBinaries: () => ['future-runtime'],
    authHint: { envVar: 'FUTURE_TOKEN', optional: true },
    probe: async () => ({
      id: 'future-runtime',
      displayName: 'Future Runtime',
      available: true,
      binaryPath: '/opt/future/bin/future-runtime',
      version: '9.9.9',
      capabilities: { run: { verified: true }, listModels: { verified: true } },
    }),
    listModels: async () => [
      { id: 'future/model-a', name: 'model-a', providerId: 'future', group: 'future' },
    ],
    run: async () => ({ ok: true, text: 'hi' }),
  };

  beforeEach(() => {
    resetRuntimeRegistry();
    for (const id of ['omp', 'pi']) unregisterRuntimeAdapter(id);
  });

  afterEach(() => {
    resetRuntimeRegistry();
  });

  it('appears in discovery output purely because it was registered', async () => {
    const before = await discoverRuntimes({ readSelectedRuntimeId: () => null });
    expect(before.runtimes.map((r) => r.id)).not.toContain('future-runtime');

    registerRuntimeAdapter(NEW_RUNTIME);

    const after = await discoverRuntimes({ readSelectedRuntimeId: () => null });
    expect(after.runtimes.map((r) => r.id)).toContain('future-runtime');
    expect(after.installedRuntimeIds).toContain('future-runtime');
  });

  it('surfaces its verified capabilities and auth hint without special casing', async () => {
    registerRuntimeAdapter(NEW_RUNTIME);

    const { runtimes } = await discoverRuntimes(
      { readSelectedRuntimeId: () => null },
      { includeModels: true },
    );
    const entry = runtimes.find((r) => r.id === 'future-runtime');

    expect(entry?.version).toBe('9.9.9');
    expect(entry?.binaryPath).toBe('/opt/future/bin/future-runtime');
    expect(entry?.capabilities.run.verified).toBe(true);
    expect(entry?.capabilities.modelCount).toBe(1);
    expect(entry?.authHint?.envVar).toBe('FUTURE_TOKEN');
  });

  it('reports a new runtime that is not installed as unavailable', async () => {
    registerRuntimeAdapter({
      ...NEW_RUNTIME,
      probe: async () => ({
        id: 'future-runtime',
        displayName: 'Future Runtime',
        available: false,
        unavailableReason: 'Future Runtime not found.',
        capabilities: {
          run: { verified: false, note: 'Future Runtime not found.' },
          listModels: { verified: false, note: 'Future Runtime not found.' },
        },
      }),
    });

    const { runtimes, installedRuntimeIds } = await discoverRuntimes({
      readSelectedRuntimeId: () => null,
    });
    const entry = runtimes.find((r) => r.id === 'future-runtime');

    expect(entry?.available).toBe(false);
    expect(entry?.unavailableReason).toBe('Future Runtime not found.');
    expect(installedRuntimeIds).not.toContain('future-runtime');
  });

  it('replaces rather than duplicates a re-registered id', async () => {
    registerRuntimeAdapter(NEW_RUNTIME);
    registerRuntimeAdapter({ ...NEW_RUNTIME, displayName: 'Future Runtime v2' });

    const { runtimes } = await discoverRuntimes({ readSelectedRuntimeId: () => null });
    const matches = runtimes.filter((r) => r.id === 'future-runtime');

    expect(matches).toHaveLength(1);
    expect(matches[0].displayName).toBe('Future Runtime v2');
  });

  it('still reports the shipped adapters after the registry is restored', () => {
    resetRuntimeRegistry();

    // Asserted on the registry rather than on discovery output: discovery
    // probes REAL binaries, so its result depends on what the machine running
    // the tests happens to have installed. What is under test here is that both
    // runtimes ship in the registry without any chat or router edit.
    expect(listRuntimeAdapters().map((a) => a.id).sort()).toEqual(['omp', 'pi']);
  });
});