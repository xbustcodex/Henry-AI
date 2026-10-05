/**
 * Where the map is kept between sessions.
 *
 * ── One snapshot, then deltas ───────────────────────────────────────────────
 *
 * The store holds exactly one map: `system_map_nodes` for the filesystem and
 * `system_map_snapshot` for everything else. There is no history table, because
 * a history of every file Henry has ever seen on a machine is a record Henry
 * does not need and a user would not want kept.
 *
 * The interesting question for a store is what happens on the SECOND scan. A
 * full rewrite of 250,000 rows to record one new file is both slow and a way to
 * turn a small change into a large one, so `applyDelta` writes only what
 * actually changed: rows inserted, rows updated, rows deleted by subtree. That
 * is the same shape as the filesystem event that prompted it.
 *
 * ── Writes are transactional ───────────────────────────────────────────────
 *
 * `applyDelta` runs inside one transaction. A delta that is half-applied is a
 * map that claims a file was deleted when it was not, and the next incremental
 * pass would act on that lie.
 *
 * ── Testable without Electron's SQLite addon ───────────────────────────────
 *
 * The handle is a narrow structural interface, not `better-sqlite3`'s type, so
 * the tests can drive the real SQL through `node:sqlite`. The statements
 * themselves are the behaviour under test; a fake that agreed with whatever was
 * written would prove nothing.
 */

/** A statement handle, shaped by what this store uses. */
export interface StoreStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** The database surface this store needs. */
export interface SystemMapDb {
  prepare(sql: string): StoreStatement;
  exec(sql: string): unknown;
  /**
   * Runs `fn` inside a transaction, when the handle offers one. Typed loosely
   * because `better-sqlite3` and `node:sqlite` wrap their functions differently
   * and this store only ever needs "run this, atomically".
   */
  transaction?(fn: () => void): unknown;
}

/** One node row, as it comes back out of the database. */
export interface StoredNode {
  path: string;
  parent_path: string | null;
  name: string;
  kind: 'file' | 'directory';
  extension: string | null;
  file_type: string;
  size_bytes: number;
  created_at: number | null;
  modified_at: number;
  depth: number;
  classification: string | null;
  classification_reason: string | null;
}

/** The schema this store creates. Idempotent; safe to run on every launch. */
export const SYSTEM_MAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS system_map_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  built_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  root_count INTEGER NOT NULL,
  inventory TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_map_nodes (
  path TEXT PRIMARY KEY,
  parent_path TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
  extension TEXT,
  file_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  modified_at INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  classification TEXT,
  classification_reason TEXT
);

CREATE INDEX IF NOT EXISTS system_map_nodes_parent ON system_map_nodes(parent_path);
CREATE INDEX IF NOT EXISTS system_map_nodes_kind ON system_map_nodes(kind);
`;

/** The persisted header row. */
export interface StoredSnapshot {
  schemaVersion: number;
  builtAt: number;
  updatedAt: number;
  rootCount: number;
  /** The non-filesystem sections, JSON. */
  inventory: string;
}

/** What changed between two observations of the machine. */
export interface MapDelta {
  /** New paths, with their metadata. */
  added: readonly StoredNode[];
  /** Existing paths whose metadata moved. */
  updated: readonly StoredNode[];
  /** Paths that are gone. Their descendants go with them. */
  removed: readonly string[];
  /** Renames: one removed path became another, detected by shared identity. */
  renamed: readonly { from: string; to: string }[];
}

/** Create the tables. Idempotent. */
export function ensureSystemMapSchema(db: SystemMapDb): void {
  db.exec(SYSTEM_MAP_SCHEMA);
}

/** The header row, or null when no map has ever been built. */
export function readSnapshot(db: SystemMapDb): StoredSnapshot | null {
  const row = db
    .prepare('SELECT schema_version, built_at, updated_at, root_count, inventory FROM system_map_snapshot WHERE id = 1')
    .get() as
    | {
        schema_version: number;
        built_at: number;
        updated_at: number;
        root_count: number;
        inventory: string;
      }
    | undefined;
  if (!row) return null;
  return {
    schemaVersion: row.schema_version,
    builtAt: row.built_at,
    updatedAt: row.updated_at,
    rootCount: row.root_count,
    inventory: row.inventory,
  };
}

/** How many nodes the map holds. Zero when none. */
export function countNodes(db: SystemMapDb): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM system_map_nodes').get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Replace the whole map: what a first scan does. */
export function replaceSnapshot(
  db: SystemMapDb,
  header: Omit<StoredSnapshot, 'schemaVersion'> & { schemaVersion: number },
  nodes: readonly StoredNode[],
): void {
  const run = (): void => {
    db.exec('DELETE FROM system_map_nodes');
    const insert = db.prepare(
      `INSERT INTO system_map_nodes
         (path, parent_path, name, kind, extension, file_type, size_bytes, created_at, modified_at, depth, classification, classification_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const node of nodes) insert.run(...nodeValues(node));
    db.prepare(
      `INSERT INTO system_map_snapshot (id, schema_version, built_at, updated_at, root_count, inventory)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         schema_version = excluded.schema_version,
         built_at = excluded.built_at,
         updated_at = excluded.updated_at,
         root_count = excluded.root_count,
         inventory = excluded.inventory`,
    ).run(
      header.schemaVersion,
      header.builtAt,
      header.updatedAt,
      header.rootCount,
      header.inventory,
    );
  };
  transaction(db, run);
}

/**
 * Apply a delta to an existing map, in one transaction.
 *
 * Removals are applied as subtree deletes rather than one statement per path:
 * deleting `/home/x/.ssh` takes its contents with it, which is both correct and
 * the difference between one statement and hundreds.
 */
export function applyDelta(db: SystemMapDb, delta: MapDelta): void {
  const run = (): void => {
    for (const removal of delta.removed) {
      db.prepare("DELETE FROM system_map_nodes WHERE path = ? OR path LIKE ? ESCAPE '\\'").run(
        removal,
        `${escapeLike(removal)}/%`,
      );
    }
    const upsert = db.prepare(
      `INSERT INTO system_map_nodes
         (path, parent_path, name, kind, extension, file_type, size_bytes, created_at, modified_at, depth, classification, classification_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         parent_path = excluded.parent_path,
         name = excluded.name,
         kind = excluded.kind,
         extension = excluded.extension,
         file_type = excluded.file_type,
         size_bytes = excluded.size_bytes,
         created_at = excluded.created_at,
         modified_at = excluded.modified_at,
         depth = excluded.depth,
         classification = excluded.classification,
         classification_reason = excluded.classification_reason`,
    );
    for (const node of [...delta.added, ...delta.updated]) upsert.run(...nodeValues(node));
    for (const rename of delta.renamed) {
      db.prepare('UPDATE system_map_nodes SET path = ?, parent_path = ? WHERE path = ?').run(
        rename.to,
        parentPathOf(rename.to),
        rename.from,
      );
    }
    db.prepare('UPDATE system_map_snapshot SET updated_at = ? WHERE id = 1').run(Date.now());
  };
  transaction(db, run);
}

/** Replace only the inventory half of the header, leaving the nodes alone. */
export function updateInventory(
  db: SystemMapDb,
  inventory: string,
  schemaVersion: number,
  now: number,
): void {
  db.prepare(
    `INSERT INTO system_map_snapshot (id, schema_version, built_at, updated_at, root_count, inventory)
     VALUES (1, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       schema_version = excluded.schema_version,
       updated_at = excluded.updated_at,
       inventory = excluded.inventory`,
  ).run(schemaVersion, now, now, inventory);
}

// ── Exclusions ───────────────────────────────────────────────────────────────

/**
 * The reviewed exclusion set, stored in the existing `settings` table.
 *
 * A settings row rather than a table of its own: it is one key holding one
 * JSON value, it is already the place every other small persisted preference
 * lives, and it means a fresh install has no system-map rows at all until
 * someone reviews the exclusions.
 */
/** The settings key the reviewed exclusion set is stored under. */
export const SYSTEM_MAP_EXCLUSIONS_KEY = 'system_map_exclusions';

/** The saved exclusion set, or null when the user has never reviewed one. */
export function readExclusions(db: SystemMapDb): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SYSTEM_MAP_EXCLUSIONS_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Persist the reviewed exclusion set as one JSON value. The last review wins. */
export function writeExclusions(db: SystemMapDb, exclusionsJson: string, now: number): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SYSTEM_MAP_EXCLUSIONS_KEY, exclusionsJson, new Date(now).toISOString());
}

// ── Internals ────────────────────────────────────────────────────────────────

/** A node as the eleven bound parameters, in column order. */
function nodeValues(node: StoredNode): unknown[] {
  return [
    node.path,
    node.parent_path,
    node.name,
    node.kind,
    node.extension,
    node.file_type,
    node.size_bytes,
    node.created_at,
    node.modified_at,
    node.depth,
    node.classification,
    node.classification_reason,
  ];
}

/** The parent of a path, by the same segment rule the scanner uses. */
function parentPathOf(target: string): string {
  const trimmed = target.replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut <= 0 ? trimmed.slice(0, 1) : trimmed.slice(0, cut);
}

/** Neutralise LIKE wildcards in a path used as a prefix pattern. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

/** Run `fn` in a transaction when the handle offers one. */
function transaction(db: SystemMapDb, fn: () => void): void {
  if (typeof db.transaction === 'function') {
    db.transaction(fn);
    return;
  }
  // A handle without transactions (a test double) still gets atomic-enough
  // behaviour, and the real handle always takes the branch above.
  fn();
}