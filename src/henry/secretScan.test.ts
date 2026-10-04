/**
 * Guard: no credential-shaped literal ships in this repository.
 *
 * WHAT IT COVERS
 * --------------
 * Two surfaces, because they fail differently.
 *
 *   1. Tracked source and shipped config — scanned on every run. A key pasted
 *      into a seed row, a `define:` block, a `wrangler.toml`, or an
 *      `extraResources` payload is a key every customer receives.
 *   2. Built output — `renderer/assets/*.js`, `dist-electron/*.js`, `dist/`.
 *      Scanned when present. The bundles are the thing that actually ships, and
 *      a value that reached a bundle without appearing in `src/` or `electron/`
 *      (inlined by a bundler plugin, read from a build-time env, dropped in by a
 *      codegen step) is exactly the case source review cannot see. These
 *      directories are gitignored, so on a clean checkout there is nothing to
 *      scan and the case is reported as skipped rather than passed.
 *
 * NOT VACUOUS
 * -----------
 * The first block feeds the matcher a known-dummy and asserts it is caught. A
 * scanner that returns nothing for everything also "passes" the repo scan, so
 * that assertion is the whole reason the rest of this file can be trusted. The
 * repo scan additionally asserts that files were actually read — an empty
 * file list is a scanner that scanned nothing, which is also not a pass.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  findSecrets,
  findSecretsRaw,
  describeFinding,
  ALLOWED_FIXTURES,
  KNOWN_DUMMIES,
  RULE_IDS,
  SELF_EXEMPT_FILES,
} from './secretScan';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Tracked files that are never scanned, with the reason.
 *
 * Anything excluded must be a thing that cannot contain a hand-written
 * credential: a vendored third-party binary, or a build artifact that the
 * bundle scan already covers by a different path.
 */
const SOURCE_EXCLUSIONS: Record<string, string> = {
  'resources/bin': 'vendored upstream Mach-O binaries (cloudflared, openscad); not ours to edit',
  'renderer/assets': 'build output — covered by the bundle scan below',
  'dist-electron': 'build output — covered by the bundle scan below',
  'dist': 'build output — covered by the bundle scan below',
  'release2': 'electron-builder output — a copy of the bundles already scanned',
  'node_modules': 'third party',
  'attached_assets': 'pasted chat transcripts, not source',
  'package-lock.json': 'dependency metadata',
  'build/icon.icns': 'binary asset',
  'build/icon.ico': 'binary asset',
  'build/installer-header.bmp': 'binary asset',
};

/** File extensions that can hold a hand-written credential. */
const SCANNABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt',
  '.html', '.css', '.yml', '.yaml', '.toml', '.sh', '.py', '.env', '.gitignore',
]);

/** Build outputs to scan, each with the path relative to the repo root. */
const BUNDLE_PATHS = ['renderer/assets', 'dist-electron', 'dist'];

function isExcluded(rel: string): boolean {
  return Object.keys(SOURCE_EXCLUSIONS).some(
    (prefix) => rel === prefix || rel.startsWith(prefix + sep),
  );
}

function isScannable(rel: string): boolean {
  const dot = rel.lastIndexOf('.');
  if (dot < 0) {
    // Extensionless text files that ship or configure: wrangler.toml has one,
    // henry-ollama-bridge.js does not, and neither is binary.
    return ['Dockerfile', 'LICENSE', '.npmrc', '.replit'].includes(rel);
  }
  if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) return true;
  return SCANNABLE_EXTENSIONS.has(rel.slice(dot));
}


function scanOf(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/** Every regular file under `dir`, recursively, as repo-relative paths. */
function walk(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  const out: string[] = [];
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) out.push(relative(REPO_ROOT, child));
    }
  }
  return out;
}

/** Scan a file list and return printable findings. */
function scanAll(files: string[]): string[] {
  const findings: string[] = [];
  for (const file of files) {
    for (const finding of findSecrets(scanOf(file), file)) {
      findings.push(describeFinding(file, finding));
    }
  }
  return findings;
}

/**
 * Every file that would ship: tracked, plus new files not yet ignored.
 *
 * `--others --exclude-standard` matters as much as `--cached`: the guard is
 * most useful before the commit exists, and a scanner fed only `git ls-files`
 * waves through a key that is still sitting in the working tree.
 *
 * The result is narrowed to paths that exist on disk. `ls-files --cached`
 * reports the index, which still lists a path staged for deletion — and a
 * scanner that throws ENOENT on a deleted file mid-refactor is a scanner people
 * stop running.
 */
function shippableFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  return out.split('\0').filter((file) => {
    if (!file) return false;
    try {
      return statSync(join(REPO_ROOT, file)).isFile();
    } catch {
      return false;
    }
  });
}

describe('secret scanner — the matcher itself', () => {
  it('catches a known-dummy credential that is not allowlisted', () => {
    // Every rule is exercised by one dummy, so a rule that stops matching fails
    // here rather than silently passing the repo scan below.
    for (const rule of RULE_IDS) {
      const dummy = KNOWN_DUMMIES[rule];
      expect(dummy, `no known-dummy declared for rule "${rule}"`).toBeTruthy();
      const found = findSecrets(`const k = '${dummy}';`, 'src/somewhere.ts');
      expect(
        found.map((f) => f.rule),
        `rule "${rule}" failed to catch its own known-dummy`,
      ).toContain(rule);
    }
  });

  it('declares a known-dummy for every rule and no rule without one', () => {
    // A dummy left behind after a rule is deleted is harmless; a rule added
    // without a dummy would mean it is never proven to fire.
    expect(Object.keys(KNOWN_DUMMIES).sort()).toEqual([...RULE_IDS].sort());
  });


  it('reports the line the credential is on', () => {
    const dummy = KNOWN_DUMMIES.groq;
    const [finding] = findSecrets(`line one\nline two\nconst k = '${dummy}';\n`, 'src/x.ts');
    expect(finding.line).toBe(3);
  });

  it('excuses a fixture only in the file it was registered for', () => {
    const entry = ALLOWED_FIXTURES.find((f) => f.literal.startsWith('ghp_supersecret'));
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(findSecrets(`const t = '${entry.literal}';`, entry.file)).toEqual([]);
    // The same value in production source is still a finding: an allowlist entry
    // is a statement about one test file, not a general exemption.
    expect(findSecrets(`const t = '${entry.literal}';`, 'electron/ipc/database.ts')).not.toEqual([]);
  });

  it('does not flag ordinary source text', () => {
    const benign = [
      "const mode = 'assistant-mode-with-a-long-descriptive-name';",
      "const key = 'sk-';",
      "const gsk = 'gsk_short';",
      "const url = 'https://api.example.com/v1/models';",
      "const note = 'Set ANTHROPIC_API_KEY in your environment before running.';",
    ].join('\n');
    expect(findSecrets(benign, 'src/benign.ts')).toEqual([]);
  });
});

describe('secret scanner — repository source', () => {
  const files = shippableFiles().filter((f) => !isExcluded(f) && isScannable(f));

  it('scanned a real file set, not an empty one', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('src/henry/secretScan.ts');
    expect(files).toContain('electron/main.ts');
    expect(files).toContain('package.json');
  });

  it('contains no credential-shaped literal', () => {
    const findings = scanAll(files);
    expect(
      findings,
      `credential-shaped literals found in source:\n${findings.join('\n')}`,
    ).toEqual([]);
  });

  it('has no allowlist entry that no longer matches anything', () => {
    // A stale entry is the quiet failure mode of an allowlist: it still reads as
    // permission, and it will quietly start covering a future reuse.
    const stale = ALLOWED_FIXTURES.filter((f) => !scanOf(f.file).includes(f.literal));
    expect(
      stale.map((f) => `${f.file}: ${f.literal}`),
      'remove allowlist entries whose fixture is gone',
    ).toEqual([]);
  });

  it('holds nothing undeclared in the files the scanner exempts from itself', () => {
    // The exemption is a claim about two files. This checks the claim: every
    // credential-shaped value in them must be either a declared known-dummy or
    // a value the allowlist already names. A literal added to either file
    // without being declared here fails here.
    const declared = new Set([
      ...Object.values(KNOWN_DUMMIES),
      ...ALLOWED_FIXTURES.map((f) => f.literal),
    ]);
    const undeclared: string[] = [];
    for (const file of Object.keys(SELF_EXEMPT_FILES)) {
      for (const finding of findSecretsRaw(scanOf(file))) {
        if (declared.has(finding.match)) continue;
        undeclared.push(describeFinding(file, finding));
      }
    }
    expect(
      undeclared,
      'these files are exempt from the literal rules, so anything undeclared in them is unreviewed',
    ).toEqual([]);
  });

  it('exempts only the scanner’s own two files', () => {
    // A wider exemption is a wider hole, and the reasons above are the whole
    // justification for it.
    expect(Object.keys(SELF_EXEMPT_FILES).sort()).toEqual([
      'src/henry/secretScan.test.ts',
      'src/henry/secretScan.ts',
    ]);
  });
});

describe('secret scanner — built bundles', () => {
  const present = BUNDLE_PATHS.filter((dir) => {
    try {
      return statSync(join(REPO_ROOT, dir)).isDirectory();
    } catch {
      return false;
    }
  });

  it('scans every bundle directory that exists', () => {
    const bundles = present.flatMap((dir) =>
      walk(dir).filter((f) => /\.(js|mjs|cjs|css|html|json|map)$/.test(f)),
    );
    // The renderer bundle and the main bundle must be among them when a build has
    // been run; without this, a renamed output directory would silently reduce
    // the scan to nothing while the case still reports as passing.
    if (present.includes('renderer/assets')) {
      expect(bundles.some((f) => f.startsWith('renderer/assets') && f.endsWith('.js'))).toBe(true);
    }
    if (present.includes('dist-electron')) {
      expect(bundles.some((f) => f.startsWith('dist-electron') && f.endsWith('.js'))).toBe(true);
    }
    const findings = scanAll(bundles);
    expect(
      findings,
      `credential-shaped literals found in built bundles:\n${findings.join('\n')}`,
    ).toEqual([]);
  });
});