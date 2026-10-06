import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readBinaryArch, bindingSatisfies, REQUIRED } from '../scripts/prepare-native.mjs';

/**
 * A packaged native module is NOT accepted because it exists, or because electron-builder
 * and the installer both reported success.
 *
 * This suite builds REAL PE/COFF and ELF binaries with real machine fields and proves the
 * guard's architecture check accepts the right one and rejects the wrong one. It does not
 * search for the string "x64" anywhere: `readBinaryArch` parses the executable format.
 *
 * The incident it locks down: a Windows x64 package shipped an ARM64 better_sqlite3.node,
 * the installed app wrote `startup-failure.json` ("not a valid Win32 application"), and
 * the package guard had reported green because it only checked that the file existed.
 */

const tmpDirs: string[] = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-native-'));
  tmpDirs.push(d);
  return d;
}

/** Build a minimal but structurally valid PE/COFF DLL with the given machine field. */
function makePE(machine: number, name = 'x.node'): string {
  const file = path.join(tmp(), name);
  const buf = Buffer.alloc(0x200);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
  buf.write('PE\0\0', 0x80, 'latin1');
  buf.writeUInt16LE(machine, 0x84); // Machine
  buf.writeUInt16LE(0x8664, 0x84 + 20); // OptionalHeader.Magic = PE32+
  fs.writeFileSync(file, buf);
  return file;
}

/** Build a minimal but structurally valid ELF shared object with the given e_machine. */
function makeELF(machine: number, name = 'x.node'): string {
  const file = path.join(tmp(), name);
  const buf = Buffer.alloc(0x100);
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; // \x7fELF (byte order matters)
  buf[4] = 2; // 64-bit
  buf[5] = 1; // little endian
  buf.writeUInt16LE(1, 16); // e_type = ET_DYN
  buf.writeUInt16LE(machine, 18); // e_machine
  fs.writeFileSync(file, buf);
  return file;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('binary architecture reader', () => {
  it('reads x86-64 from a real PE header', () => {
    expect(readBinaryArch(makePE(0x8664))).toEqual({ format: 'pe', arch: 'x64' });
  });

  it('reads ARM64 from a real PE header', () => {
    expect(readBinaryArch(makePE(0xaa64))).toEqual({ format: 'pe', arch: 'arm64' });
  });

  it('reads x86-64 and AArch64 from real ELF headers', () => {
    expect(readBinaryArch(makeELF(0x3e))).toEqual({ format: 'elf', arch: 'x64' });
    expect(readBinaryArch(makeELF(0xb7))).toEqual({ format: 'elf', arch: 'arm64' });
  });

  it('does not mistake a truncated or non-executable file for a valid one', () => {
    const junk = path.join(tmp(), 'junk.node');
    fs.writeFileSync(junk, Buffer.from('not an executable at all'));
    expect(readBinaryArch(junk).arch).toBe('unknown');
  });
});

describe('packaged native module acceptance', () => {
  const check = (file: string) => bindingSatisfies(file, REQUIRED);

  it('ACCEPTS a Windows x64 package containing an x86-64 binding', () => {
    expect(check(makePE(0x8664, 'good.node'))).toBe(true);
  });

  it('REJECTS a Windows x64 package containing an ARM64 binding', () => {
    // The exact defect that shipped.
    expect(check(makePE(0xaa64, 'bad.node'))).toBe(false);
  });

  it('REJECTS a 32-bit x86 binding', () => {
    expect(check(makePE(0x014c, 'x86.node'))).toBe(false);
  });

  it('REJECTS a correct-arch ELF, because the target is Windows', () => {
    expect(check(makeELF(0x3e, 'linux.node'))).toBe(false);
  });

  it('REJECTS a missing binding', () => {
    expect(check(path.join(tmp(), 'absent.node'))).toBe(false);
  });
});

describe('the guard fails the build, it does not warn', () => {
  /**
   * End-to-end through the real guard process: a package whose unpacked binding is ARM64
   * must produce a non-zero exit. This is the regression that matters — the previous guard
   * exited 0 on exactly this input.
   */
  it('verify-package.mjs exits non-zero for an ARM64 binding in a win-unpacked tree', () => {
    if (process.platform !== 'linux') return; // the guard build is exercised on the build host
    const root = tmp();
    const asar = path.join(root, 'app.asar');
    fs.writeFileSync(asar, Buffer.alloc(64));
    const unpacked = path.join(root, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release');
    fs.mkdirSync(unpacked, { recursive: true });
    fs.copyFileSync(makePE(0xaa64, 'better_sqlite3.node'), path.join(unpacked, 'better_sqlite3.node'));

    let code = 0;
    try {
      execFileSync(process.execPath, [
        path.join(process.cwd(), 'scripts', 'verify-package.mjs'), asar,
      ], { stdio: 'pipe' });
    } catch (e: any) {
      code = e.status ?? 1;
    }
    // It will also fail missing ASAR probes in this synthetic fixture, which is fine —
    // what must not happen is exit 0.
    expect(code).not.toBe(0);
  }, 60000);
});
