/**
 * Agent Runtime Adapter — the one interface every external agent CLI is reached
 * through.
 *
 * The point of this module is a single rule: **everything that differs between
 * two agent runtimes lives inside that runtime's adapter.** Executable names and
 * install locations, argument construction, authentication, stdout event
 * parsing, model-catalogue parsing and capability detection are all adapter
 * business. Nothing outside `electron/runtimes/adapters/` is allowed to know
 * that one runtime spells its machine-readable mode `--mode json` while another
 * spells it `--json`.
 *
 * What is deliberately NOT here: anything about which runtime Henry should use.
 * Discovery reports what is installed; the user picks. A runtime is never
 * activated by being found.
 *
 * Two identities are kept apart on purpose and must stay apart:
 *
 *   - **Runtime identity** (`omp`, `pi`) — which piece of software on this
 *     machine executes a turn. That is what an adapter is.
 *   - **Provider identity** (`opencode`, `opencode-zen`) — which model service a
 *     turn is billed to and which credential it uses. That is a Henry concept,
 *     carried on `RuntimeModel.providerId`, and it survives the move through a
 *     runtime. Collapsing the two would erase OpenCode Zen's own provider row
 *     and its optional key.
 */

import type { CoderStreamEvent } from '../coder/streamJson';

/** The two capabilities a runtime can be asked to demonstrate on this machine. */
export type RuntimeCapabilityId = 'run' | 'listModels';

/**
 * One capability, and whether this machine's copy of the runtime actually
 * proved it.
 *
 * `verified: false` is the honest default. A runtime whose CLI contract has not
 * been confirmed is never reported as able to run or to list models just
 * because its binary happens to exist.
 */
export interface RuntimeCapability {
  verified: boolean;
  /** Why it is not verified. Present whenever `verified` is false. */
  note?: string;
}

/** What the runtime demonstrably does here, right now. */
export interface RuntimeCapabilities {
  /** One non-interactive turn: prompt in, answer out. */
  run: RuntimeCapability;
  /** Enumerate the models this runtime can reach. */
  listModels: RuntimeCapability;
  /**
   * How many models the runtime listed. Present ONLY when `listModels` was
   * actually run and returned a list — never a guess, never a static number.
   */
  modelCount?: number;
}

/**
 * The result of asking one runtime "are you really here?" Always re-probed:
 * an adapter must not cache availability forever, because the user can install
 * or uninstall software between two discovery calls.
 */
export interface RuntimeProbe {
  /** Stable adapter id, e.g. `omp`. */
  id: string;
  displayName: string;
  /** True only when the runtime's own binary answered. */
  available: boolean;
  /** The executable that answered. */
  binaryPath?: string;
  /** The runtime's own version string, verbatim. */
  version?: string;
  /** One actionable sentence. Present when `available` is false. */
  unavailableReason?: string;
  capabilities: RuntimeCapabilities;
}

/**
 * A model a runtime can reach.
 *
 * `providerId` is the Henry provider this model is served by (`opencode`,
 * `opencode-zen`, …). The runtime that executes it is a separate fact and is
 * NOT encoded here — the same Zen model reached through two runtimes is the same
 * provider with the same credential.
 */
export interface RuntimeModel {
  /** Model id exactly as the runtime's own CLI expects it. */
  id: string;
  name: string;
  /** Henry provider id this model is billed to. */
  providerId: string;
  /** The runtime's own catalogue/group the model was listed under. */
  group: string;
  /** Provider prefix the runtime printed, when it prints one. */
  provider?: string;
  isFree?: boolean;
}

/** One non-interactive turn. */
export interface RuntimeRunRequest {
  prompt: string;
  /** Working directory for the turn. */
  cwd: string;
  /** Runtime-native model id, from `listModels`. */
  model?: string;
  /** Runtime-native sub-agent name, where the runtime supports one. */
  agent?: string;
  /** Continue an existing runtime session where supported. */
  sessionId?: string;
  /** Parsed events, delivered as the runtime emits them. */
  onEvent?: (event: CoderStreamEvent) => void;
  /** Abort the turn. */
  signal?: AbortSignal;
}

export interface RuntimeRunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RuntimeRunOutcome {
  ok: boolean;
  /** Every assistant text part, concatenated. */
  text: string;
  /** Real token counts when the runtime reported them. */
  usage?: RuntimeRunUsage;
  sessionId?: string;
  exitCode?: number | null;
  /** Why the turn failed. Present when `ok` is false. */
  error?: string;
}

/**
 * One external agent runtime.
 *
 * Adding a runtime is: write this interface, register it, done. No change to
 * chat, routing, the provider table or the renderer is required.
 */
export interface AgentRuntimeAdapter {
  /** Stable id. Persisted when the user selects this runtime. */
  id: string;
  displayName: string;
  /**
   * Executable names and paths to probe, in order. Runtime-specific: the same
   * product ships under different binary names on different platforms.
   */
  candidateBinaries(): string[];
  /** Resolve the installed binary, or report unavailable. Never cached. */
  probe(): Promise<RuntimeProbe>;
  /** Models this runtime can reach right now. */
  listModels(): Promise<RuntimeModel[]>;
  /** One non-interactive turn. */
  run(req: RuntimeRunRequest): Promise<RuntimeRunOutcome>;
  /**
   * What credential material this runtime needs, by NAME only. The value is
   * injected into the child environment by the adapter and never leaves it.
   */
  authHint?: { envVar?: string; optional: boolean };
  /** One line shown to the user in the runtime picker. */
  description?: string;
}