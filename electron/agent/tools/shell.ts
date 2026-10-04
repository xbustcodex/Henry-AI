/**
 * run_shell — Henry's general hands on the command line (design §1.7).
 *
 * Lets Henry carry out terminal tasks the user asks for in plain language:
 * cloning repos, making folders, moving files, installing dependencies, running
 * build scripts, etc. This is deliberately broad, so it is gated hard:
 *
 *   - safety tier `confirm`: every command routes through the Approval Queue and
 *     runs only after the user approves the exact command shown. Henry never
 *     runs a command on its own.
 *   - the working directory is sandboxed to the user's home and may not be a
 *     secrets dir (.ssh, .aws, …) — the same rail `repo.ts` enforces.
 *
 * The command string itself is whatever the user approved, so it runs through a
 * shell (pipes / `&&` / globs work as a user would expect). The approval gate —
 * not argument parsing — is the security boundary.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition, ToolResult } from '../types';

const execP = promisify(exec);

const BLOCKED_DIR_SEGMENTS = ['.ssh', '.keys', '.aws', '.gnupg', '.password-store', 'keychains'];
const MAX_OUTPUT = 60_000; // chars — keep tool output bounded for the model
const TIMEOUT_MS = 300_000; // 5 min — clones/installs can be slow

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}
function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

/** Resolve the working directory, defaulting to home, and enforce the sandbox. */
async function resolveCwd(p: string | undefined): Promise<string> {
  const raw = (p && p.trim()) || homedir();
  const expanded = raw.startsWith('~') ? path.join(homedir(), raw.slice(1)) : raw;
  const abs = path.resolve(expanded);
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    throw new Error(`Working directory does not exist: ${abs}`);
  }
  if (!(await fs.stat(real)).isDirectory()) {
    throw new Error(`Working directory is not a folder: ${abs}`);
  }
  const home = await fs.realpath(homedir());
  if (!(`${real}${path.sep}`).startsWith(`${home}${path.sep}`) && real !== home) {
    throw new Error('Refusing to run in a directory outside your home folder.');
  }
  const segs = real.split(path.sep).map((s) => s.toLowerCase());
  for (const blocked of BLOCKED_DIR_SEGMENTS) {
    if (segs.includes(blocked)) throw new Error(`Refusing to run inside a protected directory (${blocked}).`);
  }
  return real;
}

function clip(s: string): string {
  if (!s) return '';
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…(truncated)` : s;
}

export function shellTools(): ToolDefinition[] {
  return [
    {
      name: 'run_shell',
      description:
        'Run a terminal command on the user\'s Mac to carry out a system task they ' +
        'asked for: clone a git repo, create or move folders/files, install ' +
        'dependencies, run a build or script, inspect the system, etc. Provide the ' +
        'full command exactly as it would be typed in Terminal, and optionally a ' +
        'working directory (defaults to the home folder). Prefer this for anything ' +
        'that creates, moves, downloads, or installs on the machine. Returns the ' +
        'command\'s stdout, stderr, and exit code. The user approves each command ' +
        'before it runs.',
      category: 'automation',
      safetyLevel: 'confirm',
      confirmPrompt: (p) => {
        const cmd = String(p.command ?? '').slice(0, 300);
        const cwd = p.cwd ? ` (in ${String(p.cwd)})` : '';
        return `Run this command on your Mac${cwd}:\n${cmd}`;
      },
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'The full shell command to run, exactly as typed in Terminal. ' +
              'E.g. "git clone https://github.com/owner/repo.git" or "mkdir -p ~/Desktop/Demo".',
          },
          cwd: {
            type: 'string',
            description:
              'Optional working directory to run the command in (must be inside the ' +
              'home folder). Defaults to the home folder. E.g. "~/Desktop/3DAnimationLibs".',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      async execute(params): Promise<ToolResult> {
        const command = String(params.command ?? '').trim();
        if (!command) return fail('A command is required.');

        let cwd: string;
        try {
          cwd = await resolveCwd(params.cwd as string | undefined);
        } catch (e) {
          return fail(e instanceof Error ? e.message : 'Invalid working directory.');
        }

        try {
          const { stdout, stderr } = await execP(command, {
            cwd,
            timeout: TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            env: process.env,
            killSignal: 'SIGKILL',
          });
          return ok({ command, cwd, exitCode: 0, stdout: clip(stdout), stderr: clip(stderr) });
        } catch (e: unknown) {
          const err = e as { code?: number; killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
          if (err.killed || err.signal === 'SIGKILL') {
            return fail(`Command timed out after ${Math.round(TIMEOUT_MS / 1000)}s and was stopped.`, true);
          }
          const detail = clip(err.stderr || err.stdout || err.message || 'command failed');
          // Non-zero exit: surface output so the model can react, but mark as failed.
          return {
            ok: false,
            error: `Command exited with code ${err.code ?? 'unknown'}.\n${detail}`,
            data: { command, cwd, exitCode: err.code ?? null, stdout: clip(err.stdout || ''), stderr: clip(err.stderr || '') },
            retryable: false,
          };
        }
      },
    },
  ];
}
