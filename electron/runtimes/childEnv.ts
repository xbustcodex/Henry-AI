/**
 * Child-process environment for external agent CLIs.
 *
 * A packaged Electron app inherits a very small PATH, and agent runtimes are
 * commonly installed by a version manager (nvm/fnm/volta/bun) into a per-user
 * directory that PATH does not include — and several of them need a `node` on
 * PATH to run at all. Detection therefore has to run against a PATH that
 * includes the real install locations, or a perfectly working install reports
 * itself absent.
 *
 * This module is runtime-neutral on purpose: it only assembles PATH and
 * neutralises parent-session markers. Anything specific to one CLI — which
 * executable names to look for, which credential variable to inject — belongs
 * in that CLI's adapter.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Environment for detecting and running an external agent CLI.
 *
 * Adapters pass `extraEnv` to inject their own credential; this function never
 * knows the name of any runtime's credential variable.
 */
export function buildRuntimeChildEnv(extraEnv?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const home = os.homedir();
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Never let a parent agent session make a headless run think it is
  // interactive: a CLI launched from inside another coding agent inherits that
  // agent's markers and refuses to run non-interactively.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }

  env.HOME = env.HOME || home;

  // A credential Henry saved wins over one inherited from the OS environment.
  // Anything the caller does not supply is left exactly as inherited.
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (value) env[key] = value;
  }

  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.deno', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];

  // nvm: ~/.nvm/versions/node/<version>/bin
  try {
    const nvmRoot = process.env.NVM_DIR || path.join(home, '.nvm');
    const versions = path.join(nvmRoot, 'versions', 'node');
    if (fs.existsSync(versions)) {
      for (const v of fs.readdirSync(versions).sort().reverse()) {
        dirs.push(path.join(versions, v, 'bin'));
      }
    }
  } catch {
    /* enumeration is best effort */
  }

  // fnm: ~/.local/share/fnm/node-versions/<version>/installation/bin
  try {
    const fnmRoot = path.join(home, '.local', 'share', 'fnm', 'node-versions');
    if (fs.existsSync(fnmRoot)) {
      for (const v of fs.readdirSync(fnmRoot).sort().reverse()) {
        dirs.push(path.join(fnmRoot, v, 'installation', 'bin'));
      }
    }
  } catch {
    /* best effort */
  }

  // path.delimiter, not ':' — a hardcoded colon silently produced one malformed
  // PATH entry on Windows.
  env.PATH = [...new Set(dirs), env.PATH || ''].filter(Boolean).join(path.delimiter);
  return env;
}