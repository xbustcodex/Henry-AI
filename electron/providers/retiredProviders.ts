/**
 * Retired providers — providers Henry used to ship with and no longer supports.
 *
 * Groq was the first. Removing it was not a matter of dropping one adapter:
 * an installed Henry still carries a `groq` row in `providers` holding a live
 * `gsk_…` credential, and a saved selection (`companion_provider`,
 * `worker_provider`, `chat_fast_provider`) that still names `groq`. Left alone
 * that stale selection drove a fallback loop — the router found no usable
 * provider, reached for a default, found nothing, and asked for a key the user
 * had already given — while the credential sat on disk being read on every boot.
 *
 * So retirement is a first-class state with three parts:
 *
 *   1. Migrate once at boot (`migrateRetiredProviders`) — drop the provider
 *      rows and blank any selection still pointing at them. It never reads the
 *      `api_key` column, so the credential cannot reach a log line even in
 *      principle, and it is safe to run on every launch and before the
 *      `providers` table exists at all.
 *   2. Refuse at the transport boundary (`retiredProviderError`) — if a retired
 *      id reaches execution anyway (a stale selection written by an older
 *      build, a hand-edited row, a value that was never persisted), the call
 *      fails with an explicit "no longer available" message. It is NOT
 *      substituted with another provider and NOT answered with "unknown
 *      provider", which reads like a typo.
 *   3. Report to the user (`retiredProviderUnavailableMessage`) — one sentence
 *      naming the provider and asking for a supported one.
 *
 * Like `classification.ts`, this module is deliberately dependency-free (no
 * Electron, no SQLite import) so the renderer can import it to resolve a stale
 * selection into the same message the main process would have produced.
 */

/**
 * Provider ids that are no longer supported. A retired id is never routed:
 * there is no adapter, no endpoint, no model catalogue and no credential path
 * for it left in the codebase.
 */
export const RETIRED_PROVIDER_IDS: readonly string[] = ['groq'];

/** The one sentence every caller shows when a retired provider is selected. */
export const RETIRED_PROVIDER_UNAVAILABLE_MESSAGE =
  'The previously selected provider is no longer available. Please select a supported provider in Settings → AI Providers.';

function normalise(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** Is this a provider Henry has retired? */
export function isRetiredProviderId(id: string | null | undefined): boolean {
  return RETIRED_PROVIDER_IDS.includes(normalise(id));
}

/**
 * The user-facing sentence for a retired provider, naming it so the message is
 * actionable rather than generic. Non-retired ids return null, so a caller can
 * treat this as the branch condition instead of checking twice.
 */
export function retiredProviderUnavailableMessage(id: string | null | undefined): string | null {
  const normalised = normalise(id);
  if (!RETIRED_PROVIDER_IDS.includes(normalised)) return null;
  return `${normalised} is no longer a supported provider. ${RETIRED_PROVIDER_UNAVAILABLE_MESSAGE}`;
}

/** The error thrown at the transport boundary for a retired provider id. */
export function retiredProviderError(id: string | null | undefined): Error | null {
  const message = retiredProviderUnavailableMessage(id);
  return message ? new Error(message) : null;
}

/**
 * Minimal SQL surface this module needs, so importing it from the renderer
 * never drags `better-sqlite3` (a native Node module) across the boundary.
 */
export interface RetiredProviderMigrationDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface RetiredProviderMigrationReport {
  /** Provider rows that were deleted, by id. */
  removedProviderIds: string[];
  /** Settings keys whose value named a retired provider and was blanked. */
  clearedSettings: string[];
}

/**
 * Does this table exist? A fresh install registers its schema before boot, but
 * a migration must never be the thing that breaks because a table is absent —
 * it reports an empty result and lets the caller carry on.
 */
function tableExists(db: RetiredProviderMigrationDb, name: string): boolean {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name);
    return row !== undefined && row !== null;
  } catch {
    return false;
  }
}

/**
 * Erase a retired provider from the active application state. Idempotent: run
 * on every boot, and running it twice is indistinguishable from running it once.
 *
 * Only ids are ever read back out of `providers`. The `api_key` column is
 * deleted with the row and never selected, so the old credential is not
 * decrypted, copied, or logged on its way out.
 */
export function migrateRetiredProviders(db: RetiredProviderMigrationDb): RetiredProviderMigrationReport {
  const report: RetiredProviderMigrationReport = { removedProviderIds: [], clearedSettings: [] };

  if (tableExists(db, 'providers')) {
    const rows = db.prepare('SELECT id FROM providers').all() as Array<{ id: string }>;
    for (const row of rows ?? []) {
      const id = row?.id ?? '';
      if (isRetiredProviderId(id)) report.removedProviderIds.push(id);
    }
    if (report.removedProviderIds.length > 0) {
      db.prepare(
        `DELETE FROM providers WHERE lower(trim(id)) IN (${RETIRED_PROVIDER_IDS.map(() => '?').join(', ')})`
      ).run(...RETIRED_PROVIDER_IDS);
    }
  }

  if (tableExists(db, 'settings')) {
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    for (const row of rows ?? []) {
      if (!isRetiredProviderId(row?.value)) continue;
      // Blank, not delete: the renderer resolves a missing key to a default and
      // would silently re-pick a provider the user never chose. An empty value
      // routes nowhere and asks for a supported provider.
      db.prepare("UPDATE settings SET value = '', updated_at = datetime('now') WHERE key = ?").run(row.key);
      report.clearedSettings.push(row.key);
    }
  }

  return report;
}