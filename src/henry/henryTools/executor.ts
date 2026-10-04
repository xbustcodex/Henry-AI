import { ORGANIZE_STRATEGIES, type HenryToolName, isAllowedToolName } from './definitions';
import type { HenryToolExecutionResult } from '../localAgent/henryToolResult';
import {
  henryLocalGetSystemStatus,
  henryLocalOrganizeFiles,
  henryLocalOpenPath,
  henryLocalOpenTerminal,
  henryLocalWriteNote,
  type HenryLocalOpsApi,
} from '../localAgent/henryLocalOps';

export type { HenryToolExecutionResult };

const PATH_MAX = 4096;

function safePathSegment(s: string): boolean {
  if (!s || s.length > PATH_MAX) return false;
  if (/[\x00\r\n]/.test(s)) return false;
  if (/[;&|`$()<>]/.test(s)) return false;
  return true;
}

function validateOrganizeArgs(raw: unknown): { rootPath: string; strategy: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const rootPath = o.rootPath;
  const strategy = o.strategy;
  if (typeof rootPath !== 'string' || typeof strategy !== 'string') return null;
  if (!safePathSegment(rootPath)) return null;
  if (!(ORGANIZE_STRATEGIES as readonly string[]).includes(strategy)) return null;
  return { rootPath, strategy };
}

function validateOpenPathArgs(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string' || path.length === 0 || path.length > PATH_MAX) return null;
  if (/[\x00]/.test(path)) return null;
  return path;
}

function validateWriteNoteArgs(raw: unknown): { title: string; content: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = o.title;
  const content = o.content;
  if (typeof title !== 'string' || typeof content !== 'string') return null;
  if (title.length > 500 || content.length > 50_000) return null;
  return { title, content };
}

function parseToolArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson || '{}');
  } catch {
    return null;
  }
}

function asLocalOpsApi(api: NonNullable<typeof window.henryAPI>): HenryLocalOpsApi {
  return {
    computerSystemInfo: () => api.computerSystemInfo(),
    computerOpenApp: (name) => api.computerOpenApp(name),
    // computerOpenPath maps to computerOpenApp — opens files/folders via Electron shell
    computerOpenPath: (p) => api.computerOpenApp(p),
    saveFact: (f) => api.saveFact(f),
    writeFile: (path, content) => api.writeFile(path, content),
  };
}

/**
 * Execute one allowlisted tool: validate name + args, then route to `henryLocalOps`.
 * No arbitrary shell — only Henry-owned bridges.
 */
export async function executeHenryTool(
  toolName: string,
  argumentsJson: string,
  ctx: { conversationId: string }
): Promise<HenryToolExecutionResult> {
  if (!isAllowedToolName(toolName)) {
    return {
      ok: false,
      tool: toolName,
      outputText: 'Rejected: tool is not on the allowlist.',
      error: 'not_allowlisted',
    };
  }

  const name = toolName as HenryToolName;
  const args = parseToolArguments(argumentsJson);

  const api = typeof window !== 'undefined' ? window.henryAPI : undefined;
  if (!api) {
    return {
      ok: false,
      tool: name,
      outputText: 'Henry API unavailable.',
      error: 'no_henry_api',
    };
  }

  const ops = asLocalOpsApi(api);

  switch (name) {
    case 'get_system_status': {
      if (args !== null && (typeof args !== 'object' || Object.keys(args as object).length > 0)) {
        return {
          ok: false,
          tool: name,
          outputText: 'get_system_status does not accept arguments.',
          error: 'invalid_args',
        };
      }
      return henryLocalGetSystemStatus(ops);
    }
    case 'organize_files': {
      const v = validateOrganizeArgs(args);
      if (!v) {
        return {
          ok: false,
          tool: name,
          outputText:
            'Invalid organize_files arguments (need rootPath and strategy; strategy must be one of: type-then-date, date-then-type, flat).',
          error: 'invalid_args',
        };
      }
      return henryLocalOrganizeFiles(v);
    }
    case 'open_terminal': {
      if (args !== null && (typeof args !== 'object' || Object.keys(args as object).length > 0)) {
        return {
          ok: false,
          tool: name,
          outputText: 'open_terminal does not accept arguments.',
          error: 'invalid_args',
        };
      }
      return henryLocalOpenTerminal(ops);
    }
    case 'open_path': {
      const path = validateOpenPathArgs(args);
      if (!path) {
        return {
          ok: false,
          tool: name,
          outputText: 'open_path requires a non-empty string path.',
          error: 'invalid_args',
        };
      }
      return henryLocalOpenPath(ops, path);
    }
    case 'write_note': {
      const v = validateWriteNoteArgs(args);
      if (!v) {
        return {
          ok: false,
          tool: name,
          outputText: 'write_note requires title and content strings.',
          error: 'invalid_args',
        };
      }
      return henryLocalWriteNote(ops, { conversationId: ctx.conversationId }, v);
    }
    default:
      return {
        ok: false,
        tool: name,
        outputText: 'Unreachable',
        error: 'unknown',
      };
  }
}
