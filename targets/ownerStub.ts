/**
 * The Standard build's answer to `@henry/owner`.
 *
 * Same exported names as `electron/owner/index.ts`, no behaviour. A Standard
 * build resolves the owner seam HERE, so the owner's private code is never
 * read, never parsed and never bundled — see `targets/viteOwnerTarget.ts`.
 *
 * `ownerSeam.register()` is a no-op, so `electron/main.ts` calls it
 * unconditionally and the Owner build — where the seam resolves to the real
 * module — needs no `if` anywhere in shared core.
 */

import type { OwnerOnlyFeature, OwnerSeam, OwnerSeamHost } from './ownerSeamTypes';

/**
 * The owner's private features, as shipped in a STANDARD build: none.
 *
 * Exported under the same name as the Owner seam's list so the two sides of
 * the seam always have identical export lists. A name present on one side and
 * missing on the other is a build error in one target and a silent `undefined`
 * in the other — the worst failure shape available, because it only appears in
 * the build nobody tests locally. `targets/ownerBoundary.test.ts` asserts the
 * lists match.
 */
export const OWNER_ONLY_FEATURES: readonly OwnerOnlyFeature[] = [];

export const ownerSeam: OwnerSeam = {
  target: 'standard',
  ownerOnlyFeatures: OWNER_ONLY_FEATURES,
  register(_host: OwnerSeamHost): string[] {
    return [];
  },
};
