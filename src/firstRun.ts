/**
 * First-run detection — is this a profile that has never been set up?
 *
 * The question used to be answered by "does configuration already exist?",
 * which is why setup was skipped on the machine that developed Henry and could
 * be skipped on a fresh install for the same reason: the answer was read from
 * state a fresh install does not have yet, rather than from a marker the flow
 * itself writes when it finishes.
 *
 * So the rule here is deliberately narrow. A profile is fresh only when EVERY
 * signal says nothing has been set up. Any single piece of real user
 * configuration — a completed setup, a first-contact flag, a provider the user
 * actually put a credential into, a conversation, a workspace — means this is
 * somebody's own profile, and the correct behaviour is to leave it alone.
 *
 * This module is pure. It takes the signals as arguments and returns the
 * verdict, so both the renderer gate and the tests exercise the same decision
 * without a DOM or a database.
 */

/** localStorage marker written only after the first-launch flow completes. */
export const FIRST_RUN_KEY = 'henry:first_run_complete';

/** The SQLite setting that mirrors {@link FIRST_RUN_KEY} across profiles. */
export const FIRST_RUN_SETTING = 'first_run_complete';

export interface ProviderSignal {
  id?: string;
  apiKey?: string;
  api_key?: string;
  enabled?: boolean | number;
}

/** Everything the verdict is derived from. All of it is read, never written. */
export interface FirstRunSignals {
  /** Raw value of {@link FIRST_RUN_KEY} in localStorage, if present. */
  marker?: string | null;
  /** The SQLite settings map, as `getSettings()` returns it. */
  settings?: Record<string, string> | null;
  /** Provider rows, as `getProviders()` returns them. */
  providers?: readonly ProviderSignal[] | null;
  /** Conversation rows; a profile with any is a profile that has been used. */
  conversations?: readonly unknown[] | null;
  /** Whether a workspace manifest exists for this profile. */
  workspacePresent?: boolean;
}

/** Settings whose presence means the user has already been through setup. */
const SETUP_ALREADY_DONE = 'setup_complete';
/** Set the moment Henry first speaks to a configured user. */
const FIRST_CONTACT_FLAG = 'henry_first_launch';

function hasCredential(provider: ProviderSignal): boolean {
  const key = provider.apiKey ?? provider.api_key ?? '';
  return typeof key === 'string' && key.trim().length > 0;
}

/**
 * True when nothing about this profile indicates it has ever been configured.
 *
 * Note what is NOT a signal: a default theme row, a blank model row, a
 * `setup_complete` row that says `'false'`, or a settings map that merely has
 * keys in it. Those are defaults, not decisions, and a fresh database must not
 * be able to answer "already set up" by existing at all.
 */
export function isFreshProfile(signals: FirstRunSignals): boolean {
  if ((signals.marker ?? '').trim() !== '') return false;

  const settings = signals.settings ?? {};
  if ((settings[FIRST_RUN_SETTING] ?? '').trim() !== '') return false;
  if ((settings[SETUP_ALREADY_DONE] ?? '').trim() === 'true') return false;
  if (Object.prototype.hasOwnProperty.call(settings, FIRST_CONTACT_FLAG)) return false;

  if ((signals.providers ?? []).some(hasCredential)) return false;

  if ((signals.conversations ?? []).length > 0) return false;
  if (signals.workspacePresent) return false;

  return true;
}

export interface GateInput {
  /** Verdict from {@link isFreshProfile}. */
  fresh: boolean;
  /** True once the flow has run in this session, so Back-to-app stays put. */
  completedThisSession: boolean;
}

/**
 * Whether the app should put the first-launch flow in front of the user.
 *
 * A profile that is already configured is never re-gated, however fresh the
 * marker looks — re-running setup would be a way to silently rewrite somebody's
 * working configuration.
 */
export function shouldGateOnSetup({ fresh, completedThisSession }: GateInput): boolean {
  return fresh && !completedThisSession;
}

/** The slice of the preload bridge this module needs. */
interface FirstRunBridge {
  saveSetting?: (key: string, value: string) => Promise<unknown>;
}

function bridge(): FirstRunBridge | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window.henryAPI as unknown as FirstRunBridge | undefined);
}


/**
 * Record that the first-launch flow finished.
 *
 * The localStorage write is synchronous because the very next render reads it;
 * the database write is fire-and-forget because losing it costs one extra
 * wizard run, not correctness.
 */
export function markFirstRunComplete(): void {
  try { localStorage.setItem(FIRST_RUN_KEY, 'true'); } catch { /* private mode */ }
  try { void bridge()?.saveSetting?.(FIRST_RUN_SETTING, 'true'); } catch { /* best effort */ }
}

/** Forget the marker — used when the user explicitly reopens setup. */
export function clearFirstRunMarker(): void {
  try { localStorage.removeItem(FIRST_RUN_KEY); } catch { /* private mode */ }
}