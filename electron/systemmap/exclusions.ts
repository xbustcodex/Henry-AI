/**
 * What the scan will not look at.
 *
 * ── The rule this file implements ───────────────────────────────────────────
 *
 * **Default-deny, ordered, first match wins.**
 *
 * A map that has read somebody's SSH keys cannot be made safe afterwards, so
 * the question is never "should we exclude this?" but "what is the explicit
 * reason we are including it?" Anything without a reason is out.
 *
 * The rule list is ordered, and that order is the point. A specific rule
 * (`~/.ssh`) is consulted before a broad one (any cache directory), so a
 * credential store is denied for its own reason and the reason the UI shows is
 * the true one. Users may add rules (highest priority, above every default)
 * and drop categories (their rules stop applying entirely); a category the user
 * removed is genuinely scanned and no default is quietly merged back in.
 *
 * ── The two-level guarantee ─────────────────────────────────────────────────
 *
 * Exclusions are enforced twice, and the second check is not redundant:
 *
 *   1. **At directory descent.** A denied directory is never listed, so its
 *      children are never even named. This is the cheap path and the one that
 *      does the real work.
 *   2. **At record time.** Every node about to be persisted is re-checked
 *      against its FULL path, not just its own name. This catches what the
 *      descent check cannot see: a file whose own name is innocuous
 *      (`notes.txt`) sitting inside something that was reached by a path the
 *      walk did not itself descend through — a scan root that is itself inside a
 *      denied tree, or a user-added folder exclusion.
 *
 * Test `aFileUnderACredentialStoreIsExcludedEvenWithAnInnocuousName` asserts
 * the second check independently, so "the scanner pruned the folder" can never
 * be mistaken for "the scanner would have refused the file".
 */

import path from 'node:path';
import type { SystemMapExclusionCategory, SystemMapExclusions } from '../../src/henry/systemMap';

/** Which exclusion categories the main process knows how to act on. */
export type ExclusionCategoryId =
  | 'otherUsers'
  | 'secrets'
  | 'browserProfiles'
  | 'systemFiles'
  | 'caches';

/** How a rule decides whether it matches. */
export type ExclusionMatch =
  /** Any directory whose name matches, at any depth. */
  | { kind: 'directoryName'; pattern: string }
  /** Any file whose name matches, at any depth. */
  | { kind: 'fileName'; pattern: string }
  /** A path that is this directory or lives inside it. */
  | { kind: 'pathPrefix'; value: string };

/** One ordered rule. */
export interface ExclusionRule {
  /** Stable id, unique within a policy. */
  id: string;
  /** The category the rule belongs to, so the UI can toggle rules as a group. */
  categoryId: ExclusionCategoryId;
  /** Plain-English reason, shown when a path is refused. */
  label: string;
  match: ExclusionMatch;
  /** Where the rule came from. User rules outrank defaults. */
  origin: 'default' | 'user';
}

/** The decision for one path. */
export type ExclusionDecision =
  | { excluded: false }
  | {
      excluded: true;
      ruleId: string;
      categoryId: ExclusionCategoryId;
      label: string;
      path: string;
    };

/** Machine facts the rules need in order to judge "other people". */
export interface ExclusionContext {
  platform: NodeJS.Platform;
  /** The signed-in user's home. Never excluded. */
  homeDir: string;
  /** The directory holding every home directory (`/home`, `/Users`, …). */
  usersRoot: string | null;
  /** Where browsers keep profiles on this platform, when known. */
  browserProfileRoots?: string[];
}

/** Every category id this module can act on. Used to validate inbound sets. */
export const KNOWN_EXCLUSION_CATEGORY_IDS: readonly string[] = [
  'otherUsers',
  'secrets',
  'browserProfiles',
  'systemFiles',
  'caches',
];

/** True when every category in the set is one this module understands. */
export function exclusionsAreUnderstood(exclusions: SystemMapExclusions): boolean {
  return exclusions.categories.every((c: SystemMapExclusionCategory) =>
    KNOWN_EXCLUSION_CATEGORY_IDS.includes(c.id),
  );
}

// ── Rule construction ────────────────────────────────────────────────────────

/** A directory-name rule. `parent` restricts it to one parent folder. */
function dir(
  name: string,
  categoryId: ExclusionCategoryId,
  label: string,
  parent?: string,
): ExclusionRule {
  return {
    id: `dir:${parent ? `${parent}/` : ''}${name}`,
    categoryId,
    label,
    match: { kind: 'directoryName', pattern: parent ? `${parent}/${name}` : name },
    origin: 'default',
  };
}

/** A file-name rule. The pattern is matched with `*` as the only wildcard. */
function file(
  pattern: string,
  categoryId: ExclusionCategoryId,
  label: string,
): ExclusionRule {
  return {
    id: `file:${pattern}`,
    categoryId,
    label,
    match: { kind: 'fileName', pattern },
    origin: 'default',
  };
}

/** An absolute-prefix rule, matched whole-segment so `/homer` ≠ `/home`. */
function prefix(
  value: string,
  categoryId: ExclusionCategoryId,
  label: string,
): ExclusionRule {
  return {
    id: `prefix:${value}`,
    categoryId,
    label,
    match: { kind: 'pathPrefix', value },
    origin: 'default',
  };
}

/**
 * The default rule set, in evaluation order.
 *
 * "Other people" is deliberately absent as a rule object: it is resolved into
 * real home paths by `buildExclusionPolicy`, because deciding it structurally
 * ("every home under `/home` that is not mine") cannot be expressed as a name
 * pattern without either leaking or over-matching.
 */
export function defaultExclusionRules(context: ExclusionContext): ExclusionRule[] {
  return [
    // ── Credential stores ─────────────────────────────────────────────────
    // Ahead of everything else: these paths hold authentication material, not
    // merely private things. `parent/name` patterns pin a profile directory to
    // its owning application so an ordinary folder called `Default` elsewhere is
    // not collateral damage.
    dir('.ssh', 'secrets', 'SSH keys'),
    dir('.gnupg', 'secrets', 'GPG keys'),
    dir('.aws', 'secrets', 'AWS credentials'),
    dir('.azure', 'secrets', 'Azure credentials'),
    dir('.kube', 'secrets', 'Kubernetes credentials'),
    dir('gcloud', 'secrets', 'Google Cloud credentials', '.config'),
    dir('.docker', 'secrets', 'Container registry credentials'),
    dir('.netrc', 'secrets', 'Network credentials'),
    dir('.pgpass', 'secrets', 'Database credentials'),
    dir('.npmrc', 'secrets', 'Package manager credentials'),
    dir('.pypirc', 'secrets', 'Package manager credentials'),
    dir('keychains', 'secrets', 'Keychain'),
    dir('Keychains', 'secrets', 'Keychain'),
    dir('1Password', 'secrets', 'Password manager'),
    dir('Bitwarden', 'secrets', 'Password manager'),
    dir('LastPass', 'secrets', 'Password manager'),
    dir('keepass', 'secrets', 'Password manager'),
    file('*.pem', 'secrets', 'Private key'),
    file('*.key', 'secrets', 'Private key'),
    file('*.p12', 'secrets', 'Private key'),
    file('*.pfx', 'secrets', 'Private key'),
    file('id_rsa*', 'secrets', 'Private key'),
    file('id_dsa*', 'secrets', 'Private key'),
    file('id_ecdsa*', 'secrets', 'Private key'),
    file('id_ed25519*', 'secrets', 'Private key'),
    file('.env', 'secrets', 'Environment file'),
    file('.env.*', 'secrets', 'Environment file'),
    file('.envrc', 'secrets', 'Environment file'),
    file('*.kdbx', 'secrets', 'Password database'),
    file('credentials*.json', 'secrets', 'Credential file'),
    file('secrets*.json', 'secrets', 'Credential file'),

    // ── Browser profiles ───────────────────────────────────────────────────
    // Cookies, saved logins, session tokens, history.
    dir('Chrome', 'browserProfiles', 'Browser profile'),
    dir('Chromium', 'browserProfiles', 'Browser profile'),
    dir('BraveSoftware', 'browserProfiles', 'Browser profile'),
    dir('google-chrome', 'browserProfiles', 'Browser profile'),
    dir('firefox', 'browserProfiles', 'Browser profile'),
    dir('.mozilla', 'browserProfiles', 'Browser profile'),
    dir('com.apple.Safari', 'browserProfiles', 'Browser profile'),
    dir('Default', 'browserProfiles', 'Browser profile', 'User Data'),
    dir('Profile 1', 'browserProfiles', 'Browser profile', 'User Data'),
    dir('Profiles', 'browserProfiles', 'Browser profile', 'Firefox'),
    ...(context.browserProfileRoots ?? []).map<ExclusionRule>((root, index) => ({
      id: `browser-root-${index}`,
      categoryId: 'browserProfiles',
      label: 'Browser profile',
      match: { kind: 'pathPrefix', value: root },
      origin: 'default',
    })),

    // ── OS trees ───────────────────────────────────────────────────────────
    // Enormous, and carrying nothing a user would want indexed. This is the
    // category the UI calls "System and application files".
    prefix('/proc', 'systemFiles', 'Operating system state'),
    prefix('/sys', 'systemFiles', 'Operating system state'),
    prefix('/dev', 'systemFiles', 'Operating system state'),
    prefix('/run', 'systemFiles', 'Operating system state'),
    prefix('/boot', 'systemFiles', 'Operating system state'),
    prefix('/private/var/db', 'systemFiles', 'Operating system state'),
    prefix('/System', 'systemFiles', 'Operating system files'),
    prefix('/Library', 'systemFiles', 'Operating system files'),
    prefix('/Applications', 'systemFiles', 'Installed applications'),
    prefix('C:\\Windows', 'systemFiles', 'Operating system files'),
    prefix('C:\\Program Files', 'systemFiles', 'Installed applications'),
    prefix('C:\\Program Files (x86)', 'systemFiles', 'Installed applications'),
    prefix('C:\\ProgramData', 'systemFiles', 'Operating system files'),

    // ── Caches ────────────────────────────────────────────────────────────
    dir('.cache', 'caches', 'Cache'),
    dir('Cache', 'caches', 'Cache'),
    dir('Caches', 'caches', 'Cache'),
    dir('cache', 'caches', 'Cache'),
    dir('.npm', 'caches', 'Cache'),
    dir('.gradle', 'caches', 'Cache'),
    dir('.Trash', 'caches', 'Temporary files'),
    dir('Trash', 'caches', 'Temporary files'),
    prefix('/tmp', 'caches', 'Temporary files'),
    prefix('/var/tmp', 'caches', 'Temporary files'),
  ];
}

/**
 * Files that are never excluded, whatever broad rule would otherwise match.
 *
 * Tiny and exact on purpose. Each entry is a file whose entire purpose is to be
 * a committed template of placeholders, so excluding it protects nothing and
 * removes a genuinely useful file from the user's own map. `.env.example` is
 * the case that matters: `.env.*` is a secrets rule, and a template matched by
 * a secrets rule is exactly the kind of over-exclusion that makes people stop
 * trusting a privacy control.
 */
const ALWAYS_INCLUDED_FILE_NAMES: Record<string, true> = {
  '.env.example': true,
  '.env.sample': true,
  '.env.template': true,
  '.env.dist': true,
};

// ── The policy ───────────────────────────────────────────────────────────────

/**
 * The exclusion policy in force for one scan: an ordered rule list plus the
 * resolved list of other people's home directories.
 *
 * Immutable, so the same instance can be handed to concurrent workers without a
 * lock.
 */
export class ExclusionPolicy {
  /** Rules in evaluation order: user rules first, then active defaults. */
  readonly rules: readonly ExclusionRule[];
  private readonly otherUserHomes: readonly string[];

  constructor(rules: readonly ExclusionRule[], otherUserHomes: readonly string[] = []) {
    this.rules = rules;
    this.otherUserHomes = otherUserHomes;
  }

  /** Should the scan descend into this directory? */
  excludesDirectory(dirPath: string): ExclusionDecision {
    return this.evaluate(dirPath, 'directory');
  }

  /**
   * Should this file be recorded at all?
   *
   * A file is judged TWICE: by its own name, and by every folder above it. The
   * second part is what makes "an innocuous file inside a credential store"
   * impossible to leak — `notes.txt` in `~/.ssh` trips the `.ssh` rule, and the
   * answer never depends on the file being named suspiciously. It is also what
   * catches a file the walk reached without descending through the denied
   * folder it lives in.
   */
  excludesFile(filePath: string): ExclusionDecision {
    const byAncestor = this.evaluateAncestors(normalize(filePath));
    return byAncestor.excluded ? byAncestor : this.evaluate(filePath, 'file');
  }

  /**
   * The single decision function behind every public check.
   *
   * Rules are consulted in order and the first match wins, so a specific rule
   * is consulted before a broad one and the reason reported is the true one.
   *
   * The allow list is consulted FIRST. It exists for names that a broad rule
   * would otherwise swallow: `.env.example` is a committed template full of
   * placeholder values, and excluding it removes a genuinely useful file from
   * the user's map while protecting nothing. The list is deliberately tiny and
   * exact — every entry is a file whose whole purpose is to be a template.
   */
  evaluate(targetPath: string, kind: 'file' | 'directory'): ExclusionDecision {
    const normalized = normalize(targetPath);
    const baseName = path.basename(normalized);

    if (kind === 'file' && ALWAYS_INCLUDED_FILE_NAMES[baseName] === true) {
      return { excluded: false };
    }

    for (const home of this.otherUserHomes) {
      if (isAtOrUnder(normalized, normalize(home))) {
        return {
          excluded: true,
          ruleId: 'other-user-homes',
          categoryId: 'otherUsers',
          label: "Someone else's folder",
          path: targetPath,
        };
      }
    }

    for (const rule of this.rules) {
      if (matches(rule, normalized, baseName, kind)) {
        return {
          excluded: true,
          ruleId: rule.id,
          categoryId: rule.categoryId,
          label: rule.label,
          path: targetPath,
        };
      }
    }
    return { excluded: false };
  }

  /**
   * Judge every folder above `targetPath` as the folder it is.
   *
   * Walked from the top down, so the OUTERMOST denied folder is the one
   * reported: `~/.config/google-chrome/Default/Cookies` is refused as a browser
   * profile, which is the useful thing to tell the user, rather than as
   * whatever the innermost rule happened to match.
   */
  private evaluateAncestors(normalized: string): ExclusionDecision {
    const segments = normalized.split('/').filter((segment) => segment.length > 0);
    for (let i = 1; i < segments.length; i += 1) {
      const ancestor = segments.slice(0, i).join('/');
      const decision = this.evaluate(ancestor, 'directory');
      if (decision.excluded) return decision;
    }
    return { excluded: false };
  }

  /** Every active rule, for display and for tests. */
  activeRules(): readonly ExclusionRule[] {
    return this.rules;
  }
}

/** Does one rule match this path? Segment-aware, so no prefix accidents. */
function matches(
  rule: ExclusionRule,
  normalizedPath: string,
  baseName: string,
  kind: 'file' | 'directory',
): boolean {
  const match = rule.match;
  switch (match.kind) {
    case 'pathPrefix':
      return isAtOrUnder(normalizedPath, normalize(match.value));
    case 'directoryName': {
      // A directory rule never applies to a file: `.ssh` as a *file* name is
      // not a credential store, and refusing it would be an unexplained hole
      // in the map.
      if (kind !== 'directory') return false;
      if (match.pattern.includes('/')) {
        // `parent/name` means "this directory, directly inside that parent".
        const segments = normalizedPath.split('/');
        const patternSegments = match.pattern.split('/');
        const at = segments.length - patternSegments.length;
        if (at < 0) return false;
        return patternSegments.every((segment, i) => segments[at + i] === segment);
      }
      return baseName === match.pattern;
    }
    case 'fileName':
      return kind === 'file' && globMatches(match.pattern, baseName);
    default:
      return false;
  }
}

/**
 * A glob with `*` as its only wildcard, anchored at both ends.
 *
 * Anchoring matters: `*.pem` must match `server.pem` and NOT
 * `server.pem.bak`, because an exclusion that leaks on a suffix is not an
 * exclusion.
 */
function globMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(value);
}

/** Normalise separators and drop a trailing slash so comparisons are stable. */
function normalize(target: string): string {
  const slashed = target.replace(/\\/g, '/');
  return slashed.length > 1 && slashed.endsWith('/') ? slashed.slice(0, -1) : slashed;
}

/**
 * True when `candidate` is `base` itself or lives beneath it, segment-wise.
 *
 * Windows comparisons are case-insensitive, because Windows paths are.
 */
function isAtOrUnder(candidate: string, base: string): boolean {
  if (!base) return false;
  const target = candidate.toUpperCase();
  const upper = base.toUpperCase();
  return target === upper || target.startsWith(`${upper}/`);
}

// ── Building a policy ────────────────────────────────────────────────────────


/** Lists the home directories under a users root. Replaced in tests. */
type UsersProbe = (root: string, platform: NodeJS.Platform) => string[] | Promise<string[]>;

let usersProbe: UsersProbe = () => [];

/** Replace the probe. Returns a restore function so a test can put it back. */
export function setUsersProbe(probe: UsersProbe): () => void {
  const previous = usersProbe;
  usersProbe = probe;
  return () => {
    usersProbe = previous;
  };
}

/**
 * Every home directory on this machine that is not the signed-in user's.
 *
 * A list rather than a pattern, because "someone else's folder" is decided
 * structurally — every home under the users root that is not mine — and no
 * name pattern expresses that without either leaking or over-matching.
 *
 * An empty list is returned when the users root cannot be read: on such a
 * machine the rest of the map is still worth having, and refusing to scan at
 * all would be the wrong failure.
 */
export async function findOtherUserHomes(context: ExclusionContext): Promise<string[]> {
  if (!context.usersRoot) return [];
  const usersRoot = normalize(context.usersRoot);
  const ownHome = normalize(context.homeDir);
  let names: string[];
  try {
    names = await usersProbe(usersRoot, context.platform);
  } catch {
    return [];
  }
  const homes: string[] = [];
  for (const name of names) {
    const candidate = `${usersRoot}/${name}`;
    if (candidate !== ownHome) homes.push(candidate);
  }
  return homes;
}

/**
 * Build the policy for a scan from the exclusion set the user actually
 * reviewed.
 *
 * The set is honoured EXACTLY. A category the user removed is genuinely
 * scanned; no removed default is merged back in. That is why the reviewed set
 * is passed through rather than merged — merging here would make the UI's
 * toggle a lie, and `aCategoryTheUserRemovedIsGenuinelyScanned` exists to keep
 * it honest.
 */
export async function buildExclusionPolicy(
  exclusions: SystemMapExclusions,
  context: ExclusionContext,
): Promise<ExclusionPolicy> {
  const enabled = new Set(exclusions.categories.map((c) => c.id));

  const userRules: ExclusionRule[] = exclusions.folders
    .filter((folder) => folder.path && folder.path.trim().length > 0)
    .map<ExclusionRule>((folder, index) => ({
      id: `user-folder:${index}:${folder.path}`,
      // A folder the user excluded by hand is their decision, not a category.
      // It carries `otherUsers` only so the type has one; the UI never shows
      // user folders under a category heading.
      categoryId: 'otherUsers',
      label: 'A folder you chose to skip',
      match: { kind: 'pathPrefix', value: folder.path },
      origin: 'user',
    }));

  const defaults = defaultExclusionRules(context).filter((rule) =>
    enabled.has(rule.categoryId),
  );

  // User folders first: an explicit personal decision outranks a shipped default.
  return new ExclusionPolicy(
    [...userRules, ...defaults],
    enabled.has('otherUsers') ? await findOtherUserHomes(context) : [],
  );
}
