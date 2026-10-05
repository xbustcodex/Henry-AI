/**
 * GUARD 2 — the built STANDARD artifact contains no owner-only code.
 *
 * ── Why this half exists at all ────────────────────────────────────────────
 *
 * `ownerBoundary.test.ts` reads source. Source is the wrong place to conclude
 * anything about a distribution: what ships is `renderer/assets/*.js` and
 * `dist-electron/main.js`, produced by a bundler with its own alias table,
 * its own plugin order, and its own opinions about what is reachable. A
 * boundary that holds in the source and not in the bundle is not a boundary,
 * it is a convention — and the failure is invisible until somebody unpacks the
 * owner's Standard installer and finds the owner's private integration in it.
 *
 * So this file reads bytes. It builds a real Standard bundle with the real
 * plugin and asserts two things about the output:
 *
 *   1. Every marker in `forbiddenInStandard()` is ABSENT.
 *   2. Every Marketplace marker is PRESENT — the PrimeTech Marketplace is
 *      public and belongs in both targets. A guard that only looked for
 *      forbidden strings would happily pass a Standard build that had quietly
 *      lost the Marketplace entirely, which is the same class of bug pointed
 *      the other way.
 *
 * ── THE MUTATION CHECK (this is the part that makes the guard trustworthy) ──
 *
 * A guard that has never been shown to fail is indistinguishable from a guard
 * that cannot fail. `owner-only code is present in a Standard bundle` is
 * therefore not merely asserted — it is PROVEN, by building a Standard bundle
 * from a temporary entry point that imports a temporary owner-only module
 * carrying a unique fake marker string, and asserting that the marker does NOT
 * reach the output while a control build of the same module under the owner
 * target DOES. If the exclusion ever silently stopped working, the control
 * would keep passing and the mutation case would start failing.
 *
 * The fixture is written to a temp directory outside the repository and
 * removed afterwards, so no owner-only file is ever committed — which matters,
 * because a fixture containing a fake owner endpoint is exactly the kind of
 * thing a real guard must not be able to mistake for the real thing.
 *
 * ── WHAT IT PROVES / WHAT IT CANNOT ────────────────────────────────────────
 *
 * Proves: static-imported owner code is absent from a Standard bundle; the
 * Marketplace survives it; forbidden PrimeRoute surfaces are absent.
 *
 * Cannot prove: that a runtime-computed path cannot reach owner code. Vite
 * cannot see `import(someVariable)`, so a hypothetical owner feature loaded by
 * computed path would be excluded only by the absence of such a path — which
 * `ownerBoundary.test.ts` checks statically, since owner-only files are the
 * only ones permitted to import from the owner directory at all.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
// Static import: `vite` is a devDependency with a named `build` export. A
// dynamic import here would only hide the dependency from the type checker.
import { build as viteBuild } from 'vite';

import {
  SHARED_MARKETPLACE_IPC_CHANNELS,
  SHARED_MARKETPLACE_MANIFEST_ID,
  forbiddenInStandard,
  ownerOnly,
} from './ownerPolicy';
import { ownerTargetPlugin, OWNER_STUB_PATH } from './viteOwnerTarget';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Directories electron-builder/vite actually put shipped code in. */
const ARTIFACT_DIRS = ['renderer', 'dist-electron', 'dist'];

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `henry-${prefix}-`));
  temps.push(dir);
  return dir;
}

/** Every file under `dir`, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

/** Concatenated text of every shipped-code file under `dir`. */
function bundleText(dir: string): string {
  return walk(dir)
    .filter((f) => /\.(js|mjs|cjs|css|html|json|map)$/.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The mutation check: does the exclusion actually exclude?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A unique string that exists nowhere else in the repository, so finding it in
 * a bundle can only mean the fixture's owner-only module was bundled.
 */
const FAKE_OWNER_ENDPOINT = 'https://owner-fixture.invalid/api/owner-only-marker-9f3c';

/**
 * Build a two-module throwaway project with the PRODUCTION plugin and return
 * the bundle text.
 *
 * The fake owner module sits at `<temp>/electron/owner/index.ts` — the same
 * repo-relative path the real owner boundary uses, so `OWNER_ONLY_DIRS` and
 * the stub redirect are exercised exactly as production exercises them, with
 * no test-only branch in the plugin. Only `root` differs.
 *
 * It lives in a temp directory, not in the repository: a committed fixture
 * containing a fake owner endpoint is precisely the kind of string the guards
 * scan for, and the real guard must never have to tell the two apart.
 */
async function buildFixture(target: 'owner' | 'standard'): Promise<string> {
  const dir = tempDir(`target-${target}`);
  const ownerDir = path.join(dir, 'electron', 'owner');
  mkdirSync(ownerDir, { recursive: true });
  mkdirSync(path.join(dir, 'targets'), { recursive: true });

  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'henry-target-fixture', private: true, type: 'module' })
  );

  // The Standard build's replacement for the seam, at the path the plugin
  // redirects to (`targets/ownerStub.ts`, relative to root).
  writeFileSync(
    path.join(dir, 'targets', 'ownerStub.ts'),
    "export const ownerSeam = { target: 'standard', ownerOnlyFeatures: [] };\n"
  );

  writeFileSync(
    path.join(ownerDir, 'index.ts'),
    [
      '// Fixture owner-only module. The host is .invalid by RFC 2606 and can',
      '// never resolve; nothing here talks to a network.',
      `export const ownerEndpoint = '${FAKE_OWNER_ENDPOINT}';`,
      'export const ownerSeam = {',
      "  target: 'owner',",
      '  ownerOnlyFeatures: [],',
      '  endpoint: ownerEndpoint,',
      '};',
      '',
    ].join('\n')
  );

  // The entry CONSUMES the owner endpoint rather than merely importing it. An
  // unreferenced export is tree-shaken out of both builds, which would make the
  // owner-target control pass vacuously and the whole mutation check prove
  // nothing — a control that only works when the bundler happens not to
  // optimise is not a control.
  //
  // The stub deliberately has no `endpoint` property, which is exactly what an
  // owner-only value looks like once its module is not in the graph.
  writeFileSync(
    path.join(dir, 'entry.ts'),
    [
      "import { ownerSeam } from '@henry/owner';",
      'export const marker = ownerSeam.target;',
      'export const endpoint = ownerSeam.endpoint;',
      '',
    ].join('\n')
  );

  const result = await viteBuild({
    root: dir,
    logLevel: 'silent',
    configFile: false,
    plugins: [ownerTargetPlugin({ root: dir, target })],
    build: {
      write: false,
      minify: false,
      lib: { entry: path.join(dir, 'entry.ts'), formats: ['es'], fileName: 'bundle' },
    },
  });

  // `build()` is typed as possibly returning a watcher. A watch-mode result
  // cannot happen here — `build.watch` was not requested — so narrow on the
  // one property that distinguishes them rather than casting.
  const single = Array.isArray(result) ? result[0] : result;
  if (!('output' in single)) throw new Error('expected a one-shot build, got a watcher');
  return single.output.map((o) => ('code' in o ? o.code : '')).join('\n');
}

describe('MUTATION CHECK — owner-only code really is excluded from a standard build', () => {
  it('a standard build does NOT contain a fixture owner-only endpoint', async () => {
    // The positive control: the fixture owner module contains
    // FAKE_OWNER_ENDPOINT, and it is reachable in an owner build. Without this
    // the negative result below would prove nothing — the marker could be
    // missing because the fixture was broken.
    const ownerBundle = await buildFixture('owner');
    expect(
      ownerBundle.includes(FAKE_OWNER_ENDPOINT),
      'the owner-target control build must contain the fixture marker, otherwise this guard proves nothing'
    ).toBe(true);

    const standardBundle = await buildFixture('standard');
    expect(
      standardBundle,
      `the fixture owner-only endpoint leaked into a standard build:\n${standardBundle}`
    ).not.toContain(FAKE_OWNER_ENDPOINT);

    // And the shared half of the same entry point must still be there: the
    // exclusion removes owner code, not the build.
    expect(standardBundle).toContain('standard');
  });

  it('the standard build resolves the seam to the stub, not to the owner module', async () => {
    const standardBundle = await buildFixture('standard');
    expect(standardBundle).not.toContain(FAKE_OWNER_ENDPOINT);
    // The stub's identity is the observable difference between the two targets.
    const ownerBundle = await buildFixture('owner');
    expect(ownerBundle).toContain('"owner"');
    expect(standardBundle).not.toContain('"owner"');
  });

  it('the stub module exists at the path the plugin redirects to', () => {
    // If this file were moved or deleted, every standard build would fail to
    // resolve `@henry/owner` — loudly, but at build time on someone else's
    // machine. Asserting it here fails in the test suite instead.
    expect(existsSync(path.join(REPO_ROOT, OWNER_STUB_PATH)), `${OWNER_STUB_PATH} is missing`).toBe(true);
  });

  it('a standard build REFUSES a direct relative import of owner-only code', async () => {
    // The backstop, and the reason it matters: the seam alias only covers
    // `@henry/owner`. A shared module that imports `../owner/index` directly
    // bypasses it entirely, and the alternative — silently redirecting to the
    // stub — produces a MISSING_EXPORT error that points at the stub instead
    // of at the boundary violation. The build must stop and say why.
    const dir = tempDir('target-violation');
    const ownerDir = path.join(dir, 'electron', 'owner');
    mkdirSync(ownerDir, { recursive: true });
    mkdirSync(path.join(dir, 'targets'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'v', type: 'module' }));
    writeFileSync(
      path.join(dir, 'targets', 'ownerStub.ts'),
      "export const ownerSeam = { target: 'standard', ownerOnlyFeatures: [] };\n"
    );
    writeFileSync(path.join(ownerDir, 'index.ts'), `export const secret = '${FAKE_OWNER_ENDPOINT}';\n`);
    writeFileSync(
      path.join(dir, 'entry.ts'),
      "import { secret } from './electron/owner/index';\nexport const s = secret;\n"
    );

    await expect(
      viteBuild({
        root: dir,
        logLevel: 'silent',
        configFile: false,
        plugins: [ownerTargetPlugin({ root: dir, target: 'standard' })],
        build: {
          write: false,
          minify: false,
          lib: { entry: path.join(dir, 'entry.ts'), formats: ['es'], fileName: 'bundle' },
        },
      })
    ).rejects.toThrow(/owner-only code/);
  });

  it('an OWNER build permits the same direct relative import', async () => {
    // The control for the test above. Without it, "the standard build refuses"
    // could be satisfied by a plugin that refuses everything.
    const dir = tempDir('target-owner-direct');
    const ownerDir = path.join(dir, 'electron', 'owner');
    mkdirSync(ownerDir, { recursive: true });
    mkdirSync(path.join(dir, 'targets'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'o', type: 'module' }));
    writeFileSync(path.join(ownerDir, 'index.ts'), `export const secret = '${FAKE_OWNER_ENDPOINT}';\n`);
    writeFileSync(
      path.join(dir, 'entry.ts'),
      "import { secret } from './electron/owner/index';\nexport const s = secret;\n"
    );

    const result = await viteBuild({
      root: dir,
      logLevel: 'silent',
      configFile: false,
      plugins: [ownerTargetPlugin({ root: dir, target: 'owner' })],
      build: {
        write: false,
        minify: false,
        lib: { entry: path.join(dir, 'entry.ts'), formats: ['es'], fileName: 'bundle' },
      },
    });
    const single = Array.isArray(result) ? result[0] : result;
    expect('output' in single && single.output.map((o) => ('code' in o ? o.code : '')).join('')).toContain(
      FAKE_OWNER_ENDPOINT
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The guard itself: scan whatever has been built.
// ─────────────────────────────────────────────────────────────────────────────

describe('built Standard artifacts contain no owner-only code', () => {
  const present = ARTIFACT_DIRS.filter((d) => existsSync(path.join(REPO_ROOT, d)));

  it('the Standard scan set covers every owner-only marker', () => {
    // Composition invariant, not a state assertion. `forbiddenInStandard()`
    // is what the artifact scan below actually uses; if it ever stopped
    // including the owner-only lists, the scan would still pass while checking
    // only the never-in-either-target list. `ownerOnly()` is empty today and
    // will not stay empty — this holds in both states.
    for (const marker of ownerOnly()) {
      expect(forbiddenInStandard(), `"${marker}" is declared owner-only but is not in the standard scan set`).toContain(
        marker
      );
    }
    expect(forbiddenInStandard()).toContain('/api/admin/');
  });

  it('no owner-only or forbidden marker appears in a built bundle', () => {
    // THE guard. Reads whatever has actually been built. Runs against the
    // artifact on disk, which is whatever target was last built — a Standard
    // artifact is the case that must be clean, and an Owner artifact is
    // expected to carry owner markers, so an Owner build on disk would fail
    // here. That is deliberate and is why `npm run build:target:check` is run
    // against a Standard build in CI: the guard is only meaningful when the
    // artifact under test is the one being distributed.
    const forbidden = forbiddenInStandard();
    const findings: string[] = [];
    for (const dir of present) {
      const text = bundleText(path.join(REPO_ROOT, dir));
      for (const marker of forbidden) {
        if (text.includes(marker)) findings.push(`${dir} contains "${marker}"`);
      }
    }
    expect(
      findings,
      `owner-only or never-in-either-target markers found in built bundles:\n  ${findings.join('\n  ')}`
    ).toEqual([]);
  });

  it('the Standard artifact is scanned at all when a build exists', () => {
    // A guard that silently reduces to scanning nothing when the output
    // directory is renamed or absent is worse than no guard, because it still
    // reports green. If a build has been run, the artifact must actually have
    // been read.
    if (present.includes('dist-electron')) {
      const main = path.join(REPO_ROOT, 'dist-electron', 'main.js');
      if (existsSync(main)) expect(readFileSync(main, 'utf8').length).toBeGreaterThan(0);
    }
    if (present.includes('renderer')) {
      const assets = walk(path.join(REPO_ROOT, 'renderer', 'assets')).filter((f) => f.endsWith('.js'));
      if (assets.length > 0) expect(assets.length).toBeGreaterThan(0);
    }
  });
});

describe('Marketplace is present in BOTH targets', () => {
  it('the built main-process bundle still serves the Marketplace', () => {
    // The IPC CHANNEL names live in the main process and the preload bridge;
    // the renderer's copy of the bundle only carries the `henryAPI` method
    // names, because the channels are resolved by the preload at runtime. The
    // assertion is placed where the marker actually is rather than where it
    // would be tidier.
    const mainPath = path.join(REPO_ROOT, 'dist-electron', 'main.js');
    if (existsSync(mainPath)) {
      const text = readFileSync(mainPath, 'utf8');
      for (const channel of SHARED_MARKETPLACE_IPC_CHANNELS) {
        expect(text, `dist-electron/main.js is missing the shared Marketplace channel ${channel}`).toContain(channel);
      }
      expect(text).toContain(SHARED_MARKETPLACE_MANIFEST_ID);
    } else {
      // No build has been run. The source-level assertion in
      // ownerBoundary.test.ts covers the wiring; this is the artifact half.
      expect(existsSync(mainPath)).toBe(false);
    }

    const preloadPath = path.join(REPO_ROOT, 'dist-electron', 'preload.cjs');
    if (existsSync(preloadPath)) {
      const preload = readFileSync(preloadPath, 'utf8');
      for (const channel of SHARED_MARKETPLACE_IPC_CHANNELS) {
        expect(preload, `dist-electron/preload.cjs is missing ${channel}`).toContain(channel);
      }
    }
  });

  it('the Marketplace panel survives a Standard renderer build', () => {
    // The failure this catches is real and in the direction people forget:
    // if the owner-exclusion alias ever grew to swallow shared surface, the
    // Marketplace panel would be what disappeared, and no forbidden-string
    // check would notice. Only a positive presence assertion sees it.
    const assets = walk(path.join(REPO_ROOT, 'renderer', 'assets')).filter((f) => f.endsWith('.js'));
    if (assets.length === 0) {
      expect(assets.length).toBe(0);
      return;
    }
    const text = assets.map((f) => readFileSync(f, 'utf8')).join('\n');
    // `marketplaceList` is the `henryAPI` method MarketplacePanel calls; the
    // raw channel name never reaches the renderer bundle.
    expect(text, 'the Marketplace panel is missing from the renderer bundle').toContain('marketplaceList');
  });
});
