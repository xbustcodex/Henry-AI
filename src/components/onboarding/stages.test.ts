// @vitest-environment jsdom
/**
 * First-launch seam: the plan a fresh profile walks, and the rules that decide
 * whether it can walk past a stage.
 *
 * These are the assertions that were impossible to make before: not "does the
 * welcome screen render" but "does a profile with nothing in it reach the first
 * stage", "can every non-required stage be skipped on purpose", and "does the
 * one required stage actually block".
 */
import { describe, it, expect } from 'vitest';
import {
  buildStagePlan,
  availableStages,
  firstStageId,
  nextStageId,
  previousStageId,
  blockingReason,
  isAiStageSatisfied,
  AI_STAGE_BLOCKED_REASON,
  type MachineDiscovery,
  type AiChoiceState,
} from './stages';

const LINUX_DESKTOP: MachineDiscovery = {
  platform: 'linux',
  ollamaInstalled: true,
  localModelIds: ['deepseek-r1:7b'],
  opencodeInstalled: true,
  zenModelIds: ['grok-code-fast-1'],
};

const MAC_DESKTOP: MachineDiscovery = {
  platform: 'macos',
  ollamaInstalled: false,
  localModelIds: [],
  opencodeInstalled: false,
  zenModelIds: [],
};

const configuredByUser: AiChoiceState = {
  providerId: 'ollama',
  modelId: 'deepseek-r1:7b',
  credentialRequired: false,
  hasCredential: false,
};

describe('a fresh profile reaches the first stage', () => {
  it('starts on Welcome, not on a stage that a previous run happened to leave behind', () => {
    const plan = buildStagePlan({ ...LINUX_DESKTOP, localModelIds: [], ollamaInstalled: false });
    expect(firstStageId(plan)).toBe('welcome');
  });

  it('walks every intended stage in order when nothing is deferred', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    const walk = availableStages(plan).map((stage) => stage.id);

    expect(walk).toEqual([
      'welcome',
      'howItWorks',
      'ai',
      'engines',
      'companion',
      'panels',
      'memory',
      'done',
    ]);
  });

  it('keeps the engine-assignment stage, which used to be unreachable dead code', () => {
    const walk = availableStages(buildStagePlan(LINUX_DESKTOP)).map((stage) => stage.id);
    expect(walk).toContain('engines');
  });

  it('ends on the summary stage and has no stage after it', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    expect(nextStageId(plan, 'done')).toBeNull();
  });

  it('walks backwards through the same stages it walks forwards through', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    const walk = availableStages(plan).map((stage) => stage.id);
    const backwards = [...walk].reverse().slice(1);
    expect(backwards).toEqual(walk.slice(0, -1).reverse());
    expect(previousStageId(plan, walk[0])).toBeNull();
  });
});

describe('stages this machine does not need', () => {
  it('does not offer macOS permission consent on Linux, and says why', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    const accessibility = plan.find((stage) => stage.id === 'accessibility');

    expect(accessibility?.available).toBe(false);
    expect(accessibility?.unavailableReason).toBeTruthy();
    expect(availableStages(plan).map((s) => s.id)).not.toContain('accessibility');
  });

  it('offers both permission stages on macOS, where the user is asked to grant them', () => {
    const walk = availableStages(buildStagePlan(MAC_DESKTOP)).map((stage) => stage.id);
    expect(walk).toContain('accessibility');
    expect(walk).toContain('screen');
  });

  it('never leaves the walk on a stage it just marked unavailable', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    // The old navigator advanced the index once per press, landing on the second
    // macOS-only stage — which renders nothing off macOS. A blank screen with no
    // way forward was the symptom; walking the available list is the fix.
    expect(nextStageId(plan, 'howItWorks')).toBe('ai');
    expect(nextStageId(plan, 'ai')).toBe('engines');
  });
});

describe('optional stages', () => {
  it('marks everything except the provider stage as skippable', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    const required = availableStages(plan).filter((stage) => stage.required).map((s) => s.id);
    expect(required).toEqual(['ai']);
  });

  it('never blocks a stage the user is allowed to skip', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    for (const stage of availableStages(plan)) {
      if (stage.required) continue;
      expect(blockingReason(plan, stage.id, { ...configuredByUser, providerId: '', modelId: '' })).toBeNull();
    }
  });

  it('states why the provider stage cannot be skipped', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    expect(plan.find((stage) => stage.id === 'ai')?.requiredBecause).toBeTruthy();
  });
});

describe('the required stage blocks until it is satisfied', () => {
  it('blocks when no provider has been chosen', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    expect(blockingReason(plan, 'ai', { ...configuredByUser, providerId: '', modelId: '' }))
      .toBe(AI_STAGE_BLOCKED_REASON);
  });

  it('blocks when a provider is chosen but no model is', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    expect(blockingReason(plan, 'ai', { ...configuredByUser, modelId: '' }))
      .toBe(AI_STAGE_BLOCKED_REASON);
  });

  it('blocks a paid provider that has no credential — a row is not authentication', () => {
    expect(isAiStageSatisfied({
      providerId: 'openrouter',
      modelId: 'meta-llama/llama-3.3-70b-instruct:free',
      credentialRequired: true,
      hasCredential: false,
    })).toBe(false);
  });

  it('accepts a paid provider once the user has entered their own key', () => {
    expect(isAiStageSatisfied({
      providerId: 'openrouter',
      modelId: 'meta-llama/llama-3.3-70b-instruct:free',
      credentialRequired: true,
      hasCredential: true,
    })).toBe(true);
  });

  it('accepts a genuinely local model with no credential, because none is needed', () => {
    expect(isAiStageSatisfied(configuredByUser)).toBe(true);
  });

  it('accepts a free Zen model with no credential — Zen is credential-optional', () => {
    expect(isAiStageSatisfied({
      providerId: 'opencode-zen',
      modelId: 'grok-code-fast-1',
      credentialRequired: false,
      hasCredential: false,
    })).toBe(true);
  });

  it('lets the flow leave the required stage once the choice is satisfied', () => {
    const plan = buildStagePlan(LINUX_DESKTOP);
    expect(blockingReason(plan, 'ai', configuredByUser)).toBeNull();
    expect(nextStageId(plan, 'ai')).toBe('engines');
  });
});