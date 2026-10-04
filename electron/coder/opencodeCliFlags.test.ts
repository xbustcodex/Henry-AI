import { describe, it, expect, vi } from 'vitest';

/**
 * Regression: the OpenCode/Zen CLI invocation used flags the installed binary does not
 * have.
 *
 * Every OpenCode/Zen turn failed at process launch with
 *   `opencode exited with code 2: Error: unknown flags: --format, --dir`
 * so no token was ever requested and the user saw a generic
 * "OpenCode Zen returned an error / Something went wrong". Discovery still worked
 * because it uses a different invocation, which is what made this look like an auth
 * problem rather than a flag mismatch.
 *
 * These tests pin the argument vector against the real CLI's own documented flags.
 */
describe('OpenCode CLI invocation', () => {
  const argvOf = (spawn: { mock: { calls: unknown[] } }) =>
    (spawn.mock.calls as unknown as [string, string[]][])[0][1];

  it('passes --mode and --cwd, never the unsupported --format/--dir', async () => {
    const spawn = vi.fn(() => ({ on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } }));
    vi.resetModules();
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn,
    }));

    const mod = await import('./opencode');
    mod.runOpencode({
      prompt: 'Say hello',
      cwd: '/tmp/work',
      cliPath: 'omp',
      model: 'deepseek-v4-flash-free',
      onEvent: () => {},
    });

    const argv = argvOf(spawn);
    expect(argv).not.toContain('--format');
    expect(argv).not.toContain('--dir');
    expect(argv).toContain('--mode');
    expect(argv).toContain('--cwd');
    expect(argv).toContain('/tmp/work');
    expect(argv.at(-1)).toBe('Say hello');
    vi.doUnmock('node:child_process');
  });

  it('is non-interactive, so the run terminates instead of waiting on a TTY', async () => {
    const spawn = vi.fn(() => ({ on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } }));
    vi.resetModules();
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn,
    }));

    const mod = await import('./opencode');
    mod.runOpencode({ prompt: 'hi', cwd: '/tmp', cliPath: 'omp', onEvent: () => {} });

    const argv = argvOf(spawn);
    expect(argv).toContain('-p');
    vi.doUnmock('node:child_process');
  });

  it('passes the selected model and prompt through to the CLI', async () => {
    const spawn = vi.fn(() => ({ on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } }));
    vi.resetModules();
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn,
    }));

    const mod = await import('./opencode');
    mod.runOpencode({
      prompt: 'Say hello in one short sentence.',
      cwd: '/tmp',
      cliPath: 'omp',
      model: 'hy3-free',
      onEvent: () => {},
    });

    const argv = argvOf(spawn);
    expect(argv).toContain('--model');
    expect(argv).toContain('hy3-free');
    expect(argv).toContain('Say hello in one short sentence.');
    vi.doUnmock('node:child_process');
  });
});

describe('transport errors keep their reason', () => {
  it('extracts the CLI flag error that used to be discarded', async () => {
    const { extractErrorDetail } = await import('../../src/henry/errorMessages');
    const wrapped = new Error(
      "Error invoking remote method 'ai:send': Error: opencode exited with code 2: " +
        'Error: unknown flags: --format, --dir\nRun `omp --help` for available flags.',
    );
    expect(extractErrorDetail(wrapped)).toContain('unknown flags: --format, --dir');
  });

  it('returns empty for an error with no usable message', async () => {
    const { extractErrorDetail } = await import('../../src/henry/errorMessages');
    expect(extractErrorDetail(new Error(''))).toBe('');
    expect(extractErrorDetail(undefined)).toBe('');
  });
});