/**
 * Where scanner tests put their fixture trees, and why that matters.
 *
 * ── The trap this exists to defuse ─────────────────────────────────────────
 *
 * Henry's defaults exclude `/tmp`, `/proc`, caches, credential stores and other
 * people's homes. So a fixture written under any of those paths is **filtered
 * out before a single assertion runs** — and the test still passes. It has simply
 * stopped testing anything, while reading exactly like a test that does.
 *
 * That is the worst possible failure mode for a safety feature: a regression
 * test for exclusions that excludes the very thing it was checking, and reports
 * green. It is invisible, it survives review, and it gets discovered only when
 * something ships broken.
 *
 * ── So the premise is asserted, not assumed ────────────────────────────────
 *
 * `createFixtureRoot` builds the fixture and then ASKS the exclusion policy
 * whether it would scan it. If the answer is no, it throws with the rule that
 * refused it. The convention therefore cannot rot quietly: either the fixture
 * moves, or — if someone deliberately changes the defaults so `/tmp` is no
 * longer excluded — this test fails and says the convention has become
 * unnecessary rather than leaving it quietly load-bearing forever.
 *
 * The alternative, which looks equivalent and is not: putting the fixtures
 * somewhere safe and leaving a comment. A comment is only read by someone
 * already suspicious. This is read by everyone who runs the suite.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { defaultExclusions } from '../../src/henry/systemMap';
import { buildExclusionPolicy, setUsersProbe } from './exclusions';

/**
 * A fresh, empty fixture root that the default exclusions WILL scan.
 *
 * Under the user's home rather than the system temp directory, and verified
 * before it is handed back.
 */
export async function createFixtureRoot(label: string): Promise<string> {
  const root = mkdtempSync(path.join(homedir(), `systemmap-${label}-`));
  // The users probe is a module-level seam; reset it so a fixture never inherits
  // another test's home listing.
  setUsersProbe(() => []);

  const decision = await buildExclusionPolicy(defaultExclusions(), {
    platform: 'linux',
    homeDir: root,
    usersRoot: null,
  }).then((policy) => policy.excludesDirectory(root));

  if (decision.excluded) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `Fixture root ${root} would be EXCLUDED by the "${decision.label}" rule (${decision.categoryId}). ` +
        'A fixture under an excluded path is filtered out before any assertion runs, so the test would ' +
        'pass while testing nothing. Move the fixture out from under that rule.',
    );
  }
  return root;
}

/** Remove a fixture root. Takes the path `createFixtureRoot` returned. */
export function removeFixtureRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}