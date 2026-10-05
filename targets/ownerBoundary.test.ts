/**
 * GUARD 1 — the Owner/Standard boundary holds in the SOURCE tree.
 *
 * ── What this guards and why it is not covered elsewhere ───────────────────
 *
 * Every behavioural test in this suite exercises the running app. Nothing that
 * runs can observe a leak here: owner-only code does not misbehave, it is
 * simply present in an artifact nobody should have received, and a Standard
 * build that quietly contains the owner's private PrimeTech integration
 * behaves identically to a clean one until somebody reads the bundle.
 *
 * So these assertions read the repository's own source, in the same spirit as
 * `electron/runtimes/architecture.test.ts` (which is why they are
 * deliberately source-level) and `src/henry/releaseRouting.test.ts`.
 *
 * The failure mode this architecture actually degrades into is not "someone
 * writes owner code in the wrong file" — it is the quiet drift: a shared module
 * imports one owner-only file "just this once", then another, then somebody
 * adds `if (target === 'owner')` in chat because the registry felt like the
 * wrong place. Nothing breaks. The coupling creeps back one import at a time
 * and the Standard build quietly stops being standard. Every test below exists
 * to make one of those steps fail loudly.
 *
 * WHAT IT PROVES: no shared module imports owner-only code; no shared module
 * branches on the target; the owner seam is the only way in; the Marketplace
 * is not inside the owner boundary.
 *
 * WHAT IT CANNOT PROVE: anything about a built artifact. `standardBundle.test.ts`
 * is the half that reads bytes.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  FORBIDDEN_IN_EVERY_ARTIFACT,
  OWNER_IMPORT_ROOTS,
  OWNER_ONLY_DIRS,
  OWNER_ONLY_RESOURCE_DIRS,
  OWNER_SPECIFIER_MAIN,
  OWNER_SPECIFIER_RENDERER,
  OWNER_SPECIFIER_TARGETS,
  SHARED_MARKETPLACE_SOURCES,
  ownerOnly,
} from './ownerPolicy';

// The real modules, imported rather than read as text. A regex over source
// proves a string is present; importing proves the module behaves, which is
// the only thing a build actually depends on.
import { ownerSeam as realOwnerSeam } from '../electron/owner/index';
import * as realOwnerUi from '../src/owner/index';
import { ownerSeam as stubSeam } from './ownerStub';
import type { OwnerSeam } from './ownerSeamTypes';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Build tooling at the repository root. These files configure the build; they
 * are never bundled into an artifact, so the two rules that apply to shipped
 * code — no import of the policy, no branch on the target — do not apply to
 * them. `vite.config.ts` legitimately reads the target, and must: it is the
 * thing that decides what ships.
 */
const BUILD_TOOLING: readonly string[] = [
  'vite.config.ts',
  'vite.web.config.ts',
  'capacitor.config.ts',
];

/** Every source file that ends up in an artifact, as repo-relative posix paths. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'release2') continue;
    const abs = path.join(dir, entry);
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !entry.endsWith('.d.ts') &&
      !entry.includes('.test.') &&
      !rel.startsWith('targets/') &&
      !BUILD_TOOLING.includes(rel)
    ) {
      out.push(rel);
    }
  }
  return out;
}

const SOURCE_FILES = walk(REPO_ROOT);

/** Is `rel` inside one of the owner-only directories? */
function isOwnerOnly(rel: string): boolean {
  return OWNER_ONLY_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

/** Is `rel` inside `dir`? */
function inside(rel: string, dir: string): boolean {
  return rel === dir || rel.startsWith(`${dir}/`);
}

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/**
 * Static imports and re-exports, as specifier strings.
 *
 * Deliberately a regex over the source rather than a real parse: it has to
 * work on files that only exist in someone's uncommitted branch, and a missing
 * file is not a reason for a guard to pass quietly. `import(` is included
 * because a dynamic import of owner code is the same leak with more steps.
 */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.push(m[1]);
  }
  return found;
}

/** Resolve a relative specifier against the importing file. Repo-relative or null. */
function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(path.join(REPO_ROOT, from)), specifier);
  const candidates = [abs, `${abs}.ts`, `${abs}.tsx`, path.join(abs, 'index.ts'), path.join(abs, 'index.tsx')];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return path.relative(REPO_ROOT, c).split(path.sep).join('/');
  }
  return null;
}

describe('owner-only surface — the boundary is one explicit location', () => {
  it('declares the owner-only directories and they exist in the tree', () => {
    // Each declared directory is real, so "owner-only code lives here" is a
    // navigable fact rather than a convention. An absent directory could not
    // be reviewed and would not survive someone creating it without updating
    // the policy.
    expect(OWNER_ONLY_DIRS).toContain('electron/owner');
    expect(OWNER_ONLY_DIRS).toContain('src/owner');
    for (const dir of OWNER_ONLY_DIRS) {
      expect(existsSync(path.join(REPO_ROOT, dir)), `${dir} is declared owner-only but does not exist`).toBe(true);
    }
  });

  it('the owner seam is the ONLY way to reach owner-only code', () => {
    // Both specifiers resolve to a declared directory, so a seam import can
    // never land somewhere outside the boundary.
    for (const [specifier, dir] of Object.entries(OWNER_SPECIFIER_TARGETS)) {
      expect(OWNER_ONLY_DIRS, `${specifier} resolves to ${dir}, which is not owner-only`).toContain(dir);
    }
  });

  it('no shared module imports an owner-only module', () => {
    const offenders: string[] = [];
    for (const rel of SOURCE_FILES) {
      if (isOwnerOnly(rel)) continue;
      // The seam specifiers are the sanctioned door, including from files that
      // are not entry points — a panel may legitimately ask the seam a question.
      for (const spec of importSpecifiers(read(rel))) {
        if (spec === OWNER_SPECIFIER_MAIN || spec === OWNER_SPECIFIER_RENDERER) continue;
        const resolved = resolveRelative(rel, spec);
        if (resolved && isOwnerOnly(resolved)) offenders.push(`${rel} → ${spec}`);
      }
    }
    expect(
      offenders,
      `Shared code reached into the owner-only boundary directly. Owner-only code is ` +
        `reachable only through ${OWNER_SPECIFIER_MAIN} / ${OWNER_SPECIFIER_RENDERER}, so ` +
        `the bundler can replace it in a standard build:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no shared module branches on the build target', () => {
    // A runtime `if` is what makes owner code reachable in a Standard build:
    // the module is in the bundle, just disabled. The seam exists so that no
    // shared module ever needs one.
    const offenders: string[] = [];
    const patterns = [/HENRY_TARGET\b/, /__HENRY_TARGET__/, /\bisOwnerTarget\b/, /\bOWNER_TARGET\b/];
    for (const rel of SOURCE_FILES) {
      if (isOwnerOnly(rel) || rel.startsWith('targets/')) continue;
      // Comment lines are excluded deliberately: a module may DOCUMENT the
      // ban without tripping it, and every owner-boundary file in this repo
      // explains it at length.
      const code = read(rel)
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');
      if (patterns.some((re) => re.test(code))) offenders.push(rel);
    }
    expect(
      offenders,
      `Shared code branches on the build target. Owner-only code must be excluded by the ` +
        `build, not disabled at runtime:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the main process registers the owner seam unconditionally', () => {
    const main = read('electron/main.ts');
    expect(main).toContain(`from '${OWNER_SPECIFIER_MAIN}'`);
    expect(main).toMatch(/ownerSeam\.register\(/);
    // Owner-only channels registered only for owner builds would be fine; a
    // seam call behind an `if` is not. It would mean the Standard build's
    // absence of owner code was decided at runtime rather than by the
    // bundler, which is the thing this architecture rules out.
    //
    // Anchored to `registerMarketplaceHandlers`, a shared registration that
    // sits at the top level of the `app.whenReady()` callback and is asserted
    // present in both targets below. Comparing indentation rather than
    // counting braces is deliberate: `main.ts` is a 1300-line file with deeply
    // nested closures and an early `try` block around `registerRuntimeHandlers`,
    // so a brace tally here would report drift on any edit anywhere above the
    // call. Indentation is the property that actually matters — a seam call one
    // level deeper than the shared registrations is behind some `if`.
    const indentOf = (needle: string) => {
      const i = main.indexOf(needle);
      expect(i, `${needle} not found in electron/main.ts`).toBeGreaterThan(-1);
      return main.slice(i).split('\n')[0].match(/^\s*/)?.[0] ?? '';
    };
    expect(indentOf('ownerSeam.register(')).toBe(indentOf('registerMarketplaceHandlers('));
  });

  it('the owner seam registers IPC through the same ipcMain as everything else', () => {
    // Owner-only code is not a privileged side door. If the seam ever got its
    // own channel namespace or its own boundary check, owner-only features
    // would be outside the approval model that `electron/ipc/validation.ts`
    // applies to every other channel.
    const main = read('electron/main.ts');
    const call = main.slice(main.indexOf('ownerSeam.register('), main.indexOf('ownerSeam.register(') + 400);
    expect(call).toContain('ipcMain.handle');
  });
});

describe('the owner seam — invariants that hold with or without features', () => {
  // These do NOT assert that the feature list is empty. It is empty today, and
  // it will not stay that way; a test that pins emptiness breaks the moment the
  // owner ships their first private feature, and the author would delete the
  // test rather than think about why. What must hold in both states is the
  // relationship between the two sides of the seam.

  it('the STANDARD seam registers nothing and advertises nothing, always', () => {
    // The property that guarantees a Standard artifact carries no owner-only
    // code, independent of what the owner has built. It holds whether the
    // owner has zero features or twenty.
    const registered: string[] = [];
    const channels = stubSeam.register({ registerHandler: (c) => registered.push(c) });
    expect(stubSeam.target).toBe('standard');
    expect(channels).toEqual([]);
    expect(registered).toEqual([]);
    expect(stubSeam.ownerOnlyFeatures.every((f) => !ownerOnly().includes(f.id))).toBe(true);
  });

  it('every channel the owner seam registers is reported back to the caller', () => {
    // `register` returning what it registered is what lets `electron/main.ts`
    // log or assert on it. If the owner seam grew a feature whose channels were
    // registered but not returned, the return value would under-report and the
    // guarantee would quietly stop meaning anything.
    const registered: string[] = [];
    const channels = realOwnerSeam.register({ registerHandler: (c) => registered.push(c) });
    expect(channels).toEqual(registered);
    for (const channel of channels) expect(typeof channel).toBe('string');
  });

  it('every channel the owner seam registers is a declared owner-only marker', () => {
    // The link that makes the exclusion enforceable. An owner feature that
    // registers a channel nobody wrote down cannot be scanned for in a Standard
    // artifact, because nothing knows to look for it. This is the failure that
    // turns the whole mechanism decorative, and it happens by omission: the
    // channel works, the owner uses it, and no one adds the string.
    const registered: string[] = [];
    realOwnerSeam.register({ registerHandler: (c) => registered.push(c) });
    for (const channel of registered) {
      expect(
        ownerOnly().some((marker) => channel.includes(marker)),
        `owner seam registered "${channel}", which is not in targets/ownerPolicy.json. ` +
          `Add it to ownerOnlyIdentifiers in the same commit or the Standard artifact scan ` +
          `has nothing to look for.`
      ).toBe(true);
    }
  });

  it('every declared owner-only feature id is a declared owner-only marker', () => {
    for (const feature of realOwnerSeam.ownerOnlyFeatures) {
      expect(
        ownerOnly().includes(feature.id),
        `owner feature "${feature.id}" is not declared in targets/ownerPolicy.json`
      ).toBe(true);
    }
  });

  it('the two sides of the seam implement the same contract', () => {
    // Both are held to `OwnerSeam`, so a change to one the other does not make
    // is a typecheck failure rather than a build error in the target nobody
    // tests locally. The stub is additionally required to advertise nothing.
    const probe = (seam: OwnerSeam) => ({
      target: seam.target,
      features: seam.ownerOnlyFeatures.length,
      channels: seam.register({ registerHandler: () => {} }),
    });
    expect(probe(stubSeam)).toEqual({ target: 'standard', features: 0, channels: [] });
    expect(probe(realOwnerSeam).target).toBe('owner');
  });

  it('the owner renderer seam registers through the same contract', () => {
    // Renderer-side counterpart. Not asserted empty — see the note above.
    expect(realOwnerUi.registerOwnerOnlyUi({ registerHandler: () => {} })).toEqual(
      realOwnerUi.OWNER_ONLY_UI_FEATURES.map((f) => f.id)
    );
  });
});

describe('Marketplace — public, and in BOTH targets', () => {
  it('the Marketplace source files are not inside the owner boundary', () => {
    // The single most likely mistake this architecture invites: treating
    // "PrimeTech" as a synonym for "private" and walling the Marketplace off
    // with the owner's integration. Marketplace *availability* is not owner
    // operational authority — it is a catalogue anyone may browse.
    for (const rel of SHARED_MARKETPLACE_SOURCES) {
      expect(isOwnerOnly(rel), `${rel} is shared Marketplace code and must not be owner-only`).toBe(false);
      expect(existsSync(path.join(REPO_ROOT, rel)), `${rel} is missing`).toBe(true);
    }
  });

  it('main.ts registers the Marketplace handlers unconditionally', () => {
    const main = read('electron/main.ts');
    expect(main).toContain('registerMarketplaceHandlers');
    expect(main).not.toMatch(/HENRY_TARGET[\s\S]{0,200}registerMarketplaceHandlers/);
  });

  it('the Marketplace manifest ships as an extraResource for every target', () => {
    // electron-builder's `extraResources` is target-independent in
    // package.json, and scripts/henry-build.mjs only strips entries under a
    // declared OWNER_ONLY_RESOURCE_DIRS. If the manifest were ever listed under
    // one, a Standard build would ship without it and the panel would render an
    // empty catalogue with no error.
    const pkg = JSON.parse(read('package.json')) as {
      build: { extraResources?: { from: string }[] };
    };
    const froms = (pkg.build.extraResources ?? []).map((r) => r.from.replace(/\\/g, '/'));
    expect(froms.some((f) => f.includes('marketplace'))).toBe(true);
    for (const from of froms) {
      for (const dir of OWNER_ONLY_RESOURCE_DIRS) {
        expect(from.startsWith(dir), `${from} would be stripped from standard builds`).toBe(false);
      }
    }
  });
});

describe('PrimeRoute surfaces that no Henry build may contain', () => {
  it('no source file references a forbidden endpoint prefix', () => {
    // `/api/admin/*` and `/api/security/*` are the owner's management API and
    // the operator control plane — ledger §7.4 marks them `NEVER IN HENRY`,
    // for the Owner's build as much as for Standard's. A guard that only
    // inspected standard artifacts would wave these through.
    const offenders: string[] = [];
    for (const rel of SOURCE_FILES) {
      const code = read(rel);
      for (const marker of FORBIDDEN_IN_EVERY_ARTIFACT) {
        if (code.includes(marker)) offenders.push(`${rel} contains "${marker}"`);
      }
    }
    expect(offenders, `PrimeRoute operator surfaces must not appear in Henry source:\n  ${offenders.join('\n  ')}`)
      .toEqual([]);
  });
});

describe('the policy itself', () => {
  it('is not importable from anything that gets bundled', () => {
    // `targets/ownerPolicy.ts` NAMES the owner-only markers. If a shared module
    // imported it, the markers would be bundled into the very artifact the
    // guards scan for them — the mechanism would defeat itself, and the guards
    // would fail on a correct build for an unfixable reason. Build tooling and
    // the guards may read it; shipped code may not.
    const offenders: string[] = [];
    for (const rel of SOURCE_FILES) {
      if (rel.startsWith('targets/')) continue;
      for (const spec of importSpecifiers(read(rel))) {
        if (/ownerPolicy/.test(spec)) offenders.push(`${rel} → ${spec}`);
      }
    }
    expect(offenders, `Only targets/ may import the policy:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('declares the same owner-only directories the bundler excludes', () => {
    // If viteOwnerTarget were handed a different list, the build would exclude
    // one directory while the guard inspected another, and the seam would be
    // the only thing standing between them.
    const plugin = read('targets/viteOwnerTarget.ts');
    expect(plugin).toContain('OWNER_ONLY_DIRS');
    expect(plugin).toContain('OWNER_STUB_PATH');
  });

  it('every declared owner import root exists', () => {
    for (const rel of OWNER_IMPORT_ROOTS) {
      expect(existsSync(path.join(REPO_ROOT, rel)), `${rel} is a declared owner import root but does not exist`).toBe(
        true
      );
    }
  });

  it('OWNER_SPECIFIER_* are distinct and neither is a real package', () => {
    // Both are bare specifiers resolved only by the vite plugin and the two
    // tsconfigs. If one ever resolved to something on disk instead, the
    // exclusion would depend on resolution order.
    expect(OWNER_SPECIFIER_MAIN).not.toBe(OWNER_SPECIFIER_RENDERER);
    expect(existsSync(path.join(REPO_ROOT, 'node_modules', OWNER_SPECIFIER_MAIN))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, 'node_modules', OWNER_SPECIFIER_RENDERER))).toBe(false);
  });

  it('keeps the owner-only resource list and the shipped one disjoint', () => {
    const pkg = JSON.parse(read('package.json')) as { build: { extraResources?: { from: string }[] } };
    for (const r of pkg.build.extraResources ?? []) {
      const from = r.from.replace(/\\/g, '/');
      for (const dir of OWNER_ONLY_RESOURCE_DIRS) {
        expect(
          inside(from, dir) === false,
          `${from} ships in every build and is also declared owner-only — contradictory`
        ).toBe(true);
      }
    }
  });
});
