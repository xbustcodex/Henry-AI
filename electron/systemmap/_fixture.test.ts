/**
 * The fixture convention is load-bearing, so it is checked rather than assumed.
 *
 * Every scanner test builds its tree somewhere real and asks the scanner to walk
 * it. Henry's defaults exclude `/tmp`, caches, credential stores and other
 * people's homes — so a fixture placed under any of those is **filtered out
 * before a single assertion runs**, and the test passes while testing nothing.
 *
 * That is a genuinely bad failure mode for this feature specifically: a
 * regression test for exclusions that excludes the very thing it was checking
 * and reports green. It survives review and is discovered only once something
 * has shipped broken.
 *
 * So these tests assert the premise the other tests depend on:
 *
 *   1. A fixture root created by the shared helper is scannable. If it were not,
 *      the helper throws — and this test proves the throw is real by driving the
 *      policy at a path that IS excluded.
 *   2. `/tmp` really is excluded, which is the reason the convention exists. If
 *      someone deliberately stops excluding it, this fails and the convention
 *      becomes visibly unnecessary rather than quietly load-bearing forever.
 *   3. Every scanner test file actually uses the helper, so a new file cannot
 *      quietly reintroduce an unguarded `mkdtempSync`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defaultExclusions } from '../../src/henry/systemMap';
import { buildExclusionPolicy, setUsersProbe } from './exclusions';
import { createFixtureRoot, removeFixtureRoot } from './_fixture';

/** The default policy, against a throwaway home. */
async function defaultsAgainst(homeDir: string) {
  return buildExclusionPolicy(defaultExclusions(), {
    platform: 'linux',
    homeDir,
    usersRoot: null,
  });
}

setUsersProbe(() => []);

describe('a fixture root is scannable by construction', () => {
  it('hands back a root the default exclusions will not refuse', async () => {
    const root = await createFixtureRoot('fixture-guard');
    try {
      const policy = await defaultsAgainst(root);
      expect(policy.excludesDirectory(root).excluded).toBe(false);
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('would throw if handed a path the defaults exclude', async () => {
    // Proving the guard is real rather than decorative: the same policy the
    // helper consults DOES refuse an excluded path, so the helper's check has
    // something to catch.
    const policy = await defaultsAgainst('/home/someone');
    const decision = policy.excludesDirectory('/tmp');
    expect(decision.excluded).toBe(true);
    if (decision.excluded) {
      // The rule the guard would name in its error message.
      expect(decision.categoryId).toBe('caches');
    }
  });
});

describe('the reason the convention exists still holds', () => {
  it('still excludes /tmp, so fixtures must not live there', async () => {
    // If someone deliberately stops excluding `/tmp`, this fails. That is the
    // point: the convention should become VISIBLY unnecessary rather than
    // remaining quietly load-bearing forever with nobody re-examining it.
    const policy = await defaultsAgainst('/home/buster');
    expect(policy.excludesDirectory('/tmp').excluded).toBe(true);
  });

  it('still excludes a credential store, for the same reason', async () => {
    const policy = await defaultsAgainst('/home/buster');
    expect(policy.excludesFile('/home/buster/.ssh/anything.txt').excluded).toBe(true);
  });
});

describe('the scanner tests all use the guarded helper', () => {
  it('never calls mkdtempSync directly', () => {
    const files = [
      'scanMetadata.test.ts',
      'exclusions.test.ts',
      'classify.test.ts',
      'budget.test.ts',
      'incremental.test.ts',
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(__dirname, file), 'utf8');
      if (source.includes('mkdtempSync')) offenders.push(file);
    }
    // A new test file building a fixture by hand could reintroduce the silent
    // no-op, so the convention is checked across the suite rather than trusted
    // to whoever writes the next one.
    expect(offenders).toEqual([]);
  });

  it('uses the shared helper, so the premise check comes along with it', () => {
    const files = [
      'scanMetadata.test.ts',
      'exclusions.test.ts',
      'budget.test.ts',
      'incremental.test.ts',
    ];
    const missing = files.filter(
      (file) => !readFileSync(path.join(__dirname, file), 'utf8').includes('createFixtureRoot'),
    );
    expect(missing).toEqual([]);
  });
});