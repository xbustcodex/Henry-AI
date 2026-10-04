/**
 * Guard: a published release must be able to update an installed Henry, and a
 * tag must not publish over a live stable release.
 *
 * WHY THIS IS NOT COVERED BY ANY OTHER TEST
 * -----------------------------------------
 * The update chain ends in GitHub, not in the app. `scripts/release.sh` and
 * `.github/workflows/desktop-release.yml` run on the owner's machine or in CI;
 * no functional test in this suite ever executes them. The failure they permit
 * is invisible from inside a running Henry: the release exists, the downloads
 * work, the app reports no error — and every installed copy quietly stays on
 * its current version forever, because electron-updater asked the release for
 * `latest-mac.yml` / `latest.yml` / `latest-linux.yml` and got a 404.
 *
 * So the guards are:
 *   1. behavioural — the release script is executed against a fixture artifact
 *      directory with a stubbed `curl`, and the assertions are on what it does
 *      (refuses, names the omission, uploads the metadata), not on its text.
 *   2. structural — the workflow is parsed as YAML and its jobs inspected, so a
 *      `--publish always` that is not gated on a tag, or a pre-release tag
 *      published without the pre-release flag, fails here.
 *
 * The script runs for real in these tests, which is why it takes its artifact
 * directory, repo slug and API endpoints from the environment:
 * RELEASE_ARTIFACT_DIR, HENRY_RELEASE_REPO, GITHUB_API_URL, GITHUB_UPLOADS_URL.
 * `curl` is shadowed by a stub on PATH, so nothing here can reach GitHub.
 *
 * `src/henry/releaseRouting.test.ts` covers the other half of the same surface —
 * that these files route releases at THIS project's owner. Together the two
 * files pin every way a release can be published wrong.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RELEASE_SH = join(ROOT, 'scripts/release.sh');
const WORKFLOW = join(ROOT, '.github/workflows/desktop-release.yml');
const MAIN_TS = join(ROOT, 'electron/main.ts');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };

const VERSION = PKG.version;
const BETA = `${VERSION}-beta.1`;
const ZIP = `Henry AI-${VERSION}-mac.zip`;
const DMG = `Henry AI-${VERSION}.dmg`;
const DMG_ARM = `Henry AI-${VERSION}-arm64.dmg`;
const SETUP = `Henry-AI-Setup-${VERSION}-x64.exe`;
const APPIMAGE = `henry-ai-desktop-${VERSION}-x64.AppImage`;

/** electron-builder's own latest.yml shape: url + path, no blockmap field. */
const latestYml = (artifact: string, version = VERSION) =>
  `version: ${version}\nfiles:\n  - url: ${artifact}\n    sha512: c2hhYQ==\n    size: 1\npath: ${artifact}\nsha512: c2hhYQ==\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`;

// ── Running the release script for real ───────────────────────────────────────

let sandbox: string;
let binDir: string;
let artifactDir: string;
let logFile: string;

/**
 * A `curl` that records every invocation instead of making one, so a test can
 * assert both what the script tried to publish and — for the refusal cases —
 * that it never got as far as creating a release.
 */
function writeCurlStub(): void {
  writeFileSync(
    join(binDir, 'curl'),
    [
      '#!/bin/bash',
      // Find the URL among the arguments, then record it so a test can tell
      // creating a release (…/releases) from uploading an asset
      // (…/assets?name=…).
      'url=""',
      'for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done',
      'printf "%s\\t%s\\n" "$url" "$*" >> "$CURL_LOG"',
      'if [[ "$url" == *"/releases" ]]; then',
      '  echo \'{"id":4242}\'',
      'else',
      '  echo \'{"name":"asset"}\'',
      'fi',
      '',
    ].join('\n'),
  );
  chmodSync(join(binDir, 'curl'), 0o755);
}

const writeArtifact = (name: string, body = 'artifact'): void => {
  writeFileSync(join(artifactDir, name), body);
};

/** Wipe the artifact directory back to empty between cases. */
const resetArtifacts = (): void => {
  for (const name of readdirSync(artifactDir)) rmSync(join(artifactDir, name), { force: true });
  rmSync(logFile, { force: true });
};

/**
 * A complete mac release: both DMGs, the ZIP electron-updater downloads, the
 * metadata that points at it, and the block map that goes with that ZIP.
 */
const completeMacRelease = (): void => {
  writeArtifact(DMG_ARM);
  writeArtifact(DMG);
  writeArtifact(ZIP);
  writeArtifact(`${ZIP}.blockmap`);
  writeArtifact('latest-mac.yml', latestYml(ZIP));
};

/** A complete Windows release: installer, its block map, latest.yml. */
const completeWinRelease = (): void => {
  writeArtifact(SETUP);
  writeArtifact(`${SETUP}.blockmap`);
  writeArtifact('latest.yml', latestYml(SETUP));
};

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Asset names the script tried to upload. */
  uploaded: string[];
  /** Did the script get as far as creating the GitHub release? */
  createdRelease: boolean;
}

function runRelease(cwd = ROOT): RunResult {
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    GITHUB_PERSONAL_ACCESS_TOKEN: 'test-token',
    CURL_LOG: logFile,
    GITHUB_API_URL: 'https://api.test.invalid',
    GITHUB_UPLOADS_URL: 'https://uploads.test.invalid',
    HENRY_RELEASE_REPO: 'xbustcodex/Henry-AI',
    RELEASE_ARTIFACT_DIR: artifactDir,
  };
  let status = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('bash', [RELEASE_SH], { cwd, env, encoding: 'utf8' });
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    status = err.status;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
  }
  // Each log line is "<url>\t<all args>".
  const urls = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
  return {
    status,
    stdout,
    stderr,
    uploaded: urls
      .map((line) => line.split('\t')[0]!)
      .filter((url) => url.includes('/assets?name='))
      .map((url) => decodeURIComponent(url.split('name=')[1]!)),
    createdRelease: urls.some((line) => line.split('\t')[0]!.endsWith('/releases')),
  };
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'henry-release-'));
  binDir = join(sandbox, 'bin');
  artifactDir = join(sandbox, 'release2');
  logFile = join(sandbox, 'curl.log');
  mkdirSync(binDir);
  mkdirSync(artifactDir);
  writeCurlStub();
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe('scripts/release.sh — publishing a release the updater can read', () => {
  it('refuses to publish a mac release whose updater metadata is missing', () => {
    resetArtifacts();
    writeArtifact(DMG_ARM);
    writeArtifact(DMG);
    writeArtifact(ZIP);
    writeArtifact(`${ZIP}.blockmap`); // everything but latest-mac.yml

    const r = runRelease();

    expect(r.status).not.toBe(0);
    // The omission has to be nameable, not merely non-zero: a silent skip is
    // the defect this script exists to prevent.
    expect(r.stderr).toContain('latest-mac.yml');
    expect(r.stderr).toMatch(/REFUSING TO PUBLISH/i);
    // And nothing may have been published — not even a draft release.
    expect(r.createdRelease).toBe(false);
    expect(r.uploaded).toEqual([]);
  });

  it('refuses when the metadata points at an artifact with no block map', () => {
    // electron-updater fetches <artifact>.blockmap next to the artifact; a
    // release without it cannot do a differential update.
    resetArtifacts();
    writeArtifact(DMG);
    writeArtifact(ZIP);
    writeArtifact('latest-mac.yml', latestYml(ZIP)); // <zip>.blockmap absent

    const r = runRelease();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${ZIP}.blockmap`);
    expect(r.createdRelease).toBe(false);
  });

  it('refuses when the metadata points at an artifact that was never built', () => {
    resetArtifacts();
    writeArtifact(DMG);
    writeArtifact(`${ZIP}.blockmap`);
    writeArtifact('latest-mac.yml', latestYml('Henry AI-9.9.9-mac.zip')); // not built

    const r = runRelease();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('9.9.9-mac.zip');
    expect(r.createdRelease).toBe(false);
  });

  it('refuses when the metadata describes a different version', () => {
    // Stale metadata is the same silent failure as no metadata: the feed
    // resolves, serves a version every client already has, and no client
    // reports anything.
    resetArtifacts();
    writeArtifact(DMG);
    writeArtifact(ZIP);
    writeArtifact(`${ZIP}.blockmap`);
    writeArtifact('latest-mac.yml', latestYml(ZIP, '9.9.9'));

    const r = runRelease();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/stale|9\.9\.9/);
    expect(r.createdRelease).toBe(false);
  });

  it('refuses when a Windows installer has no latest.yml', () => {
    resetArtifacts();
    writeArtifact(SETUP);
    writeArtifact(`${SETUP}.blockmap`);

    const r = runRelease();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('latest.yml');
    expect(r.createdRelease).toBe(false);
  });

  it('refuses when a Windows installer has no block map', () => {
    resetArtifacts();
    writeArtifact(SETUP);
    writeArtifact('latest.yml', latestYml(SETUP)); // no .exe.blockmap

    const r = runRelease();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/exe\.blockmap/);
    expect(r.createdRelease).toBe(false);
  });

  it('refuses when a Linux AppImage has no latest-linux.yml', () => {
    resetArtifacts();
    writeArtifact(APPIMAGE);

    const r = runRelease();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('latest-linux.yml');
    expect(r.createdRelease).toBe(false);
  });

  it('refuses when the artifact directory is empty', () => {
    resetArtifacts();
    const r = runRelease();
    expect(r.status).not.toBe(0);
    expect(r.createdRelease).toBe(false);
  });

  it('publishes the metadata and block maps alongside the installers', () => {
    resetArtifacts();
    completeMacRelease();
    completeWinRelease();

    const r = runRelease();

    expect(r.status).toBe(0);
    expect(r.createdRelease).toBe(true);
    // Everything electron-updater needs, plus what a human downloads.
    for (const required of [
      'latest-mac.yml',
      'latest.yml',
      `${ZIP}.blockmap`,
      `${SETUP}.blockmap`,
      SETUP,
      DMG,
      DMG_ARM,
      ZIP,
    ]) {
      expect(r.uploaded).toContain(required);
    }
    expect(r.stdout).toMatch(/Done:/);
  });

  it('fails visibly when an upload is rejected', () => {
    // A release missing one of its assets is the same silent failure as a
    // release missing all of them, so a failed upload must not pass quietly.
    resetArtifacts();
    completeMacRelease();
    // Every response is an error, including the release creation.
    rmSync(join(binDir, 'curl'), { force: true });
    writeFileSync(
      join(binDir, 'curl'),
      ['#!/bin/bash', 'echo \'{"message":"already_exists"}\'', ''].join('\n'),
    );
    chmodSync(join(binDir, 'curl'), 0o755);

    try {
      const r = runRelease();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/already_exists|artifact\(s\) could not be uploaded/);
    } finally {
      writeCurlStub();
    }
  });

  it('marks a pre-release version as a GitHub pre-release', () => {
    // A beta released as a normal release reaches every stable client, which
    // run with allowPrerelease = false against the stable feed.
    resetArtifacts();
    writeArtifact(`Henry AI-${BETA}-mac.zip`);
    writeArtifact(`Henry AI-${BETA}-mac.zip.blockmap`);
    writeArtifact('latest-mac.yml', latestYml(`Henry AI-${BETA}-mac.zip`, BETA));

    // The version comes from package.json, so run against a beta manifest.
    const betaRoot = mkdtempSync(join(sandbox, 'beta-'));
    mkdirSync(join(betaRoot, 'scripts'));
    writeFileSync(join(betaRoot, 'package.json'), JSON.stringify({ ...PKG, version: BETA }));
    writeFileSync(join(betaRoot, 'scripts/release.sh'), readFileSync(RELEASE_SH, 'utf8'));

    const r = runRelease(betaRoot);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/prerelease: true/);
  });

  it('does not mark a stable version as a pre-release', () => {
    resetArtifacts();
    completeMacRelease();
    const r = runRelease();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/prerelease: false/);
  });
});

describe('.github/workflows/desktop-release.yml — publishing only on tags', () => {
  interface Job {
    needs?: string | string[];
    if?: string;
    outputs?: Record<string, string>;
    steps: Array<Record<string, unknown>>;
  }
  const doc = load(readFileSync(WORKFLOW, 'utf8')) as Record<string, unknown>;
  const jobs = doc.jobs as Record<string, Job>;
  // `on` is a YAML 1.1 boolean under some parsers, so look it up by either key.
  // YAML 1.1 parsers turn a bare `on:` key into the boolean true, and
  // TypeScript forbids boolean index types, so resolve it by name.
  const onKey = Object.keys(doc).find((k) => k === 'on' || k === 'true');
  const triggers = (onKey ? doc[onKey] : doc) as Record<string, unknown>;

  /** Every electron-builder invocation, with the job it belongs to. */
  const builderSteps = () =>
    Object.entries(jobs)
      .filter(([name]) => name.startsWith('build-'))
      .flatMap(([job, def]) =>
        def.steps
          .filter((s) => typeof s.run === 'string' && s.run.includes('electron-builder'))
          .map((s) => ({ job, run: s.run as string })),
      );

  const classifyRun = () => (jobs.classify.steps.find((s) => s.id === 'classify') as { run: string }).run;

  it('declares no inputs that nothing reads', () => {
    // A `version` input no step consumes is a lie on the manual-dispatch form:
    // the operator sets it and the build ignores it.
    const dispatch = triggers.workflow_dispatch;
    expect(dispatch === null || dispatch === undefined || Object.keys(dispatch as object).length === 0).toBe(true);
  });

  it('never passes a literal --publish always on any ref', () => {
    const steps = builderSteps();
    expect(steps.length).toBeGreaterThan(0);
    for (const { job, run } of steps) {
      expect(run, `${job} publishes unconditionally`).not.toMatch(/--publish\s+always/);
    }
  });

  it('takes the publish policy from the tag gate, not a literal', () => {
    // build-mac builds an unsigned DMG that is never published, so it keeps a
    // literal `never`; the publishing builders must read the gate.
    for (const job of ['build-win', 'build-linux']) {
      const step = builderSteps().find((s) => s.job === job);
      expect(step, `${job} does not build`).toBeDefined();
      expect(step!.run).toMatch(/--publish\s+"\$\{\{ needs\.classify\.outputs\.publish \}\}"/);
    }
  });

  it('gates publishing on a v* tag, and keeps the release job tag-only', () => {
    const run = classifyRun();
    expect(run).toContain('[[ "$REF" == refs/tags/v* ]] && is_tag=true');
    // A non-tag ref must resolve to `never`; a tag to `always`.
    expect(run).toContain('publish=never;');
    expect(run).toMatch(/\[ "\$is_tag" = true \] && publish=always/);
    expect(jobs.release.if).toContain("needs.classify.outputs.is_tag == 'true'");
    // ...and every builder waits for that gate.
    for (const [name, job] of Object.entries(jobs)) {
      if (!name.startsWith('build-')) continue;
      expect(job.needs, `${name} does not wait for classify`).toContain('classify');
    }
  });

  it('classifies a pre-release tag for BOTH GitHub and electron-builder', () => {
    expect(classifyRun()).toMatch(/\[\[ "\$REF_NAME" == \*-\* \]/);
    expect(Object.keys(jobs.classify.outputs ?? {})).toEqual(
      expect.arrayContaining(['is_tag', 'is_prerelease', 'publish', 'ep_pre_release']),
    );

    // The GitHub release flag.
    const release = jobs.release.steps.find((s) => s.uses === 'softprops/action-gh-release@v2') as {
      with: Record<string, string>;
    };
    expect(release.with.prerelease).toContain("needs.classify.outputs.is_prerelease == 'true'");

    // The builder flag. electron-builder 24 has no --prerelease option, and
    // package.json's publish.releaseType ("release") outranks any CLI value —
    // its GitHub publisher reads EP_PRE_RELEASE, so that is what must be set.
    for (const job of ['build-win', 'build-linux']) {
      const build = jobs[job].steps.find((s) => typeof s.run === 'string' && s.run.includes('--publish "${{')) as {
        env: Record<string, string>;
      };
      expect(build.env.EP_PRE_RELEASE, `${job} does not classify pre-releases`).toBe(
        '${{ needs.classify.outputs.ep_pre_release }}',
      );
    }
  });

  it('keeps the unsigned Mac build out of publishing entirely', () => {
    const mac = builderSteps().find((s) => s.job === 'build-mac');
    expect(mac).toBeDefined();
    expect(mac!.run).toMatch(/--publish never/);
  });
});

describe('electron/main.ts — no dead updater wiring', () => {
  const main = readFileSync(MAIN_TS, 'utf8');

  it('sends no renderer event that nothing subscribes to', () => {
    // `henry-update-ready` and `updater:progress` had no listener in the
    // preload bridge, the renderer or anywhere else: main-process work whose
    // result is thrown away.
    expect(main).not.toMatch(/henry-update-ready|updater:progress/);

    // Every updater channel the main process still sends must be one preload
    // exposes — that is the proof the listeners really are reachable.
    const preload = readFileSync(join(ROOT, 'electron/preload.ts'), 'utf8');
    const sent = [...main.matchAll(/webContents\.send\('(updater:[^']+)'/g)].map((m) => m[1]!);
    expect(sent.length).toBeGreaterThan(0);
    for (const channel of sent) {
      expect(preload, `${channel} has no preload listener`).toContain(`'${channel}'`);
    }
  });

  it('schedules one startup update check, not two', () => {
    // A 30s and a 10s timer meant every launch hit the update feed twice,
    // twenty seconds apart, for no reason.
    const startupChecks = [...main.matchAll(/setTimeout\((?:async )?\(\) => \{[^}]*autoUpdater\.checkForUpdates\(\)/g)];
    expect(startupChecks).toHaveLength(1);
    // The periodic check survives.
    expect(main).toContain('setInterval(');
  });
});