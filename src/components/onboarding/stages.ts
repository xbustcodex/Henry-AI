/**
 * The first-launch stage plan — what setup actually contains, in order.
 *
 * Two wizards used to disagree about this: a three-step SetupWizard (hello,
 * provider, done) and a nine-step OnboardingWizard (welcome, how-it-works,
 * permissions, provider, phone, panels, memory, done). Neither was complete and
 * they shared no vocabulary, so "which screens did a first launch show?" had no
 * answer that was true in both. There is one list here now, and both
 * entry points walk it.
 *
 * Three rules shape the list, and each one exists because breaking it produced
 * a real bug:
 *
 *   1. A stage that this machine does not need is marked unavailable with a
 *      reason, not silently dropped. macOS permission consent has nothing to
 *      ask for on Linux, where the capability is detected instead — and the
 *      old code "skipped" it by advancing the index, which used to leave a
 *      blank screen with no way forward.
 *   2. A stage is either required or explicitly skippable. There is no third
 *      state where the user is walked past something without choosing to.
 *   3. Only the AI provider stage is required, because it is the one stage
 *      without which the product does nothing at all. Everything else can be
 *      deferred, and says so.
 *
 * The plan is pure data: no React, no IPC, no localStorage. What the machine
 * discovered about the machine goes in; what the user has to walk through comes
 * out. That is what makes it testable without a browser.
 */

export type StageId =
  | 'welcome'
  | 'howItWorks'
  | 'accessibility'
  | 'screen'
  | 'ai'
  | 'engines'
  | 'companion'
  | 'panels'
  | 'memory'
  | 'done';

export type Platform = 'macos' | 'linux' | 'windows' | 'web';

/** What setup found on the machine it is running on. All of it discovered. */
export interface MachineDiscovery {
  platform: Platform;
  /** Ollama answered on its own port. */
  ollamaInstalled: boolean;
  /** Model ids Ollama itself reported. Never a hard-coded catalogue. */
  localModelIds: readonly string[];
  /** The opencode CLI is installed on this machine. */
  opencodeInstalled: boolean;
  /** Zen model ids the opencode bridge reported. */
  zenModelIds: readonly string[];
}

export const EMPTY_DISCOVERY: MachineDiscovery = {
  platform: 'web',
  ollamaInstalled: false,
  localModelIds: [],
  opencodeInstalled: false,
  zenModelIds: [],
};

export interface StagePlanEntry {
  id: StageId;
  title: string;
  /** Blocking stages the user cannot continue past unsatisfied. */
  required: boolean;
  /** False when this machine has no such stage to show; it is then not shown. */
  available: boolean;
  /** Why the stage is required — rendered on the stage itself. */
  requiredBecause?: string;
  /** Why it is not available here — the user is told rather than left guessing. */
  unavailableReason?: string;
}

/**
 * The intended order. `engines` sits between provider and phone because
 * assigning the brains is a decision made while the provider choice is fresh;
 * it was in the codebase and unreachable from either wizard.
 */
const STAGE_ORDER: readonly { id: StageId; title: string; required: boolean; macOnly?: boolean }[] = [
  { id: 'welcome', title: 'Welcome', required: false },
  { id: 'howItWorks', title: 'How to use Henry', required: false },
  { id: 'accessibility', title: 'Accessibility access', required: false, macOnly: true },
  { id: 'screen', title: 'Screen recording', required: false, macOnly: true },
  { id: 'ai', title: 'AI provider', required: true },
  { id: 'engines', title: 'Pick your brains', required: false },
  { id: 'companion', title: 'Henry on your phone', required: false },
  { id: 'panels', title: 'Sidebar tour', required: false },
  { id: 'memory', title: 'Teach Henry about you', required: false },
  { id: 'done', title: 'Ready', required: false },
];

/**
 * Build the stages this launch will actually walk, in order.
 *
 * Availability is a property of the machine, not of the user: a Linux user is
 * never asked to grant Accessibility, because there is no such toggle to grant.
 */
export function buildStagePlan(discovery: MachineDiscovery): StagePlanEntry[] {
  const stages: StagePlanEntry[] = [];

  for (const stage of STAGE_ORDER) {
    if (stage.macOnly && discovery.platform !== 'macos') {
      stages.push({
        id: stage.id,
        title: stage.title,
        required: false,
        available: false,
        unavailableReason:
          'macOS asks the user to grant this. On this platform the equivalent capability is detected automatically, so there is nothing to grant.',
      });
      continue;
    }

    stages.push({
      id: stage.id,
      title: stage.title,
      required: stage.required,
      available: true,
      ...(stage.required
        ? {
            requiredBecause:
              'Henry cannot answer a single message without a provider to answer with. Everything else in this setup can wait; this cannot.',
          }
        : {}),
    });
  }

  return stages;
}

/** The stages a launch walks: the available ones, `done` always last. */
export function availableStages(plan: readonly StagePlanEntry[]): StagePlanEntry[] {
  return plan.filter((stage) => stage.available);
}

/** The stage a fresh launch starts on. Never skipped, whatever the machine. */
export function firstStageId(plan: readonly StagePlanEntry[]): StageId | null {
  return availableStages(plan)[0]?.id ?? null;
}

/** The next available stage after `current`, or null at the end of the flow. */
export function nextStageId(plan: readonly StagePlanEntry[], current: StageId): StageId | null {
  const walkable = availableStages(plan);
  const index = walkable.findIndex((stage) => stage.id === current);
  if (index < 0) return walkable[0]?.id ?? null;
  return walkable[index + 1]?.id ?? null;
}

/** The previous available stage, for Back. Null before the first stage. */
export function previousStageId(plan: readonly StagePlanEntry[], current: StageId): StageId | null {
  const walkable = availableStages(plan);
  const index = walkable.findIndex((stage) => stage.id === current);
  if (index <= 0) return null;
  return walkable[index - 1].id;
}

/** What the user has actually configured, as the plan needs to judge it. */
export interface AiChoiceState {
  providerId: string;
  modelId: string;
  /** Whether THIS provider needs the user's own credential to answer. */
  credentialRequired: boolean;
  /** Whether a credential the user entered is stored for it. */
  hasCredential: boolean;
}

/**
 * The AI stage is satisfied by a provider the user chose and a model they can
 * name — and, where the provider charges money or talks to someone's account, by
 * that user's own credential.
 *
 * Deliberately strict: a row that exists is not enough, and neither is a model
 * name typed into a field when the provider needs a key. Local Ollama and free
 * Zen models pass without one because they genuinely do not need one.
 */
export function isAiStageSatisfied(state: AiChoiceState): boolean {
  if (!state.providerId.trim() || !state.modelId.trim()) return false;
  return state.credentialRequired ? state.hasCredential : true;
}

/** The sentence shown when the required stage is blocking. */
export const AI_STAGE_BLOCKED_REASON =
  'Choose a provider and a model before continuing — Henry has nothing to answer with until you do. Local Ollama and free OpenCode Zen models need no key.';

/**
 * The reason `current` cannot be left yet, or null when it can.
 *
 * Blocking is decided here, once, rather than by each stage deciding whether
 * its own Continue button is enabled — which is how a required stage used to end
 * up skippable by virtue of its button being wired straight to `next()`.
 */
export function blockingReason(
  plan: readonly StagePlanEntry[],
  current: StageId,
  ai: AiChoiceState,
): string | null {
  const stage = plan.find((entry) => entry.id === current);
  if (!stage?.required) return null;
  return isAiStageSatisfied(ai) ? null : AI_STAGE_BLOCKED_REASON;
}

/** The label on the button that leaves a required stage. */
export function continueLabel(stage: StagePlanEntry | undefined): string {
  return stage?.required ? 'Save and continue →' : 'Continue →';
}