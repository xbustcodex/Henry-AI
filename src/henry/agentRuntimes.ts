/**
 * Agent runtime discovery — renderer side.
 *
 * This module is the renderer's ONLY route to runtime information, and it is a
 * thin wrapper over the preload bridge. There is no `child_process`, no `fs` and
 * no `os` here: asking "is this CLI installed?" is a privileged question, and
 * the renderer asks it over IPC exactly the way it asks for a screenshot.
 *
 * ── The rule this file exists to keep ──────────────────────────────────────
 *
 * Discovery never changes what the user selected. `discoverAgentRuntimes()`
 * reports; `selectAgentRuntime()` is the only thing here that writes, and it
 * writes because a person pressed a button. Nothing in this module picks a
 * default, activates a runtime, or migrates a selection as a side effect of
 * looking — a user who has chosen nothing keeps having chosen nothing.
 *
 * ── Two identities, kept apart ─────────────────────────────────────────────
 *
 * A runtime (`omp`, `pi`) is which piece of software runs a turn. A provider
 * (`opencode`, `opencode-zen`) is which model service it is billed to, with its
 * own credential and its own catalogue entry. Discovery surfaces runtimes; it
 * does not merge them into providers, and it does not let one replace the other.
 */

/** One capability a runtime demonstrated on this machine. */
export interface RuntimeCapabilityInfo {
  verified: boolean;
  /** Why it is not verified. Present whenever `verified` is false. */
  note?: string;
}

export interface RuntimeCapabilitiesInfo {
  run: RuntimeCapabilityInfo;
  listModels: RuntimeCapabilityInfo;
  /** Only present when the runtime actually listed its models. */
  modelCount?: number;
}

/** One runtime, as discovery found it. */
export interface DiscoveredRuntime {
  id: string;
  displayName: string;
  /** True only when the runtime's own binary answered. */
  available: boolean;
  /** Where the executable was found. */
  binaryPath?: string;
  /** The runtime's own version string. */
  version?: string;
  /** Present when `available` is false. */
  unavailableReason?: string;
  capabilities: RuntimeCapabilitiesInfo;
  /** Model ids, only when model listing was requested and succeeded. */
  models?: string[];
  /** Auth material the runtime needs, by NAME only. Never a value. */
  authHint?: { envVar?: string; optional: boolean };
  description?: string;
}

export interface RuntimeDiscovery {
  /** Every registered runtime, installed or not. Nothing is dropped. */
  runtimes: DiscoveredRuntime[];
  /** Exactly the ids of the runtimes that are genuinely installed. */
  installedRuntimeIds: string[];
  /** The stored selection, read and echoed back. Discovery did not set it. */
  selectedRuntimeId: string | null;
  discoveredAt: number;
  /** Present when discovery itself failed. */
  error?: string;
}

export type SelectRuntimeResult =
  | { ok: true; selectedRuntimeId: string | null }
  | { ok: false; error: string };

export interface RuntimeSelectionState {
  /** The runtime the user chose, or null when they have chosen none. */
  selectedRuntimeId: string | null;
}

/**
 * Ask the main process what is installed.
 *
 * Read-only by contract. It returns what was found and what the user already
 * had selected; it does not choose, default, or activate anything.
 */
export async function discoverAgentRuntimes(
  opts?: { includeModels?: boolean },
): Promise<RuntimeDiscovery | null> {
  try {
    const res = await window.henryAPI?.discoverAgentRuntimes?.(opts);
    return res ?? null;
  } catch {
    // Discovery is an optional capability: a build without the main-process
    // side must not break the settings panel that asks.
    return null;
  }
}

/** The runtime the user has explicitly chosen, or null. */
export async function getAgentRuntimeSelection(): Promise<string | null> {
  try {
    return (await window.henryAPI?.getAgentRuntimeSelection?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist a runtime choice. The ONLY writer of the selection, and only ever
 * called from a deliberate user action.
 *
 * An empty id clears the selection — "no external runtime" is a choice, and it
 * is the honest state for a user who has not opted in.
 */
export async function selectAgentRuntime(runtimeId: string): Promise<SelectRuntimeResult> {
  try {
    const res = await window.henryAPI?.selectAgentRuntime?.(runtimeId);
    if (res && typeof res === 'object' && 'ok' in res) return res as SelectRuntimeResult;
    return { ok: false, error: 'Runtime selection is unavailable in this build.' };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}