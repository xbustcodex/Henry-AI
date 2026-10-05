/**
 * Each adapter reports UNAVAILABLE when its binary is absent — and available
 * when it is not, without ever faking either.
 *
 * The failure this guards is specific and has happened before in this codebase:
 * a detection routine that reports "installed" on the strength of a hopeful
 * default, or that caches a positive answer from a machine where the software
 * was present. Discovery exists so the user can be told the truth about their
 * own machine, so a probe that cannot distinguish "found" from "assumed" is
 * worse than no probe at all.
 *
 * `execFile` is stubbed rather than the whole adapter, so the real candidate
 * list, the real version parsing and the real reason strings are all exercised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A callback-style `execFile` double that answers only the binaries a test names.
 *
 * Two details are load-bearing, and getting either wrong makes every probe
 * report "not installed" for reasons that have nothing to do with the code
 * under test:
 *
 *  - **Callback style.** The adapters call `promisify(execFile)`, which settles
 *    only when a callback fires. A promise-returning double just hangs.
 *  - **One success value.** `promisify` resolves the FIRST value after the
 *    error, so this delivers the whole `{ stdout, stderr }` object as that one
 *    value — which is what Node's own `promisify.custom` on `execFile` achieves.
 *    Handing back a bare string makes the adapters destructure `stdout` off a
 *    string, and every probe then silently reports the runtime absent.
 */
function stubExecFile(
  respond: (bin: string, args: string[]) => { stdout: string } | Error,
) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const impl = (
    bin: string,
    args: string[],
    optsOrCb: unknown,
    maybeCb?: unknown,
  ): void => {
    calls.push({ bin, args });
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as
      | ((err: Error | null, result?: { stdout: string; stderr: string }) => void)
      | undefined;
    const answer = respond(bin, args);
    if (answer instanceof Error) cb?.(answer);
    else cb?.(null, { stdout: answer.stdout, stderr: '' });
  };
  return Object.assign(impl, { calls });
}

/** Answers `--version` for exactly the binaries named here; errors on the rest. */
function stubInstalled(binaries: Record<string, string>) {
  return stubExecFile((bin, args) => {
    const version = binaries[bin];
    if (version === undefined) return new Error(`ENOENT: ${bin}`);
    // Every candidate is asked for its version; anything else is a bug here.
    expect(args).toEqual(['--version']);
    return { stdout: `${version}\n` };
  });
}

async function loadAdapter(modulePath: './omp' | './pi', execFileImpl: unknown) {
  vi.resetModules();
  vi.doMock('child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('child_process')>()),
    execFile: execFileImpl,
  }));
  return import(modulePath);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('child_process');
  vi.resetModules();
});

describe('the omp adapter probe', () => {
  it('reports unavailable, with a reason, when no candidate answers', async () => {
    const mod = await loadAdapter('./omp', stubInstalled({}));

    const probe = await mod.probeOmp();
    expect(probe.id).toBe('omp');
    // A reason the user can act on, not a bare false.
    expect(probe.unavailableReason).toBeTruthy();
    expect(probe.unavailableReason).toMatch(/not found/i);
  });

  it('claims no capability at all when the binary is absent', async () => {
    const mod = await loadAdapter('./omp', stubInstalled({}));

    const probe = await mod.probeOmp();

    // The dangerous state is a runtime that is absent yet reports it can run.
    expect(probe.capabilities.run.verified).toBe(false);
    expect(probe.capabilities.listModels.verified).toBe(false);
    expect(probe.capabilities.modelCount).toBeUndefined();
  });

  it('reports the binary and version verbatim when one does answer', async () => {
    // The product installs under either name; the vendor's own Windows bundle
    // ships omp.exe. Only the second candidate answers here.
    const mod = await loadAdapter('./omp', stubInstalled({ omp: '18.3.2' }));

    const probe = await mod.probeOmp();

    expect(probe.available).toBe(true);
    expect(probe.binaryPath).toBe('omp');
    expect(probe.version).toBe('18.3.2');
    expect(probe.capabilities.run.verified).toBe(true);
    expect(probe.capabilities.listModels.verified).toBe(true);
  });

  it('probes both binary names, so an omp-only install is still found', async () => {
    const execFile = stubInstalled({});
    const mod = await loadAdapter('./omp', execFile);

    await mod.probeOmp();

    const probed = execFile.calls.map((c) => c.bin);
    expect(probed.some((b) => b.includes('opencode'))).toBe(true);
    expect(probed.some((b) => b.includes('omp'))).toBe(true);
  });

  it('re-probes every call rather than caching a previous answer', async () => {
    // Software is installed and uninstalled between two discovery calls. A
    // cached "available: true" would report a runtime the user just removed.
    let installed = true;
    const execFile = stubExecFile((bin) => {
      // Answer only the bare `opencode` name while "installed".
      if (installed && bin === 'opencode') return { stdout: '18.3.2\n' };
      return new Error('ENOENT');
    });
    const mod = await loadAdapter('./omp', execFile);

    expect((await mod.probeOmp()).available).toBe(true);
    installed = false;
    expect((await mod.probeOmp()).available).toBe(false);
  });

  it('reports a failure to even start the binary as unavailable', async () => {
    // Every candidate throwing for any reason is still "not installed as far as
    // discovery can tell", and must not be reported as working.
    const mod = await loadAdapter('./omp', stubExecFile(() => new Error('EACCES')));

    const probe = await mod.probeOmp();

    expect(probe.available).toBe(false);
    expect(probe.capabilities.run.verified).toBe(false);
  });
});

describe('the pi adapter probe', () => {
  const nothingInstalled = () => stubExecFile(() => new Error('ENOENT'));


  it('reports unavailable when Prime Pi is not installed', async () => {
    // The honest case: on a machine with no `pi` binary, Pi must read as
    // absent — not as available-with-no-models.
    const mod = await loadAdapter('./pi', nothingInstalled());

    const probe = await mod.probePi();

    expect(probe.available).toBe(false);
    expect(probe.id).toBe('pi');
    expect(probe.unavailableReason).toMatch(/not found/i);
  });

  it('names the install command so the user can fix it', async () => {
    const mod = await loadAdapter('./pi', nothingInstalled());

    const probe = await mod.probePi();

    // Verified from the package's own docs: this is the documented install.
    expect(probe.unavailableReason).toContain('@earendil-works/pi-coding-agent');
  });

  it('claims no capability when the binary is absent', async () => {
    const mod = await loadAdapter('./pi', nothingInstalled());

    const probe = await mod.probePi();

    expect(probe.capabilities.run.verified).toBe(false);
    expect(probe.capabilities.listModels.verified).toBe(false);
    expect(probe.capabilities.modelCount).toBeUndefined();
  });

  it('reports the version verbatim when Prime Pi IS installed', async () => {
    // The counterpart, so the tests above are not passing by always returning
    // false: an install that answers must be found.
    const mod = await loadAdapter(
      './pi',
      stubExecFile((bin) =>
        bin === 'pi' ? { stdout: '0.87.1\n' } : new Error('ENOENT'),
      ),
    );

    const probe = await mod.probePi();

    expect(probe.available).toBe(true);
    expect(probe.binaryPath).toBe('pi');
    expect(probe.version).toBe('0.87.1');
  });

  it('declares its credential optional, because Pi has no bearer variable of its own', async () => {
    const mod = await import('./pi');

    // Verified from Pi's own docs: it authenticates per provider in its
    // config directory and honours upstream provider env vars, not one key.
    expect(mod.piAdapter.authHint?.optional).toBe(true);
    expect(mod.piAdapter.authHint?.envVar).toBeUndefined();
  });
});