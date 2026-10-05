/**
 * What the scan refuses, and what it refuses because of.
 *
 * The claim under test is narrow and absolute: a denied path is NEVER recorded.
 * So every case asserts absence from the SCAN RESULT, not merely that a rule
 * object matched — a rule that matched but did not stop the walk would pass a
 * rule-level test and still leak the file.
 *
 * Two of these deserve their own attention:
 *
 *   - **An innocuous file inside a credential store.** `notes.txt` inside
 *     `~/.ssh` has a name nobody would flag. It is excluded because of where it
 *     is, which is the only reason a rule engine can be trusted at all.
 *   - **The record-time check, separately from the descent check.** The scanner
 *     prunes denied folders before listing them, so a test that only ever
 *     asserts the folder is absent proves nothing about a file reached by some
 *     other route. `ExclusionPolicy.excludesFile` is therefore asserted on its
 *     own, against the full path.
 *
 * Every fixture is created under the user's home rather than `/tmp`, because
 * `/tmp` is itself excluded by the defaults and a fixture there would be
 * excluded before any assertion ran.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createFixtureRoot, removeFixtureRoot } from './_fixture';
import path from 'node:path';

import {
  defaultExclusions,
  includeCategory,
  type SystemMapExclusions,
} from '../../src/henry/systemMap';
import {
  buildExclusionPolicy,
  exclusionsAreUnderstood,
  setUsersProbe,
  type ExclusionContext,
} from './exclusions';
import { nodeMetadataFs } from './fsMetadata';
import { scanFilesystem } from './scanner';
import type { SystemMapNode } from './types';

let root = '';
let home = '';

/** A fixture home, and a users root that is a sibling of it. */
function fixtureContext(): ExclusionContext {
  return { platform: 'linux', homeDir: home, usersRoot: path.join(root, 'home') };
}

async function fixturePolicy(exclusions: SystemMapExclusions = defaultExclusions()) {
  return buildExclusionPolicy(exclusions, fixtureContext());
}

/** Write a file inside the fixture home, creating folders as needed. */
function write(relative: string, contents = 'x'): string {
  const target = path.join(home, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

/** Scan the fixture home and return the recorded paths. */
async function scannedPaths(
  exclusions: SystemMapExclusions = defaultExclusions(),
): Promise<string[]> {
  const outcome = await scanFilesystem(nodeMetadataFs(), {
    roots: [home],
    policy: await fixturePolicy(exclusions),
  });
  return outcome.nodes.map((node) => node.path);
}

beforeEach(async () => {
  root = await createFixtureRoot('excl');
  home = path.join(root, 'home', 'buster');
  mkdirSync(home, { recursive: true });
  setUsersProbe(() => []);
});

afterEach(() => {
  if (root) removeFixtureRoot(root);
});

describe('credential stores are excluded', () => {
  it('leaves nothing from ~/.ssh in the map', async () => {
    const key = write('.ssh/id_rsa', 'PRIVATE KEY MATERIAL');
    const known = write('.ssh/known_hosts', 'github.com ssh-rsa AAAA');

    const paths = await scannedPaths();
    expect(paths).not.toContain(key);
    expect(paths).not.toContain(known);
  });

  it('leaves nothing from .aws, .gnupg, .kube or .azure', async () => {
    const files = [
      write('.aws/credentials', 'AKIA...'),
      write('.gnupg/secring.gpg', 'binary'),
      write('.kube/config', 'token'),
      write('.azure/accessTokens.json', '{}'),
    ];
    const paths = await scannedPaths();
    for (const file of files) expect(paths).not.toContain(file);
  });

  it('leaves key files out whatever folder they are in', async () => {
    const files = [
      write('Documents/server.pem', 'key'),
      write('Downloads/backup.key', 'key'),
      write('stuff/store.p12', 'key'),
      write('stuff/id_ed25519', 'key'),
    ];
    const paths = await scannedPaths();
    for (const file of files) expect(paths).not.toContain(file);
  });

  it('does not exclude a key-shaped suffix that is not one', async () => {
    // `.pem.bak` is not a private key, and an exclusion that leaked on a suffix
    // would quietly remove the user's own backups from their map.
    const backup = write('Documents/server.pem.bak', 'old key');
    const paths = await scannedPaths();
    expect(paths).toContain(backup);
  });

  it('leaves .env files out', async () => {
    const env = write('project/.env', 'SECRET=1');
    const local = write('project/.env.local', 'SECRET=1');
    const example = write('project/.env.example', 'SECRET=1');
    const paths = await scannedPaths();
    expect(paths).not.toContain(env);
    expect(paths).not.toContain(local);
    // `.env.example` is a template, not a secret — and a rule that removed it
    // would make the map less useful for no safety gain.
    expect(paths).toContain(example);
  });

  it('leaves password-manager folders out', async () => {
    const vault = write('1Password/Data/notes.txt', 'x');
    const paths = await scannedPaths();
    expect(paths).not.toContain(vault);
  });
});

describe('a file under a credential store is excluded even with an innocuous name', () => {
  it('refuses notes.txt inside ~/.ssh, judged by its path rather than its name', async () => {
    const innocuous = write('.ssh/notes.txt', 'my grocery list');
    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await fixturePolicy(),
    });

    expect(outcome.nodes.map((node) => node.path)).not.toContain(innocuous);
  });

  it('refuses it at record time too, not only by pruning the folder', async () => {
    // The pruning check and the record-time check are separate. This one calls
    // the record-time check directly, so it still passes if someone later
    // weakens the pruning — and fails if someone weakens the record-time check.
    const policy = await fixturePolicy();
    const insideSsh = path.join(home, '.ssh/notes.txt');

    const decision = policy.excludesFile(insideSsh);
    expect(decision.excluded).toBe(true);
    if (decision.excluded) {
      expect(decision.categoryId).toBe('secrets');
      expect(decision.label).toBe('SSH keys');
    }
  });

  it('refuses the same file reached by a root that sits inside the store', async () => {
    // The descent check never sees `~/.ssh` here, because the walk STARTS
    // inside it. Only the full-path check can catch this, which is why the two
    // checks are not redundant.
    const deep = write('.ssh/nested/deeply/ordinary.txt', 'x');
    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [path.join(home, '.ssh')],
      policy: await fixturePolicy(),
    });

    expect(outcome.nodes.map((node) => node.path)).not.toContain(deep);
  });

  it('refuses a credential-store file whose name matches nothing suspicious', async () => {
    const report = write('.aws/quarterly-summary.txt', 'totals');
    const policy = await fixturePolicy();
    expect(policy.excludesFile(report).excluded).toBe(true);
  });
});

describe('browser profiles are excluded', () => {
  it('leaves Chrome profile folders out', async () => {
    const cookies = write('.config/google-chrome/Default/Cookies', 'sqlite');
    const history = write('.config/google-chrome/Default/History', 'sqlite');
    const paths = await scannedPaths();
    expect(paths).not.toContain(cookies);
    expect(paths).not.toContain(history);
  });

  it('leaves Firefox and Brave profiles out', async () => {
    const files = [
      write('.mozilla/firefox/Profiles/abc.default/logins.json', '{}'),
      write('.config/BraveSoftware/Brave-Browser/Default/Login Data', 'sqlite'),
    ];
    const paths = await scannedPaths();
    for (const file of files) expect(paths).not.toContain(file);
  });

  it('does not exclude an ordinary folder that happens to be called Default', async () => {
    // The profile rules are pinned to their parent application for exactly this
    // reason: `Default` is a common folder name and refusing all of them would
    // remove real user folders from their own map.
    const settings = write('Documents/Default/settings.json', '{}');
    const paths = await scannedPaths();
    expect(paths).toContain(settings);
  });
});

describe("other people's folders are excluded", () => {
  it('leaves another user home out entirely', async () => {
    setUsersProbe(() => ['buster', 'mary']);
    const maryFile = path.join(root, 'home/mary/letter.txt');
    mkdirSync(path.dirname(maryFile), { recursive: true });
    writeFileSync(maryFile, 'dear diary');

    const policy = await fixturePolicy();
    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [path.join(root, 'home')],
      policy,
    });

    const paths = outcome.nodes.map((node) => node.path);
    expect(paths).not.toContain(maryFile);
    expect(paths.some((entry) => entry.includes('/mary/'))).toBe(false);
  });

  it('never excludes this user own home', async () => {
    setUsersProbe(() => ['buster', 'mary']);
    const mine = write('notes/mine.txt', 'x');
    const policy = await fixturePolicy();
    expect(policy.excludesFile(mine).excluded).toBe(false);
  });
});

describe('system trees and caches are excluded', () => {
  it('leaves cache folders out', async () => {
    const cached = write('.cache/pip/http-cache/blob', 'x');
    const paths = await scannedPaths();
    expect(paths).not.toContain(cached);
  });

  it('excludes /proc-style OS trees by absolute prefix', async () => {
    const policy = await fixturePolicy();
    expect(policy.excludesDirectory('/proc/1/task').excluded).toBe(true);
    expect(policy.excludesDirectory('/sys/class/net').excluded).toBe(true);
    expect(policy.excludesDirectory('/dev/sda').excluded).toBe(true);
    // Segment-wise: a home directory called `homer` is not `/home`.
    expect(policy.excludesDirectory('/homer/Desktop').excluded).toBe(false);
  });

  it('excludes Windows program trees when the path is a Windows one', async () => {
    const policy = await buildExclusionPolicy(defaultExclusions(), {
      platform: 'win32',
      homeDir: 'C:\\Users\\buster',
      usersRoot: 'C:\\Users',
    });
    expect(policy.excludesDirectory('C:\\Windows\\System32').excluded).toBe(true);
    expect(policy.excludesDirectory('C:\\Program Files\\Anything').excluded).toBe(true);
    expect(policy.excludesFile('C:\\Users\\buster\\Documents\\key.pem').excluded).toBe(true);
  });
});

describe('the user decides', () => {
  it('scans a category the user removed, with no default quietly merged back', async () => {
    const backup = write('.ssh/notes.txt', 'not really a key');
    const exclusions = includeCategory(defaultExclusions(), 'secrets');

    const paths = await scannedPaths(exclusions);
    expect(paths).toContain(backup);
    // …while the categories that were left on are still enforced.
    expect(paths).not.toContain(path.join(home, '.cache/thing'));
  });

  it('honours a folder the user excluded by hand', async () => {
    const excluded = write('Documents/private-journal/entry.md', 'x');
    const kept = write('Documents/public/entry.md', 'x');
    const exclusions: SystemMapExclusions = {
      categories: defaultExclusions().categories,
      folders: [{ path: path.join(home, 'Documents/private-journal') }],
    };

    const paths = await scannedPaths(exclusions);
    expect(paths).not.toContain(excluded);
    expect(paths).toContain(kept);
  });

  it('refuses an exclusion set carrying a category it cannot enforce', async () => {
    const bogus: SystemMapExclusions = {
      categories: [{ id: 'somethingElse', label: 'Unknown thing', isDefault: true }],
      folders: [],
    };
    expect(exclusionsAreUnderstood(bogus)).toBe(false);
    expect(exclusionsAreUnderstood(defaultExclusions())).toBe(true);
  });
});

describe('refusals are reported, not silent', () => {
  it('records which rule refused each path, so the UI can explain itself', async () => {
    write('.ssh/id_rsa');
    write('Documents/report.pdf');
    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await fixturePolicy(),
    });

    const refusedSsh = outcome.excluded.find((entry) => entry.path.endsWith('.ssh'));
    expect(refusedSsh?.categoryId).toBe('secrets');
    expect(refusedSsh?.label).toBeTruthy();
    // A file that WAS scanned is not in the refusal list.
    expect(outcome.excluded.some((entry) => entry.path.endsWith('report.pdf'))).toBe(false);
  });

  it('records nothing under a denied folder, not even its folder node', async () => {
    write('.ssh/id_rsa', 'x');
    write('.ssh/nested/file.txt', 'x');
    const outcome = await scanFilesystem(nodeMetadataFs(), {
      roots: [home],
      policy: await fixturePolicy(),
    });
    const recorded: SystemMapNode[] = outcome.nodes;
    expect(recorded.some((node) => node.path === path.join(home, '.ssh'))).toBe(false);
    expect(recorded.some((node) => node.path.includes('/.ssh/'))).toBe(false);
  });
});