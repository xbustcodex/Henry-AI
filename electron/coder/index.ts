/**
 * Coder Engine — IPC registration (follows the ai.ts streaming pattern).
 *
 * Channels (match preload.ts):
 *   coder:status — which engine is active + availability of both engines
 *   coder:run    — start a coding run; events stream to 'coder:event'
 *   coder:cancel — kill/abort a running coder run by channelId
 *
 * Authority: `coder:run` is a CONFIRM-tier operation. A coding agent reads and
 * modifies the filesystem, so a run is never started until the user has
 * approved that exact run in the agent confirmation modal. The gate is
 * `requestConfirmation` from electron/agent/toolRunner.ts — the same one
 * confirm-tier tools use — so there is one gate, one Approval Queue and one
 * modal, and the same fail-closed rule: no renderer, or no answer within the
 * timeout, means the agent does NOT spawn. There is deliberately no setting
 * that turns this off: an approval gate nobody can see or audit is not one.
 * See `approveCoderRun` for the gate itself.
 *
 * Engine choice — settings key `coder_engine`:
 *   'auto'        (default) → Claude Code CLI when detected, else local Ollama
 *   'claude-code'           → Claude Code CLI only
 *   'local'                 → free local qwen coder only
 *
 * Every event sent to the renderer is { channelId, event: CoderStreamEvent },
 * on the 'coder:event' channel via webContents.send — the same forwarding
 * shape ai:stream uses for its chunk/done/error events.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import type { CoderStreamEvent } from './streamJson';
import {
  CODER_WORKSPACE_DIR,
  detectClaudeCli,
  ensureCoderWorkspace,
  runClaudeCode,
} from './claudeCode';
import { randomUUID } from 'crypto';
import {
  getLocalCoderStatus,
  runLocalCoder,
  LOCAL_CODER_PULL_HINT,
  type LocalCoderStatus,
} from './localCoder';
import { runtimeForLegacyEngineSetting } from '../runtimes/registry';
import { requestConfirmation } from '../agent/toolRunner';
import type { AgentContext } from '../agent/types';
import { capture } from '../ipc/appLog';

type WindowGetter = () => BrowserWindow | null;

export type CoderEngineSetting = 'auto' | 'claude-code' | 'opencode' | 'local';
export type CoderActiveEngine = 'claude-code' | 'opencode' | 'local' | 'none';
/**
 * The name a coder run carries in the Approval Queue and the confirm modal.
 * The modal has no label for it, so it reads as "Coder Run".
 */
export const CODER_APPROVAL_TOOL = 'coder_run';

/**
 * One refusal message for every reason a coder run can be refused (declined,
 * timed out, no renderer to ask). The specific reason goes to the audit log,
 * not to the caller: a caller must not be able to tell them apart and treat
 * one as retryable.
 */
const CODER_RUN_REFUSED =
  'Coder run not approved — the coding agent was not started.';

interface CoderApprovalRequest {
  engine: CoderActiveEngine;
  /** Undefined for a local run with no project directory. */
  cwd?: string;
  prompt: string;
}

/**
 * Ask the user to authorise one coder run, and report the decision.
 *
 * The gate is unconditional and per-run: no engine, model or setting choice
 * pre-authorises the next one. It fails closed — a refusal, a timeout, or no
 * renderer to ask returns `{ ok: false }` and the caller must not spawn.
 *
 * `requestConfirmation` writes the queue row and its decision; what it does
 * not do is record WHY in the app log. That is this function's job, because
 * this is the one operation in the coder engine that acts on the user's files
 * without asking again: the log line is the only place the outcome survives
 * the run.
 */
async function approveCoderRun(
  context: AgentContext,
  request: CoderApprovalRequest,
): Promise<{ ok: true; prompt: string } | { ok: false }> {
  const where = request.cwd ?? 'no project directory';
  const id = randomUUID();
  const decision = await requestConfirmation(context, {
    id,
    toolName: CODER_APPROVAL_TOOL,
    args: { engine: request.engine, cwd: where, prompt: request.prompt },
    description:
      `Run the ${request.engine} coding agent, which can read and modify files in ${where}.`,
  });
  const outcome = decision.outcome ?? (decision.approved ? 'approved' : 'declined');
  // The prompt itself is deliberately NOT logged: it is already in the queue
  // row's args_json, and prompts carry whatever the user pasted.
  capture(
    decision.approved ? 'info' : 'warn',
    'coder',
    `coder run ${outcome} engine=${request.engine} cwd=${where} approval=${id}`,
  );
  if (!decision.approved) return { ok: false };
  // The modal lets the user edit the prompt before approving, so what runs is
  // what they read — an edit is only honoured if it still says something.
  const edited = decision.editedArgs?.prompt;
  const prompt = typeof edited === 'string' && edited.trim() ? edited : request.prompt;
  return { ok: true, prompt };
}

/** The one message for "the local coder cannot start", with the actionable half. */
function localCoderUnavailableMessage(status: LocalCoderStatus): string {
  return !status.ollamaRunning
    ? `Local coder unavailable: ${status.hint ?? 'Ollama is not running.'}`
    : `Local coder model not installed — ${status.hint ?? LOCAL_CODER_PULL_HINT}`;
}

interface CoderRunParams {
  prompt: string;
  cwd?: string;
  sessionId?: string;
  channelId: string;
}

/** Safely send to renderer — skips if window is destroyed (Vite HMR). */
function safeSend(getWin: WindowGetter, channel: string, data: unknown) {
  const win = getWin();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

const activeRuns = new Map<string, { cancel: () => void }>();

function readSetting(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function readEngineSetting(db: Database.Database): CoderEngineSetting {
  const raw = readSetting(db, 'coder_engine');
  return raw === 'claude-code' || raw === 'opencode' || raw === 'local' ? raw : 'auto';
}

export function registerCoderHandlers(db: Database.Database, getWindow: WindowGetter) {
  const sendEvent = (channelId: string, event: CoderStreamEvent) => {
    safeSend(getWindow, 'coder:event', { channelId, event });
    if (event.kind === 'result' || event.kind === 'error') {
      activeRuns.delete(channelId);
    }
  };

  // ── Status ────────────────────────────────────────────────────────────
  ipcMain.handle('coder:status', async (_e, opts?: { refresh?: boolean }) => {
    const engine = readEngineSetting(db);
    const claude = await detectClaudeCli(Boolean(opts?.refresh));
    // Which runtime serves this engine is the registry's knowledge, not this
    // file's: the engine setting is a persisted user choice and its value is
    // mapped to a runtime adapter in exactly one place.
    const runtime = runtimeForLegacyEngineSetting(engine);
    const probe = runtime ? await runtime.probe() : null;
    const opencode = {
      available: probe?.available ?? false,
      path: probe?.binaryPath,
      version: probe?.version,
      error: probe?.unavailableReason,
    };
    const local = await getLocalCoderStatus(readSetting(db, 'ollama_base_url') ?? undefined);

    let active: CoderActiveEngine;
    if (engine === 'claude-code') {
      active = claude.available ? 'claude-code' : 'none';
    } else if (engine === 'opencode') {
      active = opencode.available ? 'opencode' : 'none';
    } else if (engine === 'local') {
      active = local.model ? 'local' : 'none';
    } else {
      // auto: a detected CLI beats a local model, claude-code first.
      active = claude.available ? 'claude-code'
        : opencode.available ? 'opencode'
        : local.model ? 'local' : 'none';
    }

    return { engine, active, claude, opencode, local, workspaceDir: CODER_WORKSPACE_DIR };
  });

  // ── Run ───────────────────────────────────────────────────────────────
  ipcMain.handle('coder:run', async (_e, params: CoderRunParams) => {
    const { channelId } = params;
    if (!channelId || !params.prompt?.trim()) {
      return { started: false, error: 'A prompt and channelId are required.' };
    }

    const engineSetting = readEngineSetting(db);
    const claude = await detectClaudeCli();
    const runtime = runtimeForLegacyEngineSetting(engineSetting);
    const probe = runtime ? await runtime.probe() : null;
    const runtimeAvailable = probe?.available ?? false;

    // Resolve which engine actually runs this task.
    let engine: CoderActiveEngine = 'none';
    if (engineSetting === 'claude-code') {
      engine = claude.available ? 'claude-code' : 'none';
    } else if (engineSetting === 'opencode') {
      engine = runtimeAvailable ? 'opencode' : 'none';
    } else if (engineSetting === 'local') {
      engine = 'local'; // availability is verified below with a precise hint
    } else {
      engine = claude.available ? 'claude-code' : runtimeAvailable ? 'opencode' : 'local';
    }

    if (engine === 'none') {
      const message =
        engineSetting === 'opencode'
          ? 'opencode CLI not found. Install it (https://opencode.ai) and make sure `opencode` is on PATH — or switch the coder engine in Settings.'
          : 'No coder CLI found. Install Claude Code (npm i -g @anthropic-ai/claude-code) or opencode (https://opencode.ai) — or switch the coder engine to Local/Auto in Settings.';
      sendEvent(channelId, { kind: 'error', message });
      return { started: false, error: message };
    }

    // Resolve the working directory before the gate: the modal names the exact
    // directory the agent is about to write in. `ensureCoderWorkspace` only
    // ensures Henry's own workspace exists, so doing it here changes nothing
    // about what runs — it only means the approval describes it accurately.
    // The local engine treats no cwd as "no project", and is left that way.
    const cwd = params.cwd?.trim() || (engine === 'local' ? undefined : ensureCoderWorkspace());

    const baseUrl = readSetting(db, 'ollama_base_url') ?? undefined;
    // Ollama availability for a local run, checked BEFORE the gate: consent
    // asked for a run that cannot start is not consent, it is a wasted prompt
    // and a queue row for nothing. It stays null for every other engine, and a
    // claude-code run whose binary did not resolve still falls through to the
    // local engine below and is probed there, exactly as before.
    let local: LocalCoderStatus | null = null;
    if (engine === 'local') {
      local = await getLocalCoderStatus(baseUrl);
      if (!local.model) {
        const message = localCoderUnavailableMessage(local);
        sendEvent(channelId, { kind: 'error', message });
        return { started: false, error: message };
      }
    }

    // ── The gate ──────────────────────────────────────────────────────────
    // Nothing below this line may spawn a process without an explicit
    // approval for THIS run. Which engine runs, and with which model, was
    // decided above and is none of the gate's business; whether it runs at all
    // is. Refused, timed out, or nobody to ask: same answer, no spawn.
    const approval = await approveCoderRun(
      { db, getWindow, sessionId: params.sessionId },
      { engine, cwd, prompt: params.prompt },
    );
    if (!approval.ok) {
      sendEvent(channelId, { kind: 'error', message: CODER_RUN_REFUSED });
      return { started: false, error: CODER_RUN_REFUSED };
    }
    // What runs is what the user approved — including a prompt they edited in
    // the modal.
    const prompt = approval.prompt;

    if (engine === 'claude-code' && claude.path) {
      const child = runClaudeCode({
        cliPath: claude.path,
        prompt,
        cwd: cwd ?? ensureCoderWorkspace(),
        sessionId: params.sessionId,
        configuredPermissionMode: readSetting(db, 'coder_permission_mode'),
        onEvent: (event) => sendEvent(channelId, event),
      });
      activeRuns.set(channelId, { cancel: () => child.kill('SIGTERM') });
      return { started: true, channelId, engine: 'claude-code' as const };
    }

    if (engine === 'opencode' && runtime && probe?.binaryPath) {
      const controller = new AbortController();
      void runtime.run({
        prompt,
        cwd: cwd ?? ensureCoderWorkspace(),
        sessionId: params.sessionId,
        model: readSetting(db, 'coder_opencode_model') ?? undefined,
        agent: readSetting(db, 'coder_opencode_agent') ?? undefined,
        signal: controller.signal,
        onEvent: (event) => sendEvent(channelId, event),
      }).catch((err: unknown) => {
        sendEvent(channelId, {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
      activeRuns.set(channelId, { cancel: () => controller.abort() });
      return { started: true, channelId, engine: 'opencode' as const };
    }

    // Local engine — verify Ollama + model, with an actionable hint on failure.
    // Probed above for a local run; this is the fall-through probe for a run
    // that resolved to another engine but had no usable binary.
    local ??= await getLocalCoderStatus(baseUrl);
    if (!local.model) {
      const message = localCoderUnavailableMessage(local);
      sendEvent(channelId, { kind: 'error', message });
      return { started: false, error: message };
    }

    const controller = new AbortController();
    activeRuns.set(channelId, { cancel: () => controller.abort() });
    void runLocalCoder({
      prompt,
      model: local.model,
      cwd,
      baseUrl,
      signal: controller.signal,
      onEvent: (event) => sendEvent(channelId, event),
    }).catch((err: unknown) => {
      sendEvent(channelId, {
        kind: 'error',
        message: `Local coder crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
    return { started: true, channelId, engine: 'local' as const };
  });

  // ── Cancel ────────────────────────────────────────────────────────────
  ipcMain.handle('coder:cancel', (_e, channelId: string) => {
    const run = activeRuns.get(channelId);
    if (run) {
      try {
        run.cancel();
      } catch {
        /* already gone */
      }
      activeRuns.delete(channelId);
      return { cancelled: true };
    }
    return { cancelled: false };
  });
}
