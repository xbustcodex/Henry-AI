/**
 * THE owner-only renderer surface.
 *
 * Everything private to the Owner that the renderer needs lives under
 * `src/owner/` and is reachable only through this module. The procedure for
 * adding a feature is in `electron/owner/index.ts` — read that one; this file
 * is its renderer half.
 *
 * ── What is here today: NOTHING. ──────────────────────────────────────────
 *
 * There is no owner-only renderer implementation in the repository. See
 * `PRIMETECH_INTEGRATION_LEDGER.md` §8.2.
 *
 * ── Renderer rules that still apply here ──────────────────────────────────
 *
 * `AGENTS.md`: renderer code must not import Node built-ins. Owner-only code
 * is renderer code; the owner's private PrimeTech integration does not get to
 * reach `fs` or `child_process` any more than the rest of the renderer does.
 * Privileged work goes through the preload bridge, exactly as elsewhere.
 */

import type { OwnerOnlyFeature, OwnerSeamHost } from '../../targets/ownerSeamTypes';

/** The owner's private renderer capabilities, as shipped in an OWNER build. */
export const OWNER_ONLY_UI_FEATURES: readonly OwnerOnlyFeature[] = [];

/**
 * Renderer-side registration. Nothing to register.
 *
 * A real owner-only renderer feature receives the same `OwnerSeamHost` and
 * registers through the preload bridge; it does not import `electron`.
 */
export function registerOwnerOnlyUi(_host: OwnerSeamHost): string[] {
  return [];
}
