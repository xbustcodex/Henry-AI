/**
 * Henry AI — renderer logger.
 *
 * `log.debug` only prints when debug logging is enabled:
 *   - localStorage 'henry:debug_logging' === '1'  (toggle at runtime), or
 *   - VITE_HENRY_DEBUG=1 at build/dev time.
 *
 * info/warn/error always print. Never log per-message / per-chunk spam,
 * and never log secrets or full prompts — even at debug level.
 */

export function isDebugLogging(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('henry:debug_logging') === '1') return true;
  } catch {
    /* localStorage unavailable (e.g. tests) */
  }
  try {
    return (import.meta as { env?: Record<string, string> }).env?.VITE_HENRY_DEBUG === '1';
  } catch {
    return false;
  }
}

export function setDebugLogging(on: boolean): void {
  try {
    if (on) localStorage.setItem('henry:debug_logging', '1');
    else localStorage.removeItem('henry:debug_logging');
  } catch {
    /* ignore */
  }
}

export const log = {
  /** Chatty/diagnostic output — silent unless debug logging is enabled. */
  debug: (...args: unknown[]): void => {
    if (isDebugLogging()) console.log(...args);
  },
  info: (...args: unknown[]): void => {
    console.log(...args);
  },
  warn: (...args: unknown[]): void => {
    console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
};
