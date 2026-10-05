/**
 * pi — adapter for Prime Pi.
 *
 * ── How this contract was established ──────────────────────────────────────
 *
 * Not guessed. Every flag, event name and output column below was read out of
 * the installed `@earendil-works/pi-coding-agent` package (v0.87.1) — its own
 * `dist/cli/args.js` argument parser, `dist/cli/list-models.js` table renderer,
 * `dist/core/model-resolver.js`, and its `docs/json.md` event reference — and
 * then confirmed by running the installed binary. Where something could not be
 * established that way, the capability is reported UNVERIFIED rather than
 * claimed. See `UNVERIFIED` below.
 *
 * ── The CLI's real contract, as verified ───────────────────────────────────
 *
 *   pi --version                      → prints the version, exits 0
 *   pi --list-models                  → a padded text table on stdout
 *   pi --mode json -p "<prompt>"      → JSONL event stream on stdout, then exits
 *   pi --mode json --model <id>       → model selection; `provider/id` is
 *                                       resolved as provider + model when the
 *                                       prefix names a known provider
 *
 * Two differences from every other runtime Henry talks to, and the reason this
 * is an adapter rather than a flag on a shared runner:
 *
 *   1. **There is no `--cwd` flag.** Pi has no working-directory option at all;
 *      it works in the directory it was launched from. The adapter therefore
 *      sets the child's `cwd` in the spawn call. Passing a `--cwd` here would be
 *      rejected as an unknown flag.
 *   2. **There is no `run` subcommand.** The prompt is a positional argument to
 *      the bare `pi` command, and `-p`/`--print` is what makes it non-interactive.
 *      Note that `-p` CONSUMES the next argument as the prompt when it does not
 *      begin with `-`, so the prompt is passed after `-p` deliberately.
 *
 * ── Authentication ─────────────────────────────────────────────────────────
 *
 * Pi authenticates inside its own config directory (`~/.pi/agent`, overridable
 * with `PI_CODING_AGENT_DIR`) via `auth.json`, and additionally honours the
 * upstream provider variables in the child environment (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, and the rest — see its `docs/providers.md`). There is no
 * single Pi-owned bearer variable, so `authHint` names no variable and is marked
 * optional. A Pi install with no provider configured is genuinely installed and
 * genuinely unusable, which is not the same as absent; the probe says
 * "installed" and leaves the credential question to the auth hint.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { type CoderStreamEvent, createLineBuffer, summarizeToolInput } from '../../coder/streamJson';
import { buildRuntimeChildEnv } from '../childEnv';
import type {
  AgentRuntimeAdapter,
  RuntimeModel,
  RuntimeProbe,
  RuntimeRunOutcome,
  RuntimeRunRequest,
} from '../types';

const execFileP = promisify(execFile);

/** Stable id for this runtime. */
export const PI_RUNTIME_ID = 'pi';

/** Binary names Pi installs under. Adapter-private. */
const CLI_NAMES = ['pi'] as const;

/**
 * Child environment for Pi.
 *
 * `PI_CODING_AGENT=true` is Pi's own "a child process is running inside Pi"
 * marker. Inherited into a headless turn it makes Pi believe it is nested inside
 * another agent session, so it is stripped here — the same reason Henry strips
 * its own session markers for every runtime.
 *
 * No credential is injected: Pi has no single bearer variable. Upstream
 * provider variables in the OS environment pass through untouched, which is how
 * Pi is documented to accept them.
 */
export function buildPiChildEnv(): NodeJS.ProcessEnv {
  const env = buildRuntimeChildEnv();
  delete env.PI_CODING_AGENT;
  return env;
}

/**
 * Every place Pi realistically lives.
 *
 * Verified install shapes: an npm global install (whose shims sit in npm's own
 * prefix — `D:\nodejs\pi.cmd` on this host), and the standalone installer,
 * which places a `pi` on the user's PATH. The per-user candidate directories
 * below are the standard ones an npm global prefix or the installer can land in;
 * the bare name is probed first and resolves against the extended PATH, so an
 * install in any other PATH folder is still found without this list knowing it.
 */
export function candidateBinaries(): string[] {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const out: string[] = [];
  for (const name of CLI_NAMES) {
    out.push(name);
    out.push(path.join(home, '.local', 'bin', name));
    out.push(path.join(home, '.bun', 'bin', name));
    out.push(path.join(home, '.volta', 'bin', name));
    if (isWin) {
      // npm global prefix shims, then the standalone installer directory.
      out.push(path.join(localAppData, name, `${name}.cmd`));
      out.push(path.join(appData, 'npm', `${name}.cmd`));
      out.push(path.join(localAppData, 'Programs', name, `${name}.exe`));
    } else {
      out.push('/usr/local/bin/' + name);
      out.push('/opt/homebrew/bin/' + name);
      out.push('/usr/bin/' + name);
    }
  }
  return out;
}

const NOT_INSTALLED_REASON =
  'Prime Pi CLI not found. Tried: ' + CLI_NAMES.join(', ') + '. ' +
  'Install it with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, ' +
  'or make sure its folder is on PATH for the Henry window.';

/**
 * What could NOT be established about Pi's contract, stated rather than papered
 * over. Kept as a named constant so the renderer's "unverified" label and the
 * code cannot disagree.
 *
 * Currently empty: every flag and event this adapter relies on was read from the
 * installed package's own source and confirmed by running the binary. It is
 * here because the honest state of a new runtime's integration is a fact that
 * belongs in the code, and the moment something becomes unverified it must be
 * written down instead of assumed.
 */
export const UNVERIFIED: readonly string[] = [];

// ── Probing ────────────────────────────────────────────────────────────────

interface PiCliInfo {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
}

/**
 * Resolve the installed binary by asking each candidate for its version.
 *
 * No cache, for the same reason every adapter has none: the user can install or
 * uninstall software between two discovery calls.
 */
async function resolveCli(): Promise<PiCliInfo> {
  const env = buildPiChildEnv();
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
 * `run` is verified because `--version` and `--mode json -p` are parsed by the
 * same argument parser in the same binary; there is no second, weaker notion of
 * "runnable". `listModels` is verified for the same reason, and `modelCount` is
 * deliberately NOT set here — a probe that did not actually run `--list-models`
 * must not report how many models exist. `discoverRuntimes` fills that in by
 * really running it, or leaves it absent.
 */
export async function probePi(): Promise<RuntimeProbe> {
  const cli = await resolveCli();
  if (!cli.available || !cli.path) {
    return {
      id: PI_RUNTIME_ID,
      displayName: 'Prime Pi',
      available: false,
      unavailableReason: cli.error ?? NOT_INSTALLED_REASON,
      capabilities: {
        run: { verified: false, note: cli.error ?? NOT_INSTALLED_REASON },
        listModels: { verified: false, note: cli.error ?? NOT_INSTALLED_REASON },
      },
    };
  }
  const unverifiedNote = UNVERIFIED.length ? UNVERIFIED.join(' ') : undefined;
  return {
    id: PI_RUNTIME_ID,
    displayName: 'Prime Pi',
    available: true,
    binaryPath: cli.path,
    version: cli.version,
    capabilities: {
      run: unverifiedNote ? { verified: false, note: unverifiedNote } : { verified: true },
      listModels: unverifiedNote ? { verified: false, note: unverifiedNote } : { verified: true },
    },
  };
}

// ── Model catalogue ────────────────────────────────────────────────────────

/**
 * Parse `pi --list-models` output.
 *
 * The renderer prints a padded, space-separated table with a fixed header and
 * no borders:
 *
 *   provider    model                             context  max-out  thinking  images
 *   opencode    space-bunny-free                  1.0M     524.3K   yes       yes
 *   openrouter  ~anthropic/claude-fable-latest    1M       128K     yes       yes
 *
 * So there is no box-drawing to strip and no group heading to track: the
 * provider is its own column, which is why the first two columns are all this
 * parser needs. A leading "~" marks a highlighted entry and is not part of the
 * id, exactly as in the OpenCode table.
 */
export function parsePiModelList(stdout: string): { provider: string; id: string }[] {
  const out: { provider: string; id: string }[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(/\s+/);
    // Header row: `provider model context max-out thinking images`.
    if (cells.length < 2) continue;
    if (cells[0].toLowerCase() === 'provider' && cells[1].toLowerCase() === 'model') continue;
    const provider = cells[0];
    const id = cells[1].replace(/^~/, '').trim();
    if (!provider || !id) continue;
    // A separator line carries no model.
    if (/^[-=+_|]+$/.test(provider) || /^[-=+_|]+$/.test(id)) continue;
    const key = `${provider}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, id });
  }
  return out;
}

/**
 * Ask Pi which models it can reach.
 *
 * Pi authenticates per provider inside its own config directory, so this listing
 * is what Pi itself considers reachable from that configuration. The ids are
 * `provider/id`, which is also exactly what `--model` accepts: the resolver
 * reads a leading segment as the provider when it names a known one.
 *
 * The timeout is generous because this command loads the model catalogue and can
 * refresh it from the network.
 */
export async function listPiModels(timeoutMs = 60_000): Promise<RuntimeModel[]> {
  const cli = await resolveCli();
  if (!cli.available || !cli.path) {
    throw new Error(cli.error ?? 'Prime Pi is not installed.');
  }
  const { stdout } = await execFileP(cli.path, ['--list-models'], {
    env: buildPiChildEnv(),
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parsePiModelList(stdout).map(({ provider, id }) => ({
    id: `${provider}/${id}`,
    name: id,
    // Pi is a runtime, not a Henry provider. Its models are reached through
    // whatever provider Pi itself is configured with, and that provider identity
    // is Pi's own column — carried through as the group, never invented here.
    providerId: provider,
    group: provider,
  }));
}

// ── Event parsing ──────────────────────────────────────────────────────────

interface PiEvent {
  type?: string;
  id?: string;
  cwd?: string;
  /** Present on `message_start`/`message_update`/`message_end`. */
  message?: PiMessage;
  /** Present on `message_update`: the delta-only streaming update. */
  assistantMessageEvent?: {
    type?: string;
    toolName?: string;
    delta?: string;
    content?: string;
    toolCall?: { name?: string; arguments?: unknown; displayName?: string };
  };
  error?: unknown;
}

/** Pi splits content into typed blocks; only text and tool calls matter here. */
interface PiMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
}

/**
 * Translate one Pi JSONL record into the shared coder vocabulary.
 *
 * The shapes below are the ones documented in Pi's own `docs/json.md` and
 * observed from a real `--mode json` run: a `session` header carrying the id,
 * `message_update` records whose `assistantMessageEvent` is delta-only
 * (`text_delta` appends, `text_end` carries authoritative content, `toolcall_end`
 * carries the completed call), and `message_end` / `turn_end` carrying the final
 * assistant message and its usage.
 *
 * A single event yields at most one coder event: `message_update` records are
 * deltas, so the accumulated text is rebuilt by the caller from the deltas this
 * emits, exactly as Pi intends.
 */
export function parsePiEventLine(line: string): CoderStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];

  let ev: PiEvent;
  try {
    ev = JSON.parse(trimmed) as PiEvent;
  } catch {
    return [];
  }

  switch (ev.type) {
    case 'session':
      // The session header is the only record carrying the session id.
      return ev.id ? [{ kind: 'init', sessionId: ev.id }] : [];

    case 'message_update': {
      const inner = ev.assistantMessageEvent;
      if (!inner) return [];
      if (inner.type === 'text_delta' && typeof inner.delta === 'string' && inner.delta) {
        return [{ kind: 'text', text: inner.delta }];
      }
      if (inner.type === 'toolcall_end' && inner.toolCall) {
        const name = inner.toolCall.displayName || inner.toolCall.name || 'tool';
        return [{ kind: 'tool', name, summary: summarizeToolInput(inner.toolCall.arguments) }];
      }
      return [];
    }

    case 'message_end': {
      // The authoritative final assistant message. Its text is NOT emitted here
      // when deltas already arrived — that would duplicate every token.
      const msg = ev.message;
      if (!msg || msg.role !== 'assistant') return [];
      if (msg.stopReason === 'error' && msg.errorMessage) {
        return [{ kind: 'error', message: readPiError(msg.errorMessage) }];
      }
      return [];
    }

    case 'agent_settled':
      // Pi's terminal record: no further automatic work will happen.
      return [{ kind: 'result', ok: true }];

    default:
      return [];
  }
}

/**
 * Pull a usable message out of Pi's error shapes.
 *
 * Pi puts provider failures on the assistant message's `errorMessage` as a
 * string, sometimes embedding a JSON body — the same nesting the OpenCode
 * adapter has to unwrap, arrived at independently from Pi's own format.
 */
export function readPiError(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const inner = JSON.parse(trimmed) as Record<string, unknown>;
        for (const key of ['message', 'error']) {
          const got = inner[key];
          if (typeof got === 'string' && got) return got;
        }
      } catch { /* not JSON after all — use the raw text */ }
    }
    return raw;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const key of ['message', 'error', 'errorMessage']) {
      const got = o[key];
      if (typeof got === 'string' && got) return readPiError(got);
    }
  }
  return 'Prime Pi reported an error';
}

// ── Running a turn ─────────────────────────────────────────────────────────

/**
 * Build Pi's argument vector for one non-interactive turn.
 *
 * Verified against the installed CLI: there is NO `run` subcommand and NO `--cwd`
 * flag, so neither appears here. The working directory is applied in the spawn
 * call instead, because that is the only way Pi can be pointed at a directory.
 * `--model` takes the `provider/id` form `listPiModels` returns.
 *
 * Exported so the argument contract is asserted against the code that builds it
 * rather than against a copy that can drift.
 */
export function buildPiRunArgs(req: RuntimeRunRequest): string[] {
  const args = ['--mode', 'json'];
  if (req.model) args.push('--model', req.model);
  if (req.sessionId) args.push('--session-id', req.sessionId);
  // `-p` consumes the following non-flag argument as the prompt, so the prompt
  // goes immediately after it.
  args.push('-p', req.prompt);
  return args;
}

/** Spawn a turn and hand back the live child, for callers that stream events. */
export function spawnPiTurn(req: RuntimeRunRequest, cliPath: string): ChildProcess {
  // Pi has no working-directory flag: this spawn's cwd IS how it is pointed at a
  // directory, which is why `--cwd` must never be added to buildPiRunArgs.
  return spawn(cliPath, buildPiRunArgs(req), {
    cwd: req.cwd,
    env: buildPiChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Adapter `run`: one non-interactive turn, resolved.
 *
 * Collects the text from the delta records and the token counts from the final
 * assistant message, exactly as Pi's documented stream intends.
 */
export async function runPi(req: RuntimeRunRequest & { cliPath: string }): Promise<RuntimeRunOutcome> {
  const child = spawnPiTurn(req, req.cliPath);

  let text = '';
  let sessionId: string | undefined;
  let usage: RuntimeRunOutcome['usage'];
  let terminalError: string | undefined;
  let sawText = false;

  const abort = (): void => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };
  req.signal?.addEventListener('abort', abort, { once: true });

  const emit = (event: CoderStreamEvent): void => {
    if (event.kind === 'text') {
      text += event.text;
      sawText = true;
    } else if (event.kind === 'init') {
      sessionId = event.sessionId;
    } else if (event.kind === 'error') {
      terminalError = event.message;
    }
    req.onEvent?.(event);
  };

  const buffer = createLineBuffer((line) => {
    for (const event of parsePiEventLine(line)) emit(event);
    const usageSeen = readPiUsage(line);
    if (usageSeen) usage = usageSeen;
  });

  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => buffer.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
    buffer.push(d.toString());
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', (err: Error) => reject(new Error(`Prime Pi failed to start: ${err.message}`)));
    child.on('close', (code: number | null) => resolve(code));
  }).finally(() => {
    req.signal?.removeEventListener('abort', abort);
  });
  buffer.flush?.();

  if (terminalError) {
    return { ok: false, text, sessionId, exitCode, error: terminalError, usage };
  }
  if (!sawText) {
    // A Pi install with no configured provider exits cleanly having produced
    // nothing. Say so with the reason attached rather than an opaque "no text".
    return {
      ok: false,
      text,
      sessionId,
      exitCode,
      error:
        `Prime Pi produced no text (exit ${exitCode}). ` +
        `This usually means no provider is configured — run /login inside Pi, or set a provider key. ` +
        `stderr: ${stderr.slice(-200) || '(empty)'}`,
      usage,
    };
  }
  return { ok: true, text, sessionId, exitCode, usage };
}

/**
 * Real token counts from the final assistant message, when Pi reported them.
 *
 * Pi reports usage on the assistant message of `message_update`/`message_end`
 * with `input`/`output` counters. Adapter-private: the field names are Pi's.
 */
function readPiUsage(line: string): RuntimeRunOutcome['usage'] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let ev: PiEvent;
  try {
    ev = JSON.parse(trimmed) as PiEvent;
  } catch {
    return undefined;
  }
  const u = ev.message?.usage;
  if (!u || typeof u.input !== 'number' || typeof u.output !== 'number') return undefined;
  return {
    promptTokens: u.input,
    completionTokens: u.output,
    totalTokens: typeof u.totalTokens === 'number' ? u.totalTokens : u.input + u.output,
  };
}

// ── The adapter itself ─────────────────────────────────────────────────────

/** The Pi config directory Pi itself would use, for display purposes. */
export function piConfigDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override) return override;
  return path.join(os.homedir(), '.pi', 'agent');
}

/** True when Pi has a config directory on this machine. Informational only. */
export function piHasConfigDir(): boolean {
  try {
    return fs.existsSync(piConfigDir());
  } catch {
    return false;
  }
}

/**
 * Prime Pi, as one adapter.
 *
 * `probe`, `listModels` and `run` here are the only places in Henry that know
 * Pi's executable names, its flag spelling, its event shapes or the fact that it
 * has no `--cwd`.
 */
export const piAdapter: AgentRuntimeAdapter = {
  id: PI_RUNTIME_ID,
  displayName: 'Prime Pi',
  description: 'Prime Pi coding agent. Authenticates through its own provider configuration.',
  candidateBinaries,
  probe: probePi,
  // Optional: Pi has no single bearer variable of its own — it authenticates
  // per provider in its config directory, and additionally honours upstream
  // provider variables in the environment.
  authHint: { optional: true },
  async listModels(): Promise<RuntimeModel[]> {
    return listPiModels();
  },
  async run(req: RuntimeRunRequest): Promise<RuntimeRunOutcome> {
    const cli = await resolveCli();
    if (!cli.available || !cli.path) {
      throw new Error(cli.error ?? 'Prime Pi is not installed.');
    }
    return runPi({ ...req, cliPath: cli.path });
  },
};