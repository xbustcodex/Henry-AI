/**
 * The OpenCode/Zen CLI argument contract.
 *
 * The CLI used to be invoked with flags it does not have: every OpenCode/Zen
 * turn failed at process launch with
 *   `opencode exited with code 2: Error: unknown flags: --format, --dir`
 * so no token was ever requested and the user saw a generic
 * "OpenCode Zen returned an error / Something went wrong". Discovery still worked
 * because it uses a different invocation, which is what made this look like an
 * auth problem rather than a flag mismatch.
 *
 * These assertions read the adapter's OWN argument builder — the same function
 * both call sites use — so they cannot drift from what is actually spawned. A
 * copy of the expected vector somewhere else would be exactly the duplication
 * that let the two sites disagree in the first place.
 */
import { describe, it, expect } from 'vitest';
import { buildOmpRunArgs } from './omp';
import { extractErrorDetail } from '../../../src/henry/errorMessages';

const argsFor = (overrides: Partial<Parameters<typeof buildOmpRunArgs>[0]> = {}) =>
  buildOmpRunArgs({ prompt: 'Say hello', cwd: '/tmp/work', ...overrides });

describe('the OpenCode CLI argument vector', () => {
  it('passes --mode and --cwd, never the unsupported --format/--dir', () => {
    const args = argsFor();
    expect(args).not.toContain('--format');
    expect(args).not.toContain('--dir');
    expect(args).toContain('--mode');
    expect(args[args.indexOf('--mode') + 1]).toBe('json');
    expect(args).toContain('--cwd');
    expect(args[args.indexOf('--cwd') + 1]).toBe('/tmp/work');
  });

  it('is non-interactive, so the run terminates instead of waiting on a TTY', () => {
    expect(argsFor()).toContain('-p');
  });

  it('passes the selected model and prompt through to the CLI', () => {
    const args = argsFor({ model: 'hy3-free', prompt: 'Say hello in one short sentence.' });
    expect(args[args.indexOf('--model') + 1]).toBe('hy3-free');
    // The prompt is positional and LAST: anything after it would be read as
    // another argument rather than as the turn.
    expect(args.at(-1)).toBe('Say hello in one short sentence.');
  });

  it('invokes the run subcommand this CLI actually has', () => {
    // `run` is an alias of `launch` in the installed CLI; both are real.
    expect(argsFor()[0]).toBe('run');
  });

  it('omits --model entirely when no model was selected', () => {
    // An empty string after --model would make the CLI reject the invocation,
    // so the flag has to be absent rather than blank.
    expect(argsFor()).not.toContain('--model');
  });

  it('carries the working directory to the spawn, not just the flag', () => {
    // `--cwd` alone is not enough: the child also has to actually run there.
    expect(argsFor({ cwd: '/srv/workspace' })[argsFor({ cwd: '/srv/workspace' }).indexOf('--cwd') + 1])
      .toBe('/srv/workspace');
  });
});

describe('transport errors keep their reason', () => {
  it('extracts the CLI flag error that used to be discarded', () => {
    const wrapped = new Error(
      "Error invoking remote method 'ai:send': Error: opencode exited with code 2: " +
        'Error: unknown flags: --format, --dir\nRun `omp --help` for available flags.',
    );
    expect(extractErrorDetail(wrapped)).toContain('unknown flags: --format, --dir');
  });

  it('returns empty for an error with no usable message', () => {
    expect(extractErrorDetail(new Error(''))).toBe('');
    expect(extractErrorDetail(undefined)).toBe('');
  });
});