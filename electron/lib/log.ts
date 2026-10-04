/**
 * Henry AI — main-process logger.
 *
 * `log.debug` only prints when the HENRY_DEBUG env var is set (1/true/yes).
 * Everything else (info/warn/error) always prints. Keep normal startup
 * output to the handful of lines that matter: servers listening, tunnel
 * URLs, real warnings, and errors.
 */

const DEBUG = /^(1|true|yes)$/i.test(process.env.HENRY_DEBUG ?? '');

export function isDebugLogging(): boolean {
  return DEBUG;
}

export const log = {
  /** Chatty/diagnostic output — silent unless HENRY_DEBUG is set. */
  debug: (...args: unknown[]): void => {
    if (DEBUG) console.log(...args);
  },
  /** Meaningful one-liners (server listening, tunnel URL). */
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
