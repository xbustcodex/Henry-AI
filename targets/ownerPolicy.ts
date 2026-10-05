/**
 * Henry builds TWO production targets from ONE codebase:
 *
 *   `owner`     — the owner's private build. May carry authorised private
 *                 PrimeTech integration.
 *   `standard`  — distributed to everyone else. Owner-only code must be
 *                 absent from the artifact, not hidden behind a flag.
 *
 * This module is the typed face of `targets/ownerPolicy.json`, which is the
 * single source of truth. Everything that has to know about the difference
 * reads from there:
 *
 *   - `vite.config.ts` / `vite.web.config.ts` — via `ownerTargetPlugin()`
 *     (`./viteOwnerTarget`), which resolves `@henry/owner` to
 *     `targets/ownerStub.ts` in a standard build, so no owner module is read.
 *   - `scripts/henry-build.mjs` — picks the target from argv and exports
 *     HENRY_TARGET to vite and electron-builder alike.
 *   - `targets/*.test.ts` — the guards, which scan for exactly the markers the
 *     build excludes, so the two cannot drift.
 *
 * Shared core never branches on the target. `electron/main.ts` imports
 * `{ ownerSeam } from '@henry/owner'` and calls it unconditionally; which
 * implementation arrives is the bundler's decision. A `if (target === 'owner')`
 * in `src/` or `electron/` is the coupling this architecture exists to
 * prevent, and `targets/ownerBoundary.test.ts` fails on it.
 *
 * Architecture, the add-an-owner-feature procedure, and exactly what these
 * guards do and do not prove: `PRIMETECH_INTEGRATION_LEDGER.md` §8.
 */

// JSON import keeps this in lockstep with scripts/henry-build.mjs, which reads
// the same file with plain `require`. resolveJsonModule is on in both
// tsconfigs.
import policy from './ownerPolicy.json';

export type HenryTarget = 'owner' | 'standard';

export const HENRY_TARGETS: readonly HenryTarget[] = ['owner', 'standard'];
export const OWNER_TARGET: HenryTarget = 'owner';
export const STANDARD_TARGET: HenryTarget = 'standard';

/**
 * Fail-safe default.
 *
 * A build with no HENRY_TARGET produces the STANDARD build. Guessing "owner"
 * means an artifact nobody audited carries the owner's private integration to
 * everyone; guessing "standard" means the owner runs a build missing their own
 * feature, which is a bug they notice. Only the first is a disclosure.
 */
export const DEFAULT_HENRY_TARGET: HenryTarget = STANDARD_TARGET;

/** Environment variable the build toolchain reads. */
export const HENRY_TARGET_ENV = 'HENRY_TARGET';

/** Compile-time constant injected into every bundle (see `ownerTargetPlugin`). */
export const HENRY_TARGET_DEFINE = '__HENRY_TARGET__';

/**
 * `HENRY_TARGET=owner npm run build`, or the default.
 *
 * An unrecognised value throws rather than falling back. Silently building
 * something nobody asked for is how a Standard artifact acquires owner code.
 */
export function resolveTarget(raw: string | undefined | null): HenryTarget {
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_HENRY_TARGET;
  const value = raw.trim().toLowerCase();
  if ((HENRY_TARGETS as readonly string[]).includes(value)) return value as HenryTarget;
  throw new Error(
    `Unknown ${HENRY_TARGET_ENV} "${raw}". Expected one of: ${HENRY_TARGETS.join(', ')}. ` +
      `An unrecognised target never falls back silently — it is either a typo or ` +
      `an attempt to build an artifact nobody has audited.`
  );
}

// ── The owner-only boundary ──────────────────────────────────────────────────

/** Module specifiers that select the owner seam. See OWNER_SPECIFIER_TARGETS. */
export const OWNER_SPECIFIER_MAIN = policy.ownerSpecifierMain;
export const OWNER_SPECIFIER_RENDERER = policy.ownerSpecifierRenderer;

/** Which owner-only directory each seam specifier resolves to in an owner build. */
export const OWNER_SPECIFIER_TARGETS: Readonly<Record<string, string>> = {
  [OWNER_SPECIFIER_MAIN]: 'electron/owner',
  [OWNER_SPECIFIER_RENDERER]: 'src/owner',
};

/**
 * Directories that may contain owner-only code, repo-relative.
 *
 * Both are excluded from every standard build. Either may be absent — nothing
 * owner-only is implemented yet (ledger §8.2) — and a directory that does not
 * exist cannot leak. They are declared anyway so the FIRST owner-only feature
 * is excluded by the mechanism rather than by someone remembering to wire it
 * up later.
 */
export const OWNER_ONLY_DIRS: readonly string[] = policy.ownerOnlyDirs;

/**
 * Files allowed to import an owner-only module: the application entry points,
 * and nothing else.
 *
 * The entry points are the seam. A shared module reaching into `electron/owner/`
 * is how owner code leaks one import at a time, and no amount of aliasing fixes
 * it — the build would have to redirect every such import site individually.
 */
export const OWNER_IMPORT_ROOTS: readonly string[] = policy.ownerImportRoots;

/**
 * Data directories that would need to ship as `extraResources` for an owner
 * build. Empty today; declared so the guard can fail the moment a directory is
 * added without being declared, which is how an owner's private resource file
 * ends up in a Standard installer.
 */
export const OWNER_ONLY_RESOURCE_DIRS: readonly string[] = policy.ownerOnlyResourceDirs;

// ── Owner-only markers ───────────────────────────────────────────────────────

/**
 * Identifiers that may appear ONLY in an owner artifact.
 *
 * EMPTY, and that is the honest state rather than an oversight: no owner-only
 * PrimeTech implementation exists yet, so there is no owner-only string to
 * name. The PrimeRoute work in ledger §7 is analysis, not code.
 *
 * The first owner-only feature MUST add its identifiers here in the same commit
 * that adds the code. That is the mechanism: the list the guard scans is the
 * list the build is designed against, and they cannot diverge because there is
 * only one.
 */
export const OWNER_ONLY_IDENTIFIERS: readonly string[] = policy.ownerOnlyIdentifiers;

/** Owner-only endpoint prefixes (`https://…`, `/api/…`). Same rule as above. */
export const OWNER_ONLY_ENDPOINT_PREFIXES: readonly string[] = policy.ownerOnlyEndpointPrefixes;

/**
 * Owner-only credential shapes — env var names, key prefixes, identity headers.
 * Empty today. Scanned as literal substrings in built artifacts, so entries
 * must be specific enough not to match a legitimate generic string.
 */
export const OWNER_ONLY_SECRET_MARKERS: readonly string[] = policy.ownerOnlySecretMarkers;

/**
 * Markers forbidden in EVERY artifact, in BOTH targets.
 *
 * These are the PrimeRoute surfaces ledger §7.4 marks `NEVER IN HENRY`: the
 * management API and the operator control plane. They belong here rather than
 * in the owner-only list because no Henry build may contain them — the
 * Owner's included. A guard that only inspected standard artifacts would let
 * these through in an owner build, and an admin endpoint reachable from the
 * owner's own desktop app is still an endpoint reachable from a desktop app.
 */
export const FORBIDDEN_IN_EVERY_ARTIFACT: readonly string[] = policy.forbiddenInEveryArtifact;

// ── Shared surface: must be present in BOTH targets ──────────────────────────

/**
 * The PrimeTech Marketplace is public and generic — a catalogue of PrimeTech
 * apps anyone may browse. Marketplace *availability* is not owner operational
 * authority, and it must not be stripped from Standard.
 *
 * Asserted PRESENT in both targets' artifacts. This is the counterpart to the
 * owner-only scan: a Standard build that lost the Marketplace is as broken as
 * one that gained an owner endpoint, and neither is caught by looking for
 * forbidden strings alone.
 */
export const SHARED_MARKETPLACE_IPC_CHANNELS: readonly string[] = policy.sharedMarketplaceIpcChannels;

/** Manifest id inside `resources/marketplace/marketplace.json`. */
export const SHARED_MARKETPLACE_MANIFEST_ID = policy.sharedMarketplaceManifestId;

/** Source files that make up the shared Marketplace surface. */
export const SHARED_MARKETPLACE_SOURCES: readonly string[] = policy.sharedMarketplaceSources;

// ── Composed views, used by the guards ───────────────────────────────────────

/** Every marker a standard artifact must be free of. */
export function forbiddenInStandard(): readonly string[] {
  return [
    ...OWNER_ONLY_IDENTIFIERS,
    ...OWNER_ONLY_ENDPOINT_PREFIXES,
    ...OWNER_ONLY_SECRET_MARKERS,
    ...FORBIDDEN_IN_EVERY_ARTIFACT,
  ];
}

/** Markers absent from an artifact of ANY target. */
export function forbiddenEverywhere(): readonly string[] {
  return [...FORBIDDEN_IN_EVERY_ARTIFACT];
}

/** Markers permitted only in an owner artifact; leaks if found in standard. */
export function ownerOnly(): readonly string[] {
  return [
    ...OWNER_ONLY_IDENTIFIERS,
    ...OWNER_ONLY_ENDPOINT_PREFIXES,
    ...OWNER_ONLY_SECRET_MARKERS,
  ];
}
