/**
 * macOS automation bridge (design §2).
 *
 * Every macOS integration — Calendar, Messages send, Mail — runs through
 * `osascript -l JavaScript` (JXA). The single hard rule, enforced everywhere in
 * this module's callers: **user data is passed as environment variables, never
 * string-interpolated into the script body.** The script strings handed to
 * `runJXA` are static constants; anything the model produced (a message body,
 * an event title, an email subject) arrives via `HENRY_*` env vars and is read
 * inside JXA with `$.getenv(...)`. This is the injection defense — a script
 * body can never be reshaped by adversarial tool arguments because the
 * arguments never touch it.
 *
 * osascript is spawned with `execFile` (no shell), so the script string itself
 * is also never subject to shell interpretation.
 */

import { execFile } from "child_process";

const OSASCRIPT = "/usr/bin/osascript";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Mail bodies / long message threads can be sizeable; give stdout room. */
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Raised when osascript exits non-zero, times out, or cannot be spawned.
 * Carries the captured stderr so callers can surface the macOS error verbatim
 * (e.g. "Not authorized to send Apple events to Messages") for a setup prompt.
 */
export class MacOSAutomationError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = "",
    public readonly code: number | null = null,
    public readonly timedOut: boolean = false,
  ) {
    super(message);
    this.name = "MacOSAutomationError";
  }
}

/**
 * Run a JXA script via osascript and resolve with its trimmed stdout.
 *
 * @param script   A **static** JXA script string. The script should read any
 *                 user-supplied values from env vars (`$.getenv('HENRY_…')`)
 *                 and `JSON.stringify(...)` its result as the final expression.
 * @param env      `HENRY_*` values injected into the child's environment. These
 *                 are the only channel for user/model data — see the module
 *                 header.
 * @param timeoutMs Hard kill after this many ms (default 15s).
 * @throws MacOSAutomationError on non-zero exit, timeout, or spawn failure.
 */
export function runJXA(
  script: string,
  env: Record<string, string> = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      OSASCRIPT,
      ["-l", "JavaScript", "-e", script],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        const err = error as
          | (Error & { killed?: boolean; code?: number | null })
          | null;
        if (err) {
          const timedOut = err.killed === true;
          const trimmedErr = (stderr ?? "").trim();
          const message = timedOut
            ? `osascript timed out after ${timeoutMs}ms`
            : `osascript failed${trimmedErr ? `: ${trimmedErr}` : `: ${err.message}`}`;
          reject(
            new MacOSAutomationError(
              message,
              trimmedErr,
              err.code ?? null,
              timedOut,
            ),
          );
          return;
        }
        resolve((stdout ?? "").trim());
      },
    );
  });
}

/**
 * Convenience wrapper: run a JXA script whose final expression is a
 * `JSON.stringify(...)` and return the parsed value. Throws
 * `MacOSAutomationError` if osascript fails or its stdout is not valid JSON
 * (empty stdout resolves to `null`).
 */
export async function runJXAJson<T = unknown>(
  script: string,
  env: Record<string, string> = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const stdout = await runJXA(script, env, timeoutMs);
  if (!stdout) return null as unknown as T;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new MacOSAutomationError(
      `osascript returned non-JSON output: ${stdout.slice(0, 200)}`,
    );
  }
}
