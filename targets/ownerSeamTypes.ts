/**
 * The contract between Henry's shared core and the Owner's private surface.
 *
 * Shared core never learns what an owner-only feature IS. It learns this:
 * "something may register handlers and report which capabilities it turned
 * on". `electron/owner/index.ts` implements it for an Owner build;
 * `targets/ownerStub.ts` implements it as an empty list for a Standard build.
 *
 * Types only — no runtime code — so importing this from either side costs a
 * Standard artifact nothing.
 */

/** An owner-only capability, as advertised by the owner seam. */
export interface OwnerOnlyFeature {
  /** Stable, greppable identifier. Also the string the guards scan for. */
  id: string;
  /** One line, for an about/diagnostics surface. */
  summary: string;
}

/**
 * What shared core offers an owner-only feature. Deliberately minimal: the
 * owner seam may register IPC and nothing else, so an owner-only feature
 * cannot quietly obtain a capability that shared code never gave anyone.
 */
export interface OwnerSeamHost {
  /** `ipcMain.handle`, or the renderer's equivalent. */
  registerHandler(channel: string, handler: (...args: unknown[]) => unknown): void;
}

export interface OwnerSeam {
  /** Which implementation answered. */
  readonly target: 'owner' | 'standard';
  /** What this build carries. Empty in Standard. */
  readonly ownerOnlyFeatures: readonly OwnerOnlyFeature[];
  /**
   * Turn the owner-only features on. Returns the channels registered, so the
   * caller can log or assert on them. An empty list is the honest Standard
   * answer, not an error.
   */
  register(host: OwnerSeamHost): string[];
}
