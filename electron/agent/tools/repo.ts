/**
 * Build Mode — repo tools (build plan, Phase 4). Henry's first ability to read
 * and *edit* code, built safety-first:
 *
 *   - `repo_status` / `repo_read`  → read-only inspection ('silent').
 *   - `repo_edit`                  → writes a file, but at 'confirm' safety so it
 *                                    routes through the Approval Queue, and only
 *                                    after backing the file up (reversible).
 *
 * Hard safety rails enforced here, not left to the model:
 *   - Sandbox: never touch paths outside the user's home, never anything that
 *     looks like keys/secrets (.ssh, .keys, .env, *.pem, *.key, …).
 *   - Edits must live inside a git repository, so every change is tracked and
 *     revertable with git as well as the local backup.
 *   - There is no autonomous "apply" — every edit waits for the user's OK.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition, ToolResult } from '../types';

const execFileP = promisify(execFile);

const BLOCKED_DIR_SEGMENTS = ['.ssh', '.keys', '.aws', '.gnupg', '.password-store', 'keychains'];
const BLOCKED_FILE_PATTERNS = [
  /(^|\.)env($|\.)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.keychain/i,
  /id_rsa/i, /id_ed25519/i, /credentials/i, /\.secret/i, /notarize/i,
];

/** Resolve `p` to an absolute path and enforce the sandbox. Throws on violation. */
async function safeResolve(p: string): Promise<string> {
  if (!p || typeof p !== 'string') throw new Error('A path is required.');
  const expanded = p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
  const abs = path.resolve(expanded);

  // Realpath the nearest existing ancestor (write targets may not exist yet),
  // so symlinks can't escape the sandbox.
  let probe = abs;
  while (probe !== path.dirname(probe)) {
    try { probe = await fs.realpath(probe); break; } catch { probe = path.dirname(probe); }
  }
  const home = await fs.realpath(homedir());
  if (!(`${probe}${path.sep}`).startsWith(`${home}${path.sep}`) && probe !== home) {
    throw new Error('Refusing to access paths outside your home directory.');
  }
  const segs = abs.split(path.sep).map((s) => s.toLowerCase());
  for (const blocked of BLOCKED_DIR_SEGMENTS) {
    if (segs.includes(blocked)) throw new Error(`Refusing to access a protected directory (${blocked}).`);
  }
  if (BLOCKED_FILE_PATTERNS.some((re) => re.test(path.basename(abs)))) {
    throw new Error('Refusing to touch a file that looks like it holds secrets or credentials.');
  }
  return abs;
}

/** Walk up from a file/dir to find the enclosing git work tree, or null. */
async function findGitRoot(start: string): Promise<string | null> {
  let dir = (await fs.stat(start).catch(() => null))?.isDirectory() ? start : path.dirname(start);
  while (true) {
    if (await fs.stat(path.join(dir, '.git')).then(() => true).catch(() => false)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Compact, dependency-free line diff summary for review + the audit record. */
function diffSummary(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const setA = new Set(a);
  const setB = new Set(b);
  const removed = a.filter((l) => !setB.has(l));
  const added = b.filter((l) => !setA.has(l));
  const preview = [
    ...removed.slice(0, 6).map((l) => `- ${l}`),
    ...added.slice(0, 6).map((l) => `+ ${l}`),
  ].join('\n');
  return `${a.length} → ${b.length} lines · -${removed.length} +${added.length}\n${preview}`;
}

const MAX_READ = 60_000; // chars — keep tool output bounded

export function repoTools(): ToolDefinition[] {
  return [
    {
      name: 'repo_status',
      description:
        "Show the git status of the repository containing a path: current branch and which files have uncommitted changes. Read-only. Use this to inspect a repo before proposing edits.",
      category: 'system',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'A file or directory inside the repo.' } },
        required: ['path'],
      },
      async execute(params): Promise<ToolResult> {
        try {
          const target = await safeResolve(String(params.path ?? ''));
          const root = await findGitRoot(target);
          if (!root) return { ok: false, error: 'That path is not inside a git repository.' };
          const branch = (await execFileP('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
          const status = (await execFileP('git', ['-C', root, 'status', '--short'])).stdout.trim();
          return { ok: true, data: { root, branch, dirty: status.length > 0, status: status || '(clean)' } };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'repo_read',
      description:
        'Read a file, or list a directory, inside your projects. Read-only. Use this to inspect code before editing. Large files are truncated.',
      category: 'system',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File to read or directory to list.' } },
        required: ['path'],
      },
      async execute(params): Promise<ToolResult> {
        try {
          const target = await safeResolve(String(params.path ?? ''));
          const st = await fs.stat(target);
          if (st.isDirectory()) {
            const entries = await fs.readdir(target, { withFileTypes: true });
            const listing = entries
              .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
              .slice(0, 200)
              .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
            return { ok: true, data: { directory: target, entries: listing } };
          }
          const raw = await fs.readFile(target, 'utf8');
          const truncated = raw.length > MAX_READ;
          return { ok: true, data: { file: target, content: raw.slice(0, MAX_READ), truncated, bytes: raw.length } };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'repo_edit',
      description:
        "Edit a file inside a git repository. Provide either `content` (the full new file) OR `find` + `replace` (a single exact substring swap). The change is shown to the user for approval before anything is written, the file is backed up first, and the repo must be a git repo so the change is tracked. Never use this for files outside a project.",
      category: 'system',
      safetyLevel: 'confirm',
      confirmPrompt: (params) =>
        `Edit ${params.path}${params.find ? ` (replace one occurrence of "${String(params.find).slice(0, 40)}…")` : ' (write new contents)'}`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to edit (must be inside a git repo).' },
          content: { type: 'string', description: 'Full new file contents. Use this OR find/replace.' },
          find: { type: 'string', description: 'Exact substring to replace (must occur exactly once).' },
          replace: { type: 'string', description: 'Replacement for `find`.' },
        },
        required: ['path'],
      },
      async execute(params): Promise<ToolResult> {
        try {
          const target = await safeResolve(String(params.path ?? ''));
          const root = await findGitRoot(target);
          if (!root) {
            return { ok: false, error: 'Build Mode only edits files inside a git repository, so changes stay tracked and reversible.' };
          }

          const before = await fs.readFile(target, 'utf8').catch(() => '');
          let after: string;
          if (typeof params.content === 'string') {
            after = params.content;
          } else if (typeof params.find === 'string' && typeof params.replace === 'string') {
            const occurrences = before.split(params.find).length - 1;
            if (occurrences === 0) return { ok: false, error: '`find` text was not found in the file.' };
            if (occurrences > 1) return { ok: false, error: `\`find\` matched ${occurrences} times — make it unique.` };
            after = before.replace(params.find, params.replace);
          } else {
            return { ok: false, error: 'Provide either `content`, or both `find` and `replace`.' };
          }

          if (after === before) return { ok: true, data: { path: target, unchanged: true } };

          // Back the file up before writing — reversible even outside git.
          const backup = `${target}.henry-bak-${Date.now()}`;
          if (before) await fs.writeFile(backup, before, 'utf8');
          await fs.writeFile(target, after, 'utf8');

          return { ok: true, data: { path: target, backup: before ? backup : null, diff: diffSummary(before, after) } };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}
