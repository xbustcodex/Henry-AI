/**
 * The runtime registry — the one list of agent runtimes Henry knows about.
 *
 * Registering an adapter here is the ONLY step needed to make a new runtime
 * discoverable. Discovery iterates this registry; the renderer renders whatever
 * it finds; selecting one persists a string. No chat, routing, provider or
 * settings module has to change, which is the whole point of the abstraction:
 * a runtime is an implementation detail behind `AgentRuntimeAdapter`, never a
 * branch in Henry's core.
 *
 * The registry holds adapters, not state. It never records what was found and
 * never records what the user chose.
 */

import type { AgentRuntimeAdapter } from './types';
import { ompAdapter } from './adapters/omp';
import { piAdapter } from './adapters/pi';

/** Every adapter Henry ships with, in the order they are offered. */
const BUILT_IN_ADAPTERS: readonly AgentRuntimeAdapter[] = [ompAdapter, piAdapter];

let registered: AgentRuntimeAdapter[] = [...BUILT_IN_ADAPTERS];

/**
 * Runtime identities Henry reserves for software that is still being built.
 *
 * A reserved id is a NAME ONLY. It is deliberately not an adapter and has no probe,
 * because a probe would mean inventing an executable contract for software that does not
 * exist yet — and a runtime with a wrong probe reports false negatives today, or worse,
 * false positives if the guessed path ever happens to exist.
 *
 * Because these are not adapters, discovery cannot report them as installed and the picker
 * cannot offer them. That is the correct behaviour: Henry must never claim software is
 * present when it is not. When the real product ships, adding an adapter here is the ONLY
 * step needed — this entry should be removed in the same change.
 *
 * Prime Harness Agent is being built separately by the owner. Henry recognises the name
 * and nothing more: no design, no API, no ports, no protocol, no workers, no commands.
 */
export const RESERVED_RUNTIME_IDS: readonly string[] = ['prime-harness-agent'];

/** Human-readable names for reserved runtimes, for display in future UI. */
export const RESERVED_RUNTIME_NAMES: Readonly<Record<string, string>> = {
  'prime-harness-agent': 'Prime Harness Agent',
};

/**
 * Whether an id is reserved for a runtime that does not exist yet.
 *
 * A reserved id must never be selected as a working runtime: there is no adapter behind it,
 * so nothing could execute.
 */
export function isReservedRuntimeId(id: string): boolean {
  return RESERVED_RUNTIME_IDS.includes(id);
}

/**
 * Register a runtime adapter.
 *
 * Re-registering an id replaces the previous adapter rather than adding a
 * duplicate, so a later registration (a test fixture, or a future plugin) cannot
 * make discovery report the same runtime twice.
 */
export function registerRuntimeAdapter(adapter: AgentRuntimeAdapter): void {
  const existing = registered.findIndex((a) => a.id === adapter.id);
  if (existing >= 0) {
    registered = [...registered.slice(0, existing), adapter, ...registered.slice(existing + 1)];
    return;
  }
  registered = [...registered, adapter];
}

/** Remove a runtime adapter by id. Used to undo a registration. */
export function unregisterRuntimeAdapter(id: string): void {
  registered = registered.filter((a) => a.id !== id);
}

/** Restore the shipped set. Used by tests to undo registrations. */
export function resetRuntimeRegistry(): void {
  registered = [...BUILT_IN_ADAPTERS];
}

/** Every registered adapter, in registration order. */
export function listRuntimeAdapters(): readonly AgentRuntimeAdapter[] {
  return registered;
}

/** One adapter by id, or undefined when the id is not registered. */
export function getRuntimeAdapter(id: string): AgentRuntimeAdapter | undefined {
  return registered.find((a) => a.id === id);
}

/**
 * Legacy coder-engine setting values, mapped to the runtime that serves them.
 *
 * The `coder_engine` setting predates the adapter layer and stores `'opencode'`.
 * That value is a persisted user choice, so it cannot be renamed without
 * invalidating everyone's saved selection — but WHICH RUNTIME it means is
 * adapter knowledge, and it belongs here rather than in the coder engine. A new
 * runtime that should be reachable from that setting is registered here and
 * nowhere else.
 */
const LEGACY_ENGINE_RUNTIMES: Record<string, string> = {
  opencode: 'omp',
};

/**
 * The runtime a legacy coder-engine setting refers to, or undefined when the
 * value does not name a runtime (Claude Code and the local engine are not
 * adapter-backed).
 */
export function runtimeForLegacyEngineSetting(value: string): AgentRuntimeAdapter | undefined {
  const id = LEGACY_ENGINE_RUNTIMES[value];
  return id ? getRuntimeAdapter(id) : undefined;
}

/** Every legacy setting value that maps to a registered runtime. */
export function legacyEngineSettingsForRuntimes(): string[] {
  return Object.keys(LEGACY_ENGINE_RUNTIMES).filter((key) => getRuntimeAdapter(LEGACY_ENGINE_RUNTIMES[key]));
}