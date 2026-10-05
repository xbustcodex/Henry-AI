/**
 * The build-time half of the Owner / Standard split.
 *
 * Vite cannot tree-shake a private PrimeTech client out of a bundle on its
 * own — dead code elimination needs a statically provable `false`, and a
 * runtime flag read from `process.env` or a JSON file is not one. So the
 * exclusion is done at RESOLUTION time instead: in a Standard build, any
 * import that lands inside an owner-only directory resolves to
 * `targets/ownerStub.ts`, a module with the same exported names and no
 * behaviour. The real file is never read, never parsed, and never enters the
 * module graph, so its strings cannot reach the artifact — no reliance on
 * minification, mangling, or a lucky `if`.
 *
 * What this does and does not achieve is stated in full in
 * `PRIMETECH_INTEGRATION_LEDGER.md` §8.4. In short: static imports are
 * excluded for real; runtime-computed paths (`import(pkgPath)`,
 * `require(variableName)`) are not, and `targets/standardBundle.test.ts`
 * asserts the exclusion against real bundle bytes so the gap cannot widen
 * unnoticed.
 *
 * Shared core code must not branch on the target. It imports
 * `@henry/owner` and calls `ownerSeam`; which implementation arrives is this
 * plugin's decision. A core `if (isOwnerTarget())` is the coupling this
 * architecture exists to prevent.
 */

import path from 'node:path';
import type { Plugin } from 'vite';
import {
  HENRY_TARGET_DEFINE,
  OWNER_ONLY_DIRS,
  OWNER_SPECIFIER_MAIN,
  OWNER_SPECIFIER_RENDERER,
  OWNER_SPECIFIER_TARGETS,
  resolveTarget,
  type HenryTarget,
} from './ownerPolicy';

/** Repo-relative path of the module an owner-only import resolves to in Standard. */
export const OWNER_STUB_PATH = 'targets/ownerStub.ts';

/**
 * The owner directory an import specifier selects, or null when the specifier
 * is not the owner seam at all.
 */
function ownerSpecifierFor(source: string): string | null {
  for (const [specifier, dir] of Object.entries(OWNER_SPECIFIER_TARGETS)) {
    if (source === specifier || source.startsWith(`${specifier}/`)) return dir;
  }
  return null;
}

/**
 * Is `absolute` inside `dir`? Both must be absolute and normalised; `dir` is
 * repo-relative and resolved against `root`.
 */
function isInside(absolute: string, root: string, dir: string): boolean {
  const rel = path.relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const target = path.normalize(dir);
  return rel === target || rel.startsWith(`${target}${path.sep}`);
}

export interface OwnerTargetPluginOptions {
  /** The target to build. Omit to read `HENRY_TARGET` from the environment. */
  target?: HenryTarget | string;
  /** Vite's project root. Defaults to the repository root. */
  root?: string;
}

/**
 * Resolves the owner seam and hard-fails a Standard build that reaches owner
 * code by a path the alias cannot intercept.
 */
export function ownerTargetPlugin(options: OwnerTargetPluginOptions = {}): Plugin {
  const root = path.resolve(options.root ?? process.cwd());
  const target =
    options.target === undefined ? resolveTarget(process.env.HENRY_TARGET) : resolveTarget(String(options.target));
  const stubId = path.resolve(root, OWNER_STUB_PATH);

  return {
    name: 'henry:owner-target',
    // `pre` so this sees imports before any other resolver has a chance to
    // turn them into absolute paths.
    enforce: 'pre',

    config() {
      return {
        define: {
          [HENRY_TARGET_DEFINE]: JSON.stringify(target),
        },
      };
    },

    resolveId(source, importer) {
      const ownerDir = ownerSpecifierFor(source);

      // Owner build: point the seam at the real directory. Returning null for
      // everything else lets Vite's normal resolution continue, so a direct
      // relative import of `electron/owner/index.ts` keeps working too.
      if (target === 'owner') {
        return ownerDir ? path.resolve(root, ownerDir, 'index.ts') : null;
      }

      // Standard build: the seam becomes the empty stub.
      if (ownerDir) return stubId;

      // A relative or root-relative import that reaches into an owner-only
      // directory directly. This is a boundary violation, not a seam call: the
      // code is in the bundle graph and the exclusion cannot be applied to it.
      // The build stops with an actionable message rather than redirecting to
      // the stub, because the stub does not export that module's names and a
      // MISSING_EXPORT error would send the author looking in the wrong place.
      const candidates: string[] = [];
      if (source.startsWith('.') && importer) {
        candidates.push(path.resolve(path.dirname(importer), source));
      }
      if (source.startsWith('/')) candidates.push(path.resolve(root, `.${source}`));
      const reached = candidates.find((abs) => OWNER_ONLY_DIRS.some((dir) => isInside(abs, root, dir)));
      if (reached) {
        throw new Error(
          `Refusing to build: ${source} (from ${importer ?? 'an entry point'}) resolves to ` +
            `${path.relative(root, reached)}, which is owner-only code, in a standard build.\n` +
            `Owner-only code is reachable only through ${OWNER_SPECIFIER_MAIN} / ` +
            `${OWNER_SPECIFIER_RENDERER}, so the bundler can replace it here. Either move the ` +
            `implementation under ${OWNER_ONLY_DIRS.join(' or ')} and import it through the seam, ` +
            `or drop the import — a shared module must not depend on owner-only code.`
        );
      }

      return null;
    },

    /**
     * In a Standard build, refuse to serve an owner-only file even if some
     * other plugin resolved it first. This is the assertion the mutation check
     * in the ledger exercises: point a Standard build at owner code by any
     * route and the build stops, rather than quietly producing a Standard
     * artifact that contains the owner's private integration.
     */
    load(id) {
      if (target !== 'owner' && OWNER_ONLY_DIRS.some((dir) => isInside(id, root, dir))) {
        throw new Error(
          `Refusing to build: ${path.relative(root, id)} is owner-only code and this is a ` +
            `standard build. Owner-only code must be reached through ` +
            `${OWNER_SPECIFIER_MAIN} / ${OWNER_SPECIFIER_RENDERER} so the build can ` +
            `exclude it. If you are seeing this, something resolved around the ` +
            `alias — report it rather than adding the file to the Standard build.`
        );
      }
      return null;
    },
  };
}
