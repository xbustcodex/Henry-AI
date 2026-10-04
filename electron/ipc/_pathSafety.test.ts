import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isInsideRoot, safeResolve } from './_pathSafety';

describe('isInsideRoot', () => {
  it('accepts the root itself and nested paths', () => {
    expect(isInsideRoot('/a/b', '/a/b')).toBe(true);
    expect(isInsideRoot('/a/b/c', '/a/b')).toBe(true);
    expect(isInsideRoot('/a/b/c/d.txt', '/a/b')).toBe(true);
  });

  it('rejects parents and unrelated paths', () => {
    expect(isInsideRoot('/a', '/a/b')).toBe(false);
    expect(isInsideRoot('/x/y', '/a/b')).toBe(false);
  });

  it('rejects the sibling-prefix escape (the bug this fixes)', () => {
    // `/a/b-evil`.startsWith(`/a/b`) is true — the old naive check let this
    // through. isInsideRoot must reject it.
    expect(isInsideRoot('/a/b-evil', '/a/b')).toBe(false);
    expect(isInsideRoot('/a/b-evil/secret', '/a/b')).toBe(false);
  });

  it('rejects ".." traversal once resolved', () => {
    expect(isInsideRoot('/a/b/../c', '/a/b')).toBe(false);
  });
});

describe('safeResolve (against a real temp filesystem)', () => {
  let base: string;
  let root: string;
  let sibling: string;
  let outside: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-pathsafety-'));
    root = path.join(base, 'workspace');
    sibling = path.join(base, 'workspace-evil'); // shares the "workspace" prefix
    outside = path.join(base, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'sibling secret');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('resolves a normal nested path inside the root', () => {
    const p = safeResolve(root, 'sub/dir/file.txt');
    expect(isInsideRoot(p, fs.realpathSync.native(root))).toBe(true);
  });

  it('allows an empty / "." request (the root itself)', () => {
    expect(() => safeResolve(root, '')).not.toThrow();
    expect(() => safeResolve(root, '.')).not.toThrow();
  });

  it('throws on ".." traversal out of the root', () => {
    expect(() => safeResolve(root, '../outside/secret.txt')).toThrow(/outside/i);
  });

  it('throws on the sibling-prefix escape', () => {
    // ../workspace-evil/secret.txt resolves to a sibling that shares the
    // "workspace" string prefix — must still be rejected.
    expect(() => safeResolve(root, '../workspace-evil/secret.txt')).toThrow(/outside/i);
  });

  it('throws on an absolute path outside the root', () => {
    expect(() => safeResolve(root, path.join(outside, 'secret.txt'))).toThrow(/outside/i);
  });

  it('throws when a symlink inside the root points outside it', () => {
    // A symlink planted in the workspace must not be usable to escape.
    const link = path.join(root, 'escape-link');
    try {
      fs.symlinkSync(outside, link, 'dir');
    } catch {
      // Some CI filesystems disallow symlinks; skip rather than fail.
      return;
    }
    expect(() => safeResolve(root, 'escape-link/secret.txt')).toThrow(/symlink|outside/i);
  });
});
