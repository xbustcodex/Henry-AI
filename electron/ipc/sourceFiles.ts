/**
 * Source File IPC — development mode only.
 *
 * Gives Henry's renderer the ability to read and write the actual
 * TypeScript source files of the Henry AI project (only when running
 * in development mode where the source directory is accessible).
 *
 * In production (packaged app) these handlers return a clear error
 * so tools fail gracefully rather than silently.
 *
 * IPC channels:
 *   source:read     (path: string) → string content
 *   source:write    (path: string, content: string) → true
 *   source:exists   (path: string) → boolean
 *   source:list     (dir: string) → string[] of relative paths
 */

import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

const IS_DEV = !!process.env.VITE_DEV_SERVER_URL;

/** The project root directory (only valid in dev mode). */
const PROJECT_ROOT = IS_DEV ? process.cwd() : '';

/** Allowed source subdirectories — Henry can only touch these. */
const ALLOWED_PREFIXES = [
  'src/',
  'electron/',
];

function isAllowedPath(resolved: string): boolean {
  const rel = path.relative(PROJECT_ROOT, resolved);
  return ALLOWED_PREFIXES.some((p) => rel.startsWith(p));
}

function resolveSafePath(relativePath: string): string {
  if (!IS_DEV) throw new Error('Source file access is only available in development mode.');
  const resolved = path.resolve(PROJECT_ROOT, relativePath);
  if (!resolved.startsWith(PROJECT_ROOT)) {
    throw new Error('Access denied: path escapes project root.');
  }
  if (!isAllowedPath(resolved)) {
    throw new Error(`Access denied: only src/ and electron/ are writable. Got: ${relativePath}`);
  }
  return resolved;
}

export function registerSourceFileHandlers() {
  // Read a source file
  ipcMain.handle('source:read', async (_event, filePath: string): Promise<string> => {
    const target = resolveSafePath(filePath);
    if (!fs.existsSync(target)) {
      throw new Error(`Source file not found: ${filePath}`);
    }
    return fs.readFileSync(target, 'utf-8');
  });

  // Write a source file (creates directories as needed)
  ipcMain.handle('source:write', async (_event, filePath: string, content: string): Promise<boolean> => {
    const target = resolveSafePath(filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
    return true;
  });

  // Check if a source file/dir exists
  ipcMain.handle('source:exists', async (_event, filePath: string): Promise<boolean> => {
    try {
      const target = resolveSafePath(filePath);
      return fs.existsSync(target);
    } catch {
      return false;
    }
  });

  // List TypeScript files in a source directory (max depth 3)
  ipcMain.handle('source:list', async (_event, dirPath: string): Promise<string[]> => {
    if (!IS_DEV) throw new Error('Source listing is only available in development mode.');
    const target = path.resolve(PROJECT_ROOT, dirPath);
    if (!target.startsWith(PROJECT_ROOT)) throw new Error('Access denied.');

    const results: string[] = [];
    function walk(dir: string, depth: number) {
      if (depth > 3) return;
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          walk(full, depth + 1);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          results.push(path.relative(PROJECT_ROOT, full));
        }
      }
    }
    walk(target, 0);
    return results.slice(0, 200);
  });
}
