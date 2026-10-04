/**
 * Guard: update and release ROUTING points at Henry's own infrastructure.
 *
 * WHY THIS IS NOT COVERED BY ANY OTHER TEST
 * -----------------------------------------
 * Every behaviour test in this suite exercises the running app. The update
 * chain is the opposite: an installed Henry reads `resources/app-update.yml`
 * — a file electron-builder writes at build time from `build.publish` — and
 * only ever talks to whatever owner/repo is named there. Nothing at runtime
 * can observe that the name is wrong; the app simply updates from someone
 * else's releases, forever, and every test still passes. The same is true of
 * the release token and signing identity baked into the build config: an
 * `identity` or a `CSC_LINK` naming a foreign account is invisible to a
 * functional test because signing happens in a builder that CI does not run
 * the assertions for.
 *
 * So the guard is on the config itself, in the same spirit as
 * `groqRemoval.test.ts` — and for the same reason it lives outside the files
 * it checks: a fixture that reintroduced the old owner would otherwise be the
 * one file the guard could not read.
 *
 * SCOPE — active routing and signing identity only. Historical attribution
 * (README's "Built by", CHANGELOG history, the old repo name in prose) is
 * deliberately NOT matched. The requirement is that no installed build trusts
 * or contacts another party's release infrastructure, not that the project's
 * history is erased.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = new URL('../../', import.meta.url);

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, ROOT)), 'utf8');

const pkg = JSON.parse(read('package.json')) as {
  author: { name: string; email: string };
  build: {
    publish: { provider: string; owner: string; repo: string; private: boolean; releaseType: string };
    mac: Record<string, unknown>;
    win: Record<string, unknown>;
  };
  scripts: Record<string, string>;
};

/**
 * Identity fragments that belonged to the project BEFORE it became standalone.
 *
 * - `tophercook7-maker` — the old GitHub owner, in the two shapes it can take:
 *   a path segment (`tophercook7-maker/repo`) or electron-builder's split
 *   `"owner": "…"` field. The bare owner URL in the README's "Built by" line is
 *   attribution we keep on purpose; routing at an old repository is not.
 * - `NFS22LSQRC` — the old Apple Developer Team ID.
 */
const FOREIGN_OWNER = /tophercook7-maker\/[A-Za-z0-9_.-]+|["']owner["']\s*:\s*["']tophercook7-maker["']|NFS22LSQRC/i;

/** Files that can route a build or an installed app at a release. */
const ROUTING_FILES = [
  'package.json',
  'scripts/notarize.cjs',
  'scripts/release.sh',
  'README.md',
  '.github/workflows/desktop-release.yml',
] as const;

describe('release routing — the new project', () => {
  it('publishes to xbustcodex/Henry-AI over the public GitHub releases feed', () => {
    // These three fields ARE the installed app's update feed. electron-builder
    // copies them verbatim into resources/app-update.yml; electron-updater
    // resolves them to https://github.com/<owner>/<repo>/releases/download/<tag>/<file>.
    expect(pkg.build.publish.provider).toBe('github');
    expect(pkg.build.publish.owner).toBe('xbustcodex');
    expect(pkg.build.publish.repo).toBe('Henry-AI');
    // `private: true` would make electron-updater attach GH_TOKEN from the
    // user's environment to every metadata request.
    expect(pkg.build.publish.private).toBe(false);
    expect(pkg.build.publish.releaseType).toBe('release');
  });

  it.each(ROUTING_FILES)('%s routes releases at no other owner', (file) => {
    expect(read(file)).not.toMatch(FOREIGN_OWNER);
  });

  it('the foreign-owner matcher is not vacuous', () => {
    // A guard that cannot fail is not a guard.
    expect('"owner": "tophercook7-maker"').toMatch(FOREIGN_OWNER);
    expect('"identity": "Christopher Cook (NFS22LSQRC)"').toMatch(FOREIGN_OWNER);
  });
});

describe('signing identity — never inherited from a previous owner', () => {
  it('names no macOS signing identity at all', () => {
    // electron-builder auto-selects a certificate from the build machine's
    // keychain when this is absent. Hardcoding one would pin every release to
    // whichever account that certificate belongs to.
    expect(pkg.build.mac).not.toHaveProperty('identity');
  });

  it('defines no Windows code-signing certificate or key password', () => {
    // Until Henry owns a certificate there is nothing to point at. A cert path
    // here would be the old owner's, or worse a checked-in .pfx.
    expect(pkg.build.win).not.toHaveProperty('signingCertificateFile');
    expect(pkg.build.win).not.toHaveProperty('signingCertificateHash');
    expect(pkg.build.win).not.toHaveProperty('signingCertificateSubjectName');
    expect(pkg.build.win).not.toHaveProperty('signtoolOptions');
  });

  it('ships no release token or publisher credential in a shipped config', () => {
    // Release credentials belong to build infrastructure. Anything in package.json
    // reaches every customer, because electron-builder copies build config into
    // the app resources.
    const serialised = read('package.json');
    expect(serialised).not.toMatch(/CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|APPLE_APP_PASSWORD|GH_TOKEN|GITHUB_TOKEN/);
  });

  it('never notarizes under a hardcoded Apple team', () => {
    const hook = read('scripts/notarize.cjs');
    expect(hook).not.toMatch(/teamId\s*:\s*process\.env\.APPLE_TEAM_ID\s*\|\|/);
    // teamId must come from the environment, not from a literal in the source.
    expect(hook).toMatch(/teamId:\s*APPLE_TEAM_ID\b/);
  });
});

describe('update channel — stable only', () => {
  it('pins a single release channel and does not advertise prereleases', () => {
    // A custom channel would make installed builds follow a `beta.yml` feed.
    // `allowPrerelease` lives in the main process, not the build config; this
    // asserts the build config contributes no second channel.
    expect(pkg.build.publish).not.toHaveProperty('channel');
  });

  it('exposes no user-settable update feed', () => {
    // A settings key that rewrites the feed would let a fresh install be
    // pointed at any server. None exists; assert the absence so adding one is
    // a deliberate, reviewable act.
    expect(read('src/henry/settingsContract.ts')).not.toMatch(/update_feed|feed_url|update_url/i);
  });
});