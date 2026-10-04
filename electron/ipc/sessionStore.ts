/**
 * SessionStore — Henry's persistent conversation history bridge.
 *
 * Drives `electron/python/session_store.py` as a short-lived subprocess: each
 * IPC call spawns Python, hands it a JSON payload on stdin, and reads a JSON
 * result from stdout. SQLite WAL mode handles concurrent access across calls,
 * so there's no long-lived process to manage (unlike the printer's serial
 * connection).
 *
 * Capabilities exposed to the renderer:
 *   - store & resume past conversations (sessions)
 *   - full-text search across all message history (FTS5)
 *   - per-session token / cost accounting
 *
 * Modeled on `electron/ipc/printer.ts` for Python discovery + spawning.
 */

import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// ── Python detection ──────────────────────────────────────────────────────────
// Electron apps on Mac get a restricted PATH (/usr/bin:/bin) that typically
// misses Homebrew python3. We probe the most common locations explicitly —
// same list the printer bridge uses.
const MAC_PYTHON_CANDIDATES = [
  '/opt/homebrew/bin/python3',   // Apple Silicon + Homebrew
  '/usr/local/bin/python3',      // Intel Mac + Homebrew
  '/usr/bin/python3',            // System Python (macOS 12.3+)
  '/usr/bin/python',             // Older system Python
  'python3',                     // PATH fallback
  'python',
];

let resolvedPython: string | null = null;
let scriptPath: string | null = null;
let dbPath: string | null = null;

function runPythonWith(
  pythonCmd: string,
  args: string[],
  stdin: string | null,
  timeout = 15000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(pythonCmd, args, { timeout });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    child.on('error', (e: Error) => resolve({ stdout: '', stderr: e.message, exitCode: -1 }));
    if (stdin != null) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

async function findPython(): Promise<string> {
  if (resolvedPython) return resolvedPython;
  if (process.platform === 'win32') { resolvedPython = 'python'; return resolvedPython; }
  for (const cmd of MAC_PYTHON_CANDIDATES) {
    const result = await runPythonWith(cmd, ['-c', 'print("ok")'], null, 3000);
    if (result.exitCode === 0 && result.stdout.trim() === 'ok') {
      resolvedPython = cmd;
      return resolvedPython;
    }
  }
  resolvedPython = 'python3'; // last resort
  return resolvedPython;
}

// ── Script resolution ───────────────────────────────────────────────────────
// In dev, session_store.py sits next to the compiled bridge; when packaged it
// may live inside an asar archive (which `spawn` cannot execute). We read the
// bundled file (fs CAN read from asar) and copy it to a writable runtime
// location once, then spawn from there — mirroring printer.ts writing its
// script to a temp file.
function locateBundledScript(): string | null {
  // __dirname is <root>/dist-electron in dev and <app.asar>/dist-electron when
  // packaged; the script ships under electron/python/** (see package.json
  // build.files), so the sibling `../electron/python` path resolves in both.
  const candidates = [
    path.join(__dirname, '..', 'electron', 'python', 'session_store.py'),
    path.join(__dirname, '..', 'python', 'session_store.py'),
    path.join(process.resourcesPath || '', 'app.asar', 'electron', 'python', 'session_store.py'),
    path.join(process.resourcesPath || '', 'python', 'session_store.py'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* keep probing */ }
  }
  return null;
}

function ensureScript(henryDir: string): string {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  const bundled = locateBundledScript();
  const dest = path.join(henryDir, 'session_store.py');
  if (bundled) {
    try {
      const src = fs.readFileSync(bundled, 'utf8');
      // Only rewrite when content differs, so we don't thrash the file on
      // every launch (cheap idempotent copy).
      let needsWrite = true;
      try { needsWrite = fs.readFileSync(dest, 'utf8') !== src; } catch { needsWrite = true; }
      if (needsWrite) fs.writeFileSync(dest, src);
      scriptPath = dest;
      return scriptPath;
    } catch (e) {
      // Fall back to spawning the bundled path directly (works in dev).
      scriptPath = bundled;
      return scriptPath;
    }
  }
  // Last resort: assume the dev path even if existsSync missed it.
  scriptPath = dest;
  return scriptPath;
}

/**
 * Invoke a SessionStore command. Returns the parsed `result` on success or
 * throws an Error carrying the Python-side message.
 */
async function callStore(command: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!scriptPath || !dbPath) {
    throw new Error('SessionStore bridge not initialized');
  }
  const python = await findPython();
  const args = [scriptPath, command, '--db', dbPath];
  const { stdout, stderr, exitCode } = await runPythonWith(
    python, args, JSON.stringify(payload ?? {}),
  );
  // The script always prints a single JSON line on stdout (even on error).
  const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
  let parsed: { ok?: boolean; result?: unknown; error?: string } | null = null;
  try { parsed = JSON.parse(line); } catch { /* fall through */ }
  if (!parsed) {
    throw new Error(
      `SessionStore returned no parseable output (exit ${exitCode}): ${stderr || stdout || 'no output'}`,
    );
  }
  if (!parsed.ok) {
    throw new Error(parsed.error || 'SessionStore command failed');
  }
  return parsed.result;
}

// Content-block convention lives in its own Electron-free module so it can be
// unit-tested without the Electron runtime. Re-exported here so existing callers
// (toolRunner, scheduler) keep importing block builders from sessionStore.
export { block, toolCallBlocks } from './_contentBlocks';
export type { ContentBlock, MessageKind, SessionOrigin } from './_contentBlocks';
import type { ContentBlock, MessageKind, SessionOrigin } from './_contentBlocks';

/**
 * Programmatic session creation for the agent layer. The scheduler opens a
 * fresh session per Routine run so its output (and tool-call audit trail) lands
 * in conversation history with a recognizable title. Returns the new session id
 * (or null if the bridge isn't initialized yet, in which case callers fall back
 * to a generated id — `add-message` auto-creates the row anyway).
 */
export async function createSessionRecord(payload: {
  id?: string;
  title?: string;
  origin?: SessionOrigin;
  model?: string;
  system_prompt?: string;
}): Promise<string | null> {
  if (!scriptPath || !dbPath) return null; // bridge not yet initialized
  const result = (await callStore('create', payload as Record<string, unknown>)) as
    | { id?: string }
    | undefined;
  return result?.id ?? null;
}

/**
 * Programmatic log helper for the agent layer. Appends a message (typically a
 * `tool` role row) to a session without going through the renderer IPC round
 * trip. `content` may be a plain string or a ContentBlock[] (see the block
 * builders above). Safe to call before the bridge is initialized — it no-ops
 * in that case rather than throwing, so tool execution is never blocked by
 * logging.
 */
export async function recordSessionMessage(payload: {
  session_id: string;
  role: string;
  content?: string | ContentBlock[];
  kind?: MessageKind;
  tool_name?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  token_count?: number;
}): Promise<void> {
  if (!scriptPath || !dbPath) return; // bridge not yet initialized
  await callStore('add-message', payload as Record<string, unknown>);
}

// Wrap a handler so renderer callers get a uniform { ok, result } | { ok, error }.
function handler(command: string) {
  return async (_event: unknown, payload: Record<string, unknown>) => {
    try {
      return { ok: true, result: await callStore(command, payload || {}) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

/**
 * Register all session:* IPC handlers.
 * @param henryDir  Writable workspace dir; the SQLite DB + a runtime copy of
 *                  the Python script live here.
 */
export function registerSessionStoreHandlers(henryDir: string) {
  dbPath = path.join(henryDir, 'sessions.db');
  ensureScript(henryDir);

  // Dependency probe — confirms Python + FTS5 are usable.
  ipcMain.handle('session:checkDeps', async () => {
    try {
      const result = await callStore('stats', {}) as Record<string, unknown>;
      return { available: true, ftsEnabled: !!result.fts_enabled, journalMode: result.journal_mode };
    } catch (e) {
      return {
        available: false,
        error: e instanceof Error ? e.message : String(e),
        installHint: process.platform === 'win32'
          ? 'Python 3.9+ with sqlite FTS5 is required.'
          : 'Install Python 3.9+ (brew install python) — sqlite FTS5 is included.',
      };
    }
  });

  // Core lifecycle + history operations.
  ipcMain.handle('session:create', handler('create'));
  ipcMain.handle('session:end', handler('end'));
  ipcMain.handle('session:resume', handler('resume'));
  ipcMain.handle('session:branch', handler('branch'));
  ipcMain.handle('session:list', handler('list'));
  ipcMain.handle('session:search', handler('search'));
  ipcMain.handle('session:addMessage', handler('add-message'));
  ipcMain.handle('session:getMessages', handler('get-messages'));

  // Agent audit log (Sprint 4) — every tool-call message across sessions,
  // newest first, for the "Audit Log" panel. `clear-tool-calls` backs the
  // panel's "Clear history" button.
  ipcMain.handle('session:list-tool-calls', handler('list-tool-calls'));
  ipcMain.handle('session:clear-tool-calls', handler('clear-tool-calls'));

  // Supporting operations.
  ipcMain.handle('session:get', handler('get'));
  ipcMain.handle('session:setTitle', handler('set-title'));
  ipcMain.handle('session:archive', handler('archive'));
  ipcMain.handle('session:updateTokens', handler('update-tokens'));
  ipcMain.handle('session:delete', handler('delete'));
  ipcMain.handle('session:export', handler('export'));
  ipcMain.handle('session:stats', handler('stats'));
}
