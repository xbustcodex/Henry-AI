/**
 * Henry-owned local operations for the Ollama tool agent.
 * Maps allowlisted tools to safe bridge calls (no arbitrary shell commands).
 */

import type { HenryToolExecutionResult } from './henryToolResult';
import { normalizeHenryToolResult } from './henryToolResult';

/** Subset of `window.henryAPI` used by local agent tools — keeps tests/mocks small. */
export type HenryLocalOpsApi = {
  computerSystemInfo: () => Promise<HenrySystemInfo>;
  computerOpenApp: (appName: string) => Promise<HenryComputerShellResult>;
  computerOpenPath: (targetPath: string) => Promise<HenryComputerShellResult>;
  saveFact: (fact: HenrySaveFactInput) => Promise<unknown>;
  writeFile: (path: string, content: string) => Promise<boolean>;
};

type HenrySystemInfo = {
  platform?: string;
  arch?: string;
  hostname?: string;
  homeDir?: string;
  appVersion?: string;
  totalMemoryGB?: string;
  freeMemoryGB?: string;
  macOS?: string;
};

type HenryComputerShellResult = {
  success: boolean;
  output: string;
  error?: string;
};

type HenrySaveFactInput = {
  id?: string;
  conversation_id?: string;
  fact: string;
  category?: string;
  importance?: number;
  created_at?: string;
};

function pickTerminalAppName(platformHint: string): string {
  const p = platformHint.toLowerCase();
  if (p.includes('win')) return 'wt';
  if (p.includes('linux')) return 'x-terminal-emulator';
  return 'Terminal';
}

/** `get_system_status` → existing system info bridge. */
export async function henryLocalGetSystemStatus(api: HenryLocalOpsApi): Promise<HenryToolExecutionResult> {
  const tool = 'get_system_status';
  try {
    const info = await api.computerSystemInfo();
    const text = [
      `platform: ${info.platform ?? '?'}`,
      `arch: ${info.arch ?? '?'}`,
      `hostname: ${info.hostname ?? '?'}`,
      `memory (GB): total ${info.totalMemoryGB ?? '?'}, free ${info.freeMemoryGB ?? '?'}`,
      info.appVersion ? `app: ${info.appVersion}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return normalizeHenryToolResult({
      ok: true,
      tool,
      outputText: text,
      data: info,
    });
  } catch (e) {
    return normalizeHenryToolResult({
      ok: false,
      tool,
      outputText: `System status unavailable: ${e instanceof Error ? e.message : String(e)}`,
      error: 'system_info_failed',
    });
  }
}

export type OrganizeFilesInput = { rootPath: string; strategy: string };

/**
 * `organize_files` — no file moves in this pass; records intent only (truthful `ok: false`).
 */
export async function henryLocalOrganizeFiles(input: OrganizeFilesInput): Promise<HenryToolExecutionResult> {
  const tool = 'organize_files';
  return normalizeHenryToolResult({
    ok: false,
    tool,
    outputText: `File organization is not run automatically in this build. Understood: folder "${input.rootPath}" with strategy "${input.strategy}". No files were moved or renamed.`,
    error: 'organizer_not_executed',
    data: { recorded: true, rootPath: input.rootPath, strategy: input.strategy },
  });
}

/** `open_terminal` → existing desktop “open app” bridge (not arbitrary shell). */
export async function henryLocalOpenTerminal(api: HenryLocalOpsApi): Promise<HenryToolExecutionResult> {
  const tool = 'open_terminal';
  try {
    let appName = 'Terminal';
    try {
      const info = await api.computerSystemInfo();
      appName = pickTerminalAppName(info.platform || '');
    } catch {
      /* keep default */
    }
    const r = await api.computerOpenApp(appName);
    const ok = r.success === true;
    const outputText = r.output || (ok ? `Opened ${appName}.` : `Could not open terminal (${appName}).`);
    return normalizeHenryToolResult({
      ok,
      tool,
      outputText,
      data: r,
      ...(!ok ? { error: 'terminal_open_failed' } : {}),
    });
  } catch (e) {
    return normalizeHenryToolResult({
      ok: false,
      tool,
      outputText: `Terminal open failed: ${e instanceof Error ? e.message : String(e)}`,
      error: 'terminal_open_failed',
    });
  }
}

/** `open_path` → `computerOpenPath` (Electron shell APIs, no user shell commands). */
export async function henryLocalOpenPath(api: HenryLocalOpsApi, targetPath: string): Promise<HenryToolExecutionResult> {
  const tool = 'open_path';
  try {
    const r = await api.computerOpenPath(targetPath);
    const ok = r.success === true;
    const outputText = typeof r.output === 'string' ? r.output : JSON.stringify(r);
    return normalizeHenryToolResult({
      ok,
      tool,
      outputText,
      data: r,
      ...(!ok ? { error: 'open_path_failed' } : {}),
    });
  } catch (e) {
    return normalizeHenryToolResult({
      ok: false,
      tool,
      outputText: `open_path failed: ${e instanceof Error ? e.message : String(e)}`,
      error: 'open_path_failed',
    });
  }
}

export type WriteNoteInput = { title: string; content: string };

function slugifyNoteTitle(title: string): string {
  const s = title
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return s || 'note';
}

/**
 * `write_note` — persist via memory (`saveFact`) and, when supported, a small markdown file under the workspace.
 */
export async function henryLocalWriteNote(
  api: HenryLocalOpsApi,
  ctx: { conversationId: string },
  input: WriteNoteInput
): Promise<HenryToolExecutionResult> {
  const tool = 'write_note';
  const body = `# ${input.title}\n\n${input.content}`;
  const rel = `.henry-local-notes/${new Date().toISOString().slice(0, 10)}-${slugifyNoteTitle(input.title)}.md`;

  let fileWritten: string | undefined;
  try {
    const wrote = await api.writeFile(rel, body);
    if (wrote) fileWritten = rel;
  } catch {
    /* workspace file is optional */
  }

  try {
    const saved = await api.saveFact({
      conversation_id: ctx.conversationId,
      fact: `${input.title}\n\n${input.content}`,
      category: 'note',
      importance: 3,
    });
    const parts: string[] = [];
    if (fileWritten) parts.push(`Saved workspace note: ${fileWritten}.`);
    else parts.push('Workspace file note skipped (unavailable or not writable).');
    parts.push(`Saved to Henry memory (id: ${(saved as { id?: string })?.id ?? 'ok'}).`);
    return normalizeHenryToolResult({
      ok: true,
      tool,
      outputText: parts.join(' '),
      data: { filePath: fileWritten, fact: saved },
    });
  } catch (e) {
    return normalizeHenryToolResult({
      ok: false,
      tool,
      outputText: `Could not save note: ${e instanceof Error ? e.message : String(e)}`,
      error: 'write_note_failed',
    });
  }
}
