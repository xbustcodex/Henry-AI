#!/usr/bin/env node
/**
 * Native dependency preparation — the single, explicit contract for better-sqlite3.
 *
 * WHY THIS EXISTS
 * Henry is cross-packaged from a Linux host for Windows x64. `better-sqlite3` is a native
 * module, so its compiled binding must match the TARGET (Windows / x86-64 / the Electron
 * ABI), not the machine doing the packaging.
 *
 * A blanket `"postinstall": "npx @electron/rebuild"` did exactly the wrong thing: it
 * reinstalled a host-appropriate (or foreign) prebuild on every install, silently
 * overwriting a correctly-prepared Windows binding with an ARM64 one. That shipped an
 * installer whose app could not boot — `better_sqlite3.node is not a valid Win32
 * application` — while every packaging step still reported success.
 *
 * The contract now:
 *   - does nothing by default, so an ordinary `npm install` is never silently destructive
 *   - prepares the HOST binding only when explicitly asked (`--host`)
 *   - prepares a TARGET binding when the target is stated explicitly
 *   - FAILS LOUDLY when a build target is requested and preparation fails. It is never
 *     `|| true`: whether this succeeds determines whether the packaged app can boot.
 *
 * Inspecting the real binary, not the filename or exit code, is deliberate.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'node_modules', 'better-sqlite3');
const BINDING = path.join(PKG, 'build', 'Release', 'better_sqlite3.node');

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const platform = flag('platform');
const arch = flag('arch');
const target = flag('target');
const electron = process.env.HENRY_ELECTRON_VERSION || '31.7.7';

/**
 * Read the architecture out of the binary itself.
 *
 * PE/COFF: the machine field sits at the same offset as in ELF's e_machine, and both
 * formats are 4-byte little-endian at that offset, so one read distinguishes them.
 *   0x014c = IMAGE_FILE_MACHINE_I386
 *   0x8664 = IMAGE_FILE_MACHINE_AMD64
 *   0xAA64 = IMAGE_FILE_MACHINE_ARM64
 * ELF e_machine: 0x3E = x86-64, 0xB7 = AArch64.
 */
export function readBinaryArch(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    // A missing binding is a fact, not a crash: it must fail the check, not the process.
    return { format: 'missing', arch: 'unknown' };
  }
  if (buf.length < 20) return { format: 'unknown', arch: 'unknown' };
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const pe = buf.readUInt32LE(0x3c);
    if (buf.slice(pe, pe + 4).toString('latin1') !== 'PE\0\0') return { format: 'pe-corrupt', arch: 'unknown' };
    const machine = buf.readUInt16LE(pe + 4);
    return {
      format: 'pe',
      arch: { 0x014c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64', 0x01c0: 'arm' }[machine] ?? `unknown(0x${machine.toString(16)})`,
    };
  }
  if (buf[0] === 0x7f && buf[1] === 0x45) {
    const machine = buf.readUInt16LE(18);
    return {
      format: 'elf',
      arch: { 0x03: 'x86', 0x3e: 'x64', 0xb7: 'arm64' }[machine] ?? `unknown(0x${machine.toString(16)})`,
    };
  }
  return { format: 'unknown', arch: 'unknown' };
}

/** The architecture Henry's Windows x64 release requires. */
export const REQUIRED = { format: 'pe', arch: 'x64' };

export function bindingSatisfies(file, required = REQUIRED) {
  const got = readBinaryArch(file);
  return got.format === required.format && got.arch === required.arch;
}

function main() {
  // Default: prepare nothing. An npm install must not silently overwrite a binding that a
  // cross-target build has already prepared.
  if (!has('host') && !platform) {
    console.log('[prepare-native] no target requested; leaving native modules untouched.');
    return;
  }
  if (!fs.existsSync(PKG)) {
    console.log('[prepare-native] better-sqlite3 not installed; nothing to prepare.');
    return;
  }

  const wantPlatform = platform || process.platform;
  const wantArch = arch || process.arch;
  const runtime = has('host') ? 'node' : 'electron';
  const args = ['prebuild-install', '--platform=' + wantPlatform, '--arch=' + wantArch];
  if (runtime === 'electron') args.push('--runtime=electron', `--target=${target || electron}`);

  console.log(`[prepare-native] ${wantPlatform}/${wantArch} (${runtime}${runtime === 'electron' ? ' ' + (target || electron) : ''})`);
  execFileSync('npx', args, { cwd: PKG, stdio: 'inherit' });

  if (!fs.existsSync(BINDING)) {
    throw new Error(`[prepare-native] no binding at ${BINDING} after preparation`);
  }
  const got = readBinaryArch(BINDING);
  console.log(`[prepare-native] binding is ${got.format}/${got.arch}`);

  // When a target was requested, verify the BINARY rather than trusting exit status.
  const wantFormat = wantPlatform === 'win32' ? 'pe' : 'elf';
  const wantArchName = wantArch === 'x64' ? 'x64' : wantArch === 'arm64' ? 'arm64' : wantArch;
  if (got.format !== wantFormat || got.arch !== wantArchName) {
    throw new Error(
      `[prepare-native] binding is ${got.format}/${got.arch} but ${wantFormat}/${wantArchName} was requested. ` +
        `The packaged application would not boot.`,
    );
  }
  console.log('[prepare-native] ok');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    // Deliberately NOT swallowed. This determines whether the packaged app can boot.
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
}
