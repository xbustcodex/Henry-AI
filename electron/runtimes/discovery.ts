/**
 * Runtime discovery — what is actually installed on this machine.
 *
 * ── The invariant this module exists to hold ───────────────────────────────
 *
 * **Discovery is read-only. It never changes what the user has selected.**
 *
 * Not "it prefers not to". It has no write path at all: this module takes a
 * `SelectionReader`, not a settings handle, and the only thing it does with a
 * selection is read it and hand it back so the caller can render it. There is no
 * code here that could set a default, activate a runtime, or migrate a
 * selection, because there is no writer to call. `agentRuntimesSelectionIsNotMutated`
 * in discovery.test.ts asserts this against a real settings store, not against a
 * mock that agrees.
 *
 * The consequence is a deliberate one: a user who has never chosen a runtime
 * keeps having no runtime selected, even on a machine where one is installed and
 * working. Choosing is theirs to make, and the panel in Settings is where they
 * make it.
 *
 * ── What is reported ───────────────────────────────────────────────────────
 *
 * Every registered runtime appears in the result — installed or not. A runtime
 * that is absent is reported as `available: false` with a reason, never omitted
 * (omission would read as "we never looked") and never faked as present.
 * Capability flags are only ever `verified: true` where this machine actually
 * demonstrated them, and a `modelCount` appears only when `--list-models` (or
 * whatever that runtime's own listing command is) really ran and really
 * returned a list.
 */

import { listRuntimeAdapters } from './registry';
import type { AgentRuntimeAdapter, RuntimeProbe } from './types';

/** Reads the user's stored selection. Cannot write — that is the point. */
export interface SelectionReader {
  /** The runtime id the user explicitly chose, or null when they chose none. */
  readSelectedRuntimeId(): string | null | Promise<string | null>;
}

/** What discovery found, per runtime. */
export interface RuntimeDiscoveryEntry extends RuntimeProbe {
  /** Where the runtime keeps its own configuration, when it has one. */
  configDirHint?: string;
  /** Auth material the runtime needs, by NAME only. Never a value. */
  authHint?: { envVar?: string; optional: boolean };
  description?: string;
  /** Model ids the runtime can reach. Only present when listing was requested and succeeded. */
  models?: string[];
}

export interface RuntimeDiscoveryResult {
  /** Every registered runtime, installed or not. Nothing is dropped. */
  runtimes: RuntimeDiscoveryEntry[];
  /** The ids of the runtimes that are genuinely installed here. */
  installedRuntimeIds: string[];
  /**
   * The stored selection, read and echoed back unchanged. Discovery did not
   * choose this and did not alter it.
   */
  selectedRuntimeId: string | null;
  /** When this discovery ran. */
  discoveredAt: number;
}

export interface DiscoverOptions {
  /**
   * Ask each installed runtime to actually list its models, so `modelCount` and
   * `models` reflect an observation rather than an assumption.
   *
   * Off by default: listing models can take tens of seconds per runtime and
   * reach the network, which is too much to do on every render of a settings
   * panel.
   */
  includeModels?: boolean;
  /** Bound per runtime. Listing is the slow step. */
  timeoutMs?: number;
}

/** Defaults for the slow path. Generous because catalogue refreshes are slow. */
const MODEL_LIST_TIMEOUT_MS = 60_000;

/**
 * Probe one adapter and shape its answer for the renderer.
 *
 * `includeModels` is what separates "this runtime is installed" from "this
 * runtime demonstrably has N models reachable". Without it, no model count is
 * reported at all — an absent number is honest, a guessed one is not.
 */
async function discoverOne(
  adapter: AgentRuntimeAdapter,
  options: DiscoverOptions,
): Promise<RuntimeDiscoveryEntry> {
  const entry: RuntimeDiscoveryEntry = {
    id: adapter.id,
    displayName: adapter.displayName,
    available: false,
    capabilities: {
      run: { verified: false, note: 'Not probed.' },
      listModels: { verified: false, note: 'Not probed.' },
    },
  };
  if (adapter.description) entry.description = adapter.description;
  if (adapter.authHint) entry.authHint = adapter.authHint;

  let probe: RuntimeProbe;
  try {
    probe = await adapter.probe();
  } catch (e: unknown) {
    // A probe that throws is a runtime that could not be interrogated. That is
    // "unknown", not "available" — say so rather than dropping the runtime.
    const reason = e instanceof Error ? e.message : String(e);
    entry.unavailableReason = reason;
    entry.capabilities = {
      run: { verified: false, note: reason },
      listModels: { verified: false, note: reason },
    };
    return entry;
  }

  entry.available = probe.available;
  entry.capabilities = probe.capabilities;
  if (probe.binaryPath) entry.binaryPath = probe.binaryPath;
  if (probe.version) entry.version = probe.version;
  if (probe.unavailableReason) entry.unavailableReason = probe.unavailableReason;

  if (!probe.available || !options.includeModels) return entry;

  try {
    const models = await withTimeout(
      adapter.listModels(),
      options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS,
      `${adapter.displayName} did not list its models in time.`,
    );
    entry.models = models.map((m) => m.id);
    // A real count from a real listing. This is the only path that sets it.
    entry.capabilities = {
      ...entry.capabilities,
      listModels: { verified: true },
    };
    (entry.capabilities as { modelCount?: number }).modelCount = models.length;
  } catch (e: unknown) {
    // Listing failed. That downgrades the capability to unverified and says
    // why; it does not make the runtime unavailable, because it IS installed.
    const reason = e instanceof Error ? e.message : String(e);
    entry.capabilities = {
      ...entry.capabilities,
      listModels: { verified: false, note: reason },
    };
  }
  return entry;
}

/**
 * Probe every registered adapter.
 *
 * Read-only with respect to everything the user has configured: it reads the
 * stored selection and returns it, and there is no code path here that writes.
 */
export async function discoverRuntimes(
  selection: SelectionReader,
  options: DiscoverOptions = {},
): Promise<RuntimeDiscoveryResult> {
  const adapters = listRuntimeAdapters();
  const runtimes = await Promise.all(adapters.map((a) => discoverOne(a, options)));
  return {
    runtimes,
    installedRuntimeIds: runtimes.filter((r) => r.available).map((r) => r.id),
    // Read once, echoed back. Not chosen here, not altered here.
    selectedRuntimeId: (await selection.readSelectedRuntimeId()) ?? null,
    discoveredAt: Date.now(),
  };
}

/**
 * Reject if a promise has not settled in time.
 *
 * The timer is unref'd so a slow runtime's timeout never holds the process open
 * on its own — this runs inside the main process.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}