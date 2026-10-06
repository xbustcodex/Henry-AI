#!/usr/bin/env node
/**
 * Builds ONE Henry target. Henry has two:
 *
 *   node scripts/henry-build.mjs standard --linux --x64
 *   node scripts/henry-build.mjs owner    --linux --x64
 *   HENRY_TARGET=owner npm run build:linux
 *
 * The target is exported as HENRY_TARGET to the whole child process tree, so
 * `vite.config.ts`, `vite.web.config.ts` and `electron-builder` all agree —
 * there is no per-tool flag anyone can forget to pass.
 *
 * Target precedence: explicit argv word, then HENRY_TARGET, then the fail-safe
 * default. An unrecognised value is an error, never a fallback: silently
 * building something nobody asked for is how a Standard artifact acquires owner
 * code.
 *
 * electron-builder receives `--config.*` overrides rather than a second config
 * file, so `package.json`'s `build` block stays the only place that decides
 * what ships. Owner-only resource directories come from
 * `targets/ownerPolicy.json` — the same file the TypeScript guards read — so
 * the build and its guard cannot disagree about what is owner-only.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'targets', 'ownerPolicy.json'), 'utf8'));
const TARGETS = ['owner', 'standard'];
const DEFAULT_TARGET = 'standard';

const argv = process.argv.slice(2);
const requested = argv[0];
if (requested !== undefined && !TARGETS.includes(requested)) {
  console.error(`henry-build: unknown target "${requested}". Expected one of: ${TARGETS.join(', ')}.`);
  process.exit(2);
}

const env = process.env.HENRY_TARGET;
if (requested === undefined && env !== undefined && !TARGETS.includes(env.trim().toLowerCase())) {
  console.error(`henry-build: unknown HENRY_TARGET "${env}". Expected one of: ${TARGETS.join(', ')}.`);
  process.exit(2);
}

const target = requested ?? env?.trim().toLowerCase() ?? DEFAULT_TARGET;
const passthrough = requested === undefined ? argv : argv.slice(1);
const childEnv = { ...process.env, HENRY_TARGET: target };

function run(command, args) {
  const label = [command, ...args].join(' ');
  console.log(`\n[henry-build:${target}] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: childEnv,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`[henry-build:${target}] failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}


// Builder-only flags must not reach Vite. Vite uses CAC to parse argv and rejects
// `--win`/`--linux`/`--x64` outright, which failed the build before packaging began.
const BUILDER_ONLY = [
  '--linux', '--win', '--mac', '--x64', '--arm64',
  // electron-builder's publish flag; Vite's CAC parser rejects it too.
  '--publish',
];

// `--no-package` is this script's flag, not vite's or electron-builder's.
// Filter it out of the vite invocation or CAC rejects it as unknown.
// A builder flag that takes a separate value word (e.g. `--publish never`) must take
// that word with it, or Vite receives a bare `never` and fails to parse.
const skip = new Set();
passthrough.forEach((a, i) => {
  if (BUILDER_ONLY.includes(a)) {
    skip.add(a);
    if (a === '--publish' && passthrough[i + 1] && !passthrough[i + 1].startsWith('-')) {
      skip.add(passthrough[i + 1]);
    }
  }
});
const viteArgs = passthrough.filter((a) => a !== '--no-package' && !skip.has(a));
// 1. Renderer + main + preload, through the owner-target plugin.
run('npx', ['vite', 'build', ...viteArgs]);

// 2. Package. `--no-package` stops here, for a vite-only build.
if (passthrough.includes('--no-package')) {
  console.log(`[henry-build:${target}] vite build only (--no-package); artifacts are in renderer/ and dist-electron/.`);
  process.exit(0);
}

// Native dependency preparation for the TARGET, before packaging.
//
// Cross-packaging from Linux for Windows means better-sqlite3 must carry a Windows x64
// Electron-ABI binding. A blanket postinstall electron-rebuild used to clobber that with a
// foreign architecture, producing an installer that could not boot while every step
// reported success. Preparation is therefore explicit here and verified by the package
// guard afterwards.
const TARGET_NATIVE = { '--win': { platform: 'win32', arch: 'x64' }, '--linux': { platform: 'linux', arch: 'x64' }, '--mac': { platform: 'darwin', arch: 'x64' } };
const hostFlag = passthrough.find((a) => a.startsWith('--'));
const nativeTarget = TARGET_NATIVE[hostFlag];
if (nativeTarget) {
  console.log(`[henry-build] preparing native deps for ${nativeTarget.platform}/${nativeTarget.arch}`);
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'prepare-native.mjs'),
    `--platform=${nativeTarget.platform}`, `--arch=${nativeTarget.arch}`,
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[henry-build] native preparation failed for ${nativeTarget.platform}/${nativeTarget.arch}; refusing to package.`);
    process.exit(r.status ?? 1);
  }
}

const builderArgs = ['electron-builder'];
for (let i = 0; i < passthrough.length; i++) {
  const a = passthrough[i];
  if (a === '--publish' && passthrough[i + 1]) { builderArgs.push(a, passthrough[++i]); continue; }
  if (BUILDER_ONLY.includes(a) || a.startsWith('--config.')) {
    builderArgs.push(a);
  }
}

// A standard build must not carry owner-only resources into the installer.
// `--config.extraResources` replaces the array wholesale, so it is rebuilt
// here from package.json minus anything under a declared owner-only directory.
if (target === 'standard' && policy.ownerOnlyResourceDirs.length > 0) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const extra = pkg.build?.extraResources ?? [];
  const kept = extra.filter(
    (r) => !policy.ownerOnlyResourceDirs.some((d) => String(r.from).replace(/\\/g, '/').startsWith(d))
  );
  if (kept.length !== extra.length) {
    builderArgs.push(`--config.extraResources=${JSON.stringify(kept)}`);
    console.log(`[henry-build:standard] dropped ${extra.length - kept.length} owner-only extraResources entries`);
  }
}

run('npx', builderArgs);
console.log(`\n[henry-build:${target}] done.`);
