/**
 * omp — adapter for the OpenCode product.
 *
 * The OpenCode CLI installs under different binary names on different
 * platforms. On Windows the vendor's own bundle puts `omp.exe` in
 * `%LOCALAPPDATA%\omp`; elsewhere it is `opencode`. Probing only the literal
 * name `opencode` made a working install (395 Zen models reachable) report
 * itself absent from the packaged app, because a packaged Electron process does
 * not have that folder on its PATH. Both names are probed here, and the list of
 * names is adapter-private: nothing outside this file learns that "omp" and
 * "opencode" are the same product.
 *
 * ── The CLI's real flag contract ────────────────────────────────────────────
 *
 * `omp run` does NOT accept `--format` or `--dir`. It rejects them and exits 2
 * with `unknown flags: --format, --dir`, which failed every OpenCode/Zen turn
 * before a token was ever requested. The spellings it does accept are:
 *
 *   --mode json   machine-readable output
 *   --cwd <dir>   working directory
 *   -p            non-interactive (`--print`)
 *   --model <id>  model selection
 *
 * `run` is an alias of `launch`. Both flag spellings are asserted in
 * ompCliFlags.test.ts, which reads this module's own argument builder rather
 * than a copy of it, so the two cannot drift.
 *
 * Authentication: the CLI authenticates its own hosted ("Zen") gateway with
 * OPENCODE_API_KEY in its child environment. That variable name, and the Zen
 * credential rehydration, are adapter-private — no other module mentions them.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  type CoderStreamEvent,
  createLineBuffer,
  summarizeToolInput,
} from '../../coder/streamJson';
import { buildRuntimeChildEnv } from '../childEnv';
import { decryptKey } from '../../ipc/_keyStorage';
import { OPENCODE_ZEN_PROVIDER_ID, opencodeProviderIdForModel } from '../../providers/classification';
import { log } from '../../lib/log';
import type {
  AgentRuntimeAdapter,
  RuntimeModel,
  RuntimeProbe,
  RuntimeRunOutcome,
  RuntimeRunRequest,
} from '../types';

const execFileP = promisify(execFile);

/** Stable id for this runtime. Distinct from the `opencode` PROVIDER id. */
export const OMP_RUNTIME_ID = 'omp';

/**
 * Binary names this one product installs under. Adapter-private on purpose.
 */
const CLI_NAMES = ['opencode', 'omp'] as const;

/** Credential variable the CLI reads for its hosted Zen gateway. */
const ZEN_ENV_VAR = 'OPENCODE_API_KEY';

/** Session/client markers to drop so a headless run is not seen as nested. */
const SESSION_ENV_KEYS = ['OPENCODE_SESSION', 'OPENCODE_CLIENT', 'OPENCODE_SERVER'] as const;

/**
 * Child environment for this runtime: the shared runtime-neutral PATH
 * assembly, plus the Zen credential and the session-marker cleanup that are
 * specific to this CLI.
 *
 * The key detail is what is NOT stripped. A blanket `OPENCODE_*` delete also
 * removed OPENCODE_API_KEY — the documented bearer credential for the Zen
 * gateway — which silently reduced the model catalogue from 395 entries to the
 * unauthenticated subset. Only session/state markers are removed, and a key
 * that looks like a credential is never removed even from that list.
 */
export function buildOmpChildEnv(): NodeJS.ProcessEnv {
  const env = buildRuntimeChildEnv();
  for (const key of SESSION_ENV_KEYS) {
    if (key in env && !/KEY|TOKEN|AUTH|SECRET|PASSWORD/.test(key)) delete env[key];
  }
  // A key saved in Henry wins over one inherited from the OS environment.
  if (zenCredential) env[ZEN_ENV_VAR] = zenCredential;
  return env;
}

/** Every place the CLI realistically lives, under any of its binary names. */
export function candidateBinaries(): string[] {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const out: string[] = [];
  for (const name of CLI_NAMES) {
    // bare name first: resolved against the extended PATH, so an install in any
    // PATH folder is found without this code knowing where that is.
    out.push(name);
    out.push(path.join(home, '.opencode', 'bin', name));
    out.push(path.join(home, '.omp', 'bin', name));
    out.push(path.join(home, '.local', 'bin', name));
    out.push(path.join(home, '.bun', 'bin', name));
    out.push(path.join(home, '.volta', 'bin', name));
    if (isWin) {
      out.push(path.join(appData, 'npm', `${name}.cmd`));
      // The vendor's own Windows bundle lives here.
      out.push(path.join(localAppData, name, `${name}.exe`));
    } else {
      out.push('/opt/homebrew/bin/' + name);
      out.push('/usr/local/bin/' + name);
      out.push('/usr/bin/' + name);
    }
  }
  return out;
}

// ── Zen credential ─────────────────────────────────────────────────────────
//
// Zen authenticates with OPENCODE_API_KEY. Until this existed the only way to
// supply it was having it in the OS environment, so a key typed into Henry's
// provider panel was stored and then silently ignored. Nothing outside this
// adapter needs to know that: the value is injected into the child env here and
// never crosses the IPC boundary.

let zenCredential = '';

export function setOpencodeZenCredential(key: string | null | undefined): void {
  zenCredential = (key ?? '').trim();
}

export function getOpencodeZenCredential(): string {
  return zenCredential;
}

/**
 * Restore the Zen credential from the providers table at launch.
 *
 * `providers:save` is the only other writer, and it runs once, when the user
 * presses Save. Without this, the credential starts empty on every launch and a
 * saved key is ignored until the user re-saves it — which presents as "Zen
 * worked yesterday". Reads only the Zen row; it cannot resurrect a deleted key.
 */
export function rehydrateOpencodeZenCredential(
  db: { prepare: (sql: string) => { get: (id: string) => { api_key?: string } | undefined } },
): void {
  try {
    const row = db
      .prepare('SELECT api_key FROM providers WHERE id = ?')
      .get(OPENCODE_ZEN_PROVIDER_ID);
    setOpencodeZenCredential(row ? decryptKey(row.api_key ?? '') : '');
  } catch (e: unknown) {
    // A missing table or an uninitialised database must not stop boot; the
    // worst case is the unauthenticated subset, which is what shipped before.
    log.warn('[omp] could not rehydrate the Zen credential', e);
  }
}

// ── Probing ────────────────────────────────────────────────────────────────

interface OmpCliInfo {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
}

const NOT_INSTALLED_REASON =
  `OpenCode CLI not found. Tried: ${CLI_NAMES.join(', ')}. Install it (https://opencode.ai), ` +
  'or make sure its folder is on PATH for the Henry window — a shell alias or version-manager ' +
  'shim that only exists inside your terminal will not be visible here.';

/**
 * Resolve the installed binary by asking each candidate for its version.
 *
 * No cache. Software is installed and uninstalled between two discovery calls,
 * and a cached "available: true" is exactly the lie this layer exists to avoid.
 * Callers that want a cached answer keep their own cache and say so.
 */
async function resolveCli(): Promise<OmpCliInfo> {
  const env = buildOmpChildEnv();
  for (const bin of candidateBinaries()) {
    try {
      const { stdout } = await execFileP(bin, ['--version'], { env, timeout: 8_000 });
      return { available: true, path: bin, version: stdout.trim().split('\n')[0] || undefined };
    } catch {
      /* try the next candidate */
    }
  }
  return { available: false, error: NOT_INSTALLED_REASON };
}

/**
 * Adapter probe.
 *
 * Both capabilities are marked verified from the binary's own `--version`
 * answer, because the same code paths that answered `--version` are the ones
 * that spawn the CLI: there is no separate "is this runtime usable" heuristic
 * that could disagree with the run itself. `listModels` is additionally
 * exercised for real by `listModels()` below, and discovery can opt into that
 * so the reported model count is observed rather than promised.
 */
export async function probeOmp(): Promise<RuntimeProbe> {
  const cli = await resolveCli();
  if (!cli.available || !cli.path) {
    return {
      id: OMP_RUNTIME_ID,
      displayName: 'OpenCode (omp)',
      available: false,
      unavailableReason: cli.error ?? NOT_INSTALLED_REASON,
      capabilities: {
        run: { verified: false, note: cli.error ?? NOT_INSTALLED_REASON },
        listModels: { verified: false, note: cli.error ?? NOT_INSTALLED_REASON },
      },
    };
  }
  return {
    id: OMP_RUNTIME_ID,
    displayName: 'OpenCode (omp)',
    available: true,
    binaryPath: cli.path,
    version: cli.version,
    capabilities: {
      run: { verified: true },
      listModels: { verified: true },
    },
  };
}

// ── Event parsing ──────────────────────────────────────────────────────────

interface OmpEvent {
  type?: string;
  sessionID?: string;
  cost?: number;
  /** The CLI reports run failures as a TOP-LEVEL error, not a part. */
  error?: { name?: string; message?: string; data?: { message?: string; [k: string]: unknown } };
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    state?: { input?: unknown; status?: string; title?: string };
    tokens?: { input?: number; output?: number };
  };
}

/** Translate one of this CLI's JSON events into the shared coder vocabulary. */
export function parseOmpEventLine(line: string): CoderStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];

  let ev: OmpEvent;
  try {
    ev = JSON.parse(trimmed) as OmpEvent;
  } catch {
    return [];
  }

  // A top-level error means the run itself failed. It arrives with no part, so
  // the switch below would never see it and the run would look like an empty
  // success.
  if (ev.error) {
    return [{ kind: 'error', message: readOmpError(ev.error) }];
  }

  const part = ev.part ?? {};
  switch (part.type) {
    case 'text': {
      const text = part.text;
      return text ? [{ kind: 'text', text }] : [];
    }
    case 'tool': {
      const summary = part.state?.title || summarizeToolInput(part.state?.input);
      return [{ kind: 'tool', name: part.tool || 'tool', summary }];
    }
    case 'step-start':
    case 'step_start': {
      const out: CoderStreamEvent[] = [];
      if (ev.sessionID) out.push({ kind: 'init', sessionId: ev.sessionID });
      return out;
    }
    case 'step-finish':
    case 'step_finish': {
      return [
        {
          kind: 'result',
          ok: (part as { reason?: string }).reason !== 'error',
          sessionId: ev.sessionID,
          costUsd: typeof ev.cost === 'number' ? ev.cost : undefined,
        },
      ];
    }
    case 'error':
      return [{ kind: 'error', message: readOmpError(part as unknown as Record<string, unknown>) }];
    default:
      return [];
  }
}

/**
 * Pull a usable message out of this CLI's several error shapes.
 *
 * Observed from a real failed run:
 *   {"type":"error","error":{"name":"UnknownError","data":{"message":"{\"message\":\"Streaming
 *    response failed: [503] Upstream error from Nvidia: Service temporarily overloaded\"}"}}}
 * — so the human-readable text can be nested two levels down AND itself be a
 * JSON string. Without unwrapping, a failed run looked like an empty success.
 */
export function readOmpError(raw: unknown): string {
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    for (const key of ['message', 'data', 'error']) {
      const got = pick(o[key]);
      if (got) return got;
    }
    return null;
  };
  const text = pick(raw);
  if (!text) return 'OpenCode reported an error';
  // The nested payload is often a JSON string; unwrap it to the inner message.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const inner = JSON.parse(trimmed) as unknown;
      const better = pick(inner);
      if (better && better !== trimmed) return better;
    } catch { /* not JSON after all — use the raw text */ }
  }
  return text;
}

// ── Model catalogue ────────────────────────────────────────────────────────

export interface OmpModel {
  /** `provider/model`, exactly as passed to --model. */
  id: string;
  provider: string;
  name: string;
  /** True for this CLI's own hosted ("zen") models. */
  isZen: boolean;
  /** Provider group the id was listed under, e.g. "opencode-zen". */
  group: string;
}

/**
 * Parse the model-list output into real model identifiers.
 *
 * The CLI prints a grouped table, for example:
 *
 *   opencode-zen (105)
 *   | ~anthropic/claude-fable-latest        |    1M |  128K | low,high | yes |
 *   |  anthropic/claude-fable-5            |    1M |  128K | low,high | yes |
 *
 * This used to keep every line containing "/" as the model id, so all 559 ids
 * came back as the entire table row — box-drawing borders, context windows and
 * reasoning-effort lists included — and none of them could be sent to the
 * bridge. A "~" marks the group's highlighted entry and is not part of the id.
 *
 * Older builds printed one bare id per line, so plain lines are still accepted.
 */
export function parseModelList(stdout: string): OmpModel[] {
  const out: OmpModel[] = [];
  const seen = new Set<string>();
  let group = '';
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // Group header: a provider name followed by a model count, e.g. "opencode-zen (105)"
    const header = /^([A-Za-z0-9_.-]+)\s*\((\d+)\)\s*$/.exec(line);
    if (header) {
      group = header[1];
      continue;
    }
    // Box drawing: table rules and borders carry no model.
    if (/^[┌├└─═\s|\u2502]+$/.test(line)) continue;

    // Table row: the model is the first column. Borders are box-drawing U+2502
    // as well as ASCII '|', so both have to be accepted.
    const cells = line.split(/[|\u2502]/).map((c) => c.trim()).filter(Boolean);
    const first = cells[0];
    if (!first) continue;
    // The column heading row, e.g. "| model | context | ...".
    if (/^models?$/i.test(first)) continue;

    const id = first.replace(/^~/, '').trim();
    if (!id || /[│|]/.test(id)) continue;
    const key = `${group}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(classifyModel(id, group || undefined));
  }
  return out;
}

function classifyModel(id: string, group?: string): OmpModel {
  const slash = id.indexOf('/');
  const idProvider = slash > 0 ? id.slice(0, slash) : '';
  const name = slash > 0 ? id.slice(slash + 1) : id;
  // "opencode-zen (105)" is the group heading for the Zen catalogue; ids inside
  // it are namespaced by their upstream provider, so the provider has to come
  // from the group or every Zen model looks like a third-party one.
  const bucket = (group || idProvider).toLowerCase();
  const isZen = bucket.includes('zen');
  // Zen ids carry no `provider/` prefix, so the slash split above yields
  // nothing for them. Falling through to the literal 'unknown' is what made all
  // 108 Zen models ungroupable downstream: every consumer keyed off `provider`,
  // found 'unknown', and dropped them. For a Zen model the group IS the
  // provider, so say so rather than admitting defeat.
  const provider = idProvider || group || 'unknown';
  return {
    id,
    provider,
    name,
    group: group || idProvider || 'unknown',
    isZen,
  };
}

/**
 * Map an adapter model onto the shared `RuntimeModel`, carrying the Henry
 * PROVIDER id through unchanged.
 *

 * This is the seam that keeps runtime identity and provider identity apart: a
 * model listed under the Zen group comes back with `providerId === 'opencode-zen'`,
 * so its own credential and its own catalogue entry survive the trip through a
 * runtime. It never becomes merely `opencode`.
 */
export function toRuntimeModel(model: OmpModel): RuntimeModel {
  return {
    id: model.id,
    name: model.name,
    providerId: opencodeProviderIdForModel(model),
    provider: model.provider,
    group: model.group,
  };
}
/**
 * Ask the CLI which models it can reach, so Henry offers the real list instead
 * of a hardcoded one. This is what lets every provider it is configured for —
 * its own zen models, OpenRouter, or anything added later — work through the
 * same runtime without a code change here.
 *
 * The timeout is generous on purpose: the model listing probes the configured
 * providers and took ~25s here, and a 20s cap silently truncated the list to
 * 139 of 395 entries.
 */
export async function listOmpModels(timeoutMs = 90_000): Promise<OmpModel[]> {
  const cli = await resolveCli();
  if (!cli.available || !cli.path) {
    throw new Error(cli.error ?? 'OpenCode is not installed.');
  }
  const { stdout } = await execFileP(cli.path, ['models'], {
    env: buildOmpChildEnv(),
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseModelList(stdout).sort((a, b) => {
    // zen first, then alphabetical
    if (a.isZen !== b.isZen) return a.isZen ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

// ── Running a turn ─────────────────────────────────────────────────────────

/**
 * Build this CLI's argument vector for one non-interactive turn.
 *
 * `--format` and `--dir` are NOT flags of this CLI: it rejects them and exits 2
 * with `unknown flags: --format, --dir`, which made every OpenCode/Zen turn fail
 * at launch before a token was ever requested. The correct spellings are
 * `--mode json` for machine-readable output and `--cwd` for the working
 * directory. `-p` (`--print`) makes the run non-interactive so it processes the
 * prompt and exits rather than waiting on a TTY.
 *
 * Exported so the argument contract is asserted against the code that builds it
 * rather than against a copy that can drift.
 */
export function buildOmpRunArgs(req: RuntimeRunRequest): string[] {
  const args = ['run', '--mode', 'json', '--cwd', req.cwd, '-p'];
  if (req.model) args.push('--model', req.model);
  if (req.agent) args.push('--agent', req.agent);
  if (req.sessionId) args.push('--session', req.sessionId);
  args.push(req.prompt);
  return args;
}

/** Spawn a turn and hand back the live child, for callers that stream events. */
export function spawnOmpTurn(req: RuntimeRunRequest, cliPath: string): ChildProcess {
  return spawn(cliPath, buildOmpRunArgs(req), {
    cwd: req.cwd,
    env: buildOmpChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Adapter `run`: one non-interactive turn, resolved.
 *
 * Streams parsed events to `req.onEvent` as they arrive, and resolves with the
 * collected answer. A caller that only wants the answer awaits the promise; a
 * caller that wants live events also gets them, so there is one run path rather
 * than two that can disagree.
 */
export async function runOmp(req: RuntimeRunRequest & { cliPath: string }): Promise<RuntimeRunOutcome> {
  const child = spawnOmpTurn(req, req.cliPath);

  let stdout = '';
  let stderr = '';
  let text = '';
  let sessionId: string | undefined;
  let usage: RuntimeRunOutcome['usage'];
  let terminalError: string | undefined;
  let usageRaw = '';

  const abort = (): void => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };
  req.signal?.addEventListener('abort', abort, { once: true });

  const emit = (event: CoderStreamEvent): void => {
    if (event.kind === 'text') text += event.text;
    else if (event.kind === 'init') sessionId = event.sessionId;
    else if (event.kind === 'error') terminalError = event.message;
    req.onEvent?.(event);
  };

  // Chunk boundaries do not align with event boundaries, so a partial line
  // stays buffered until the rest of it arrives.
  const buffer = createLineBuffer((line) => {
    for (const event of parseOmpEventLine(line)) emit(event);
  });

  child.stdout?.on('data', (d: Buffer) => {
    const chunk = d.toString();
    stdout += chunk;
    usageRaw += chunk;
    buffer.push(chunk);
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
    buffer.push(d.toString());
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', (err: Error) => reject(new Error(`OpenCode failed to start: ${err.message}`)));
    child.on('close', (code: number | null) => resolve(code));
  }).finally(() => {
    req.signal?.removeEventListener('abort', abort);
  });
  buffer.flush?.();

  const usageParsed = parseStepFinishUsage(usageRaw);
  if (usageParsed) usage = usageParsed;

  if (terminalError) {
    return { ok: false, text, sessionId, exitCode, error: terminalError, usage };
  }
  if (exitCode !== 0 && !text) {
    return {
      ok: false,
      text,
      sessionId,
      exitCode,
      error: `OpenCode exited with code ${exitCode}: ${stderr.slice(-300)}`,
      usage,
    };
  }
  if (!text) {
    // Include the tail of both streams so the cause is visible in the UI
    // rather than an opaque "no text".
    return {
      ok: false,
      text,
      sessionId,
      exitCode,
      error:
        `OpenCode produced no text (exit ${exitCode}). ` +
        `stderr: ${stderr.slice(-200) || '(empty)'} | stdout tail: ${stdout.slice(-200) || '(empty)'}`,
      usage,
    };
  }
  return { ok: true, text, sessionId, exitCode, usage };
}

/**
 * Real token counts, when the CLI reported them on its step_finish part.
 *
 * Adapter-private: the event shape is this CLI's, so nothing outside knows where
 * the counts come from.
 */
function parseStepFinishUsage(stdout: string): RuntimeRunOutcome['usage'] {
  let last: { input: number; output: number } | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line) as OmpEvent;
      const tokens = ev.part?.tokens;
      if (tokens && typeof tokens.input === 'number' && typeof tokens.output === 'number') {
        last = { input: tokens.input, output: tokens.output };
      }
    } catch { /* not an event line */ }
  }
  if (!last) return undefined;
  return {
    promptTokens: last.input,
    completionTokens: last.output,
    totalTokens: last.input + last.output,
  };
}

// ── The adapter itself ─────────────────────────────────────────────────────

/**
 * The OpenCode product, as one adapter.
 *
 * `probe`, `listModels` and `run` here are the only places in Henry that know
 * this runtime's executable names, flags, credential variable or event shapes.
 */
export const ompAdapter: AgentRuntimeAdapter = {
  id: OMP_RUNTIME_ID,
  displayName: 'OpenCode (omp)',
  description: 'OpenCode CLI. Serves its own Zen catalogue plus any provider it is configured for.',
  candidateBinaries,
  probe: probeOmp,
  authHint: { envVar: ZEN_ENV_VAR, optional: true },
  async listModels(): Promise<RuntimeModel[]> {
    return (await listOmpModels()).map(toRuntimeModel);
  },
  async run(req: RuntimeRunRequest): Promise<RuntimeRunOutcome> {
    const cli = await resolveCli();
    if (!cli.available || !cli.path) {
      throw new Error(cli.error ?? 'OpenCode is not installed.');
    }
    return runOmp({ ...req, cliPath: cli.path });
  },
};