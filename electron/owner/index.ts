/**
 * THE owner-only surface. Everything private to the Owner's PrimeTech
 * integration lives under `electron/owner/` and is reachable only through this
 * module.
 *
 * ── What is here today: NOTHING. ──────────────────────────────────────────
 *
 * This file exports an empty feature list because there is no owner-only
 * implementation in the repository. The PrimeRoute work recorded in
 * `PRIMETECH_INTEGRATION_LEDGER.md` §7 is analysis and a mapped API contract,
 * not code. Saying so here rather than shipping a plausible-looking stub is
 * deliberate: a stub that returns `{}` is indistinguishable from a working
 * integration until it is called in production, and it would be the first
 * thing a future owner-only feature quietly grows inside.
 *
 * ── Adding an owner-only feature (the procedure that cannot leak) ──────────
 *
 * 1. Put the implementation in `electron/owner/` (main) or `src/owner/`
 *    (renderer). Nowhere else. A shared module importing one of these
 *    directories directly fails `targets/ownerBoundary.test.ts`.
 * 2. Add an `OwnerOnlyFeature` to `OWNER_ONLY_FEATURES` below with a stable
 *    `id`, and implement `register` to call `host.registerHandler` for each
 *    channel it owns. Do not add an `if (target === 'owner')` to shared core;
 *    shared core calls `ownerSeam.register(...)` unconditionally and the build
 *    decides what that resolves to.
 * 3. In the SAME commit, add every owner-only identifier, endpoint prefix and
 *    credential marker to `targets/ownerPolicy.ts`
 *    (`OWNER_ONLY_IDENTIFIERS`, `OWNER_ONLY_ENDPOINT_PREFIXES`,
 *    `OWNER_ONLY_SECRET_MARKERS`). That file is the source of truth for BOTH
 *    the build and the guard, so a marker declared there is enforced by
 *    `targets/standardBundle.test.ts` with no second place to update.
 * 4. If the feature needs a data file in the installer, add its directory to
 *    `OWNER_ONLY_RESOURCE_DIRS` and make `build.extraResources` in
 *    `package.json` conditional on the target. The guard checks both.
 * 5. Build both targets and read the diff:
 *      npm run build:standard:linux && npm run build:owner:linux
 *    The Standard artifact must not contain any marker from step 3.
 *
 * ── The seam ──────────────────────────────────────────────────────────────
 *
 * `electron/main.ts` imports `{ ownerSeam } from '@henry/owner'`. In an Owner
 * build that resolves to THIS file; in a Standard build
 * `targets/viteOwnerTarget.ts` resolves it to `targets/ownerStub.ts` and this
 * file is never read by the bundler.
 */

import type { OwnerOnlyFeature, OwnerSeam, OwnerSeamHost } from '../../targets/ownerSeamTypes';

/**
 * The owner's private capabilities, as shipped in an OWNER build.
 *
 * Empty. Not a placeholder — the actual current state.
 */
export const OWNER_ONLY_FEATURES: readonly OwnerOnlyFeature[] = [];

/**
 * Turns the owner-only capabilities on for an owner build. Nothing to turn on.
 *
 * The body is written against the contract rather than left as a TODO, so the
 * shape a real feature takes is already decided: register IPC handlers on the
 * host, add nothing to shared code.
 */
function registerOwnerOnlyFeatures(host: OwnerSeamHost): string[] {
  const channels: string[] = [];
  for (const feature of OWNER_ONLY_FEATURES) {
    // A real owner-only feature registers its channels here. None exist yet,
    // so `host` is unused — kept as a parameter because dropping it would
    // change the `OwnerSeam` signature the moment the first feature lands.
    void feature;
    void host;
  }
  return channels;
}

export const ownerSeam: OwnerSeam = {
  target: 'owner',
  ownerOnlyFeatures: OWNER_ONLY_FEATURES,
  register: registerOwnerOnlyFeatures,
};
