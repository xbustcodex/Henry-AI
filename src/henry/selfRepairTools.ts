/**
 * Henry AI — Self-Repair Tools
 *
 * Gives Henry the ability to:
 *   1. Read his own error log and lessons
 *   2. Write lessons, constitution overrides, personality patches at runtime
 *   3. Read and write source files (Electron dev mode only)
 *   4. Run TypeScript typecheck (Electron dev mode only)
 *   5. List source directory entries
 *
 * Tools follow the same OpenAI function-calling schema as webTools.ts.
 * The executor is called from ChatView before the streaming LLM call,
 * injecting results as a structured context block.
 */

import type { ToolDefinition } from './webTools';
import {
  logError,
  addLesson,
  addConstitutionOverride,
  patchPersonality,
  getRecentErrors,
  getUnresolvedErrors,
  getLessons,
} from './selfRepairStore';

// ── Tool Definitions ──────────────────────────────────────────────────────────

export const HENRY_SELF_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'henry_get_errors',
      description: 'Read your own error log — recent runtime crashes, render errors, and AI tool failures that have been captured. Use when the user reports something is broken or to check your own health.',
      parameters: {
        type: 'object',
        properties: {
          unresolved_only: {
            type: 'string',
            description: 'Set to "true" to return only unresolved errors.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'henry_learn_lesson',
      description: 'Record a permanent lesson you have learned about yourself, the user, or how you should behave. This persists across all future sessions. Use when you realize something important that should not be forgotten.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The lesson to record. Be specific and actionable.',
          },
          category: {
            type: 'string',
            description: 'One of: behavior, preference, correction, capability, pattern',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'henry_update_constitution',
      description: 'Add a new rule to your own operating constitution that will apply in every future session. Use when you identify a principle or operating rule that should become permanent.',
      parameters: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            description: 'The section name for this rule (e.g., "Communication", "Priorities", "Error handling").',
          },
          rule: {
            type: 'string',
            description: 'The rule to add. Be precise and actionable.',
          },
          reason: {
            type: 'string',
            description: 'Optional: why this rule is being added.',
          },
        },
        required: ['section', 'rule'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'henry_update_personality',
      description: 'Update a specific personality trait about yourself at runtime. This persists permanently and shapes how you show up in all future conversations.',
      parameters: {
        type: 'object',
        properties: {
          trait: {
            type: 'string',
            description: 'The personality trait to update (e.g., "tone", "verbosity", "humor", "formality").',
          },
          value: {
            type: 'string',
            description: 'The new value or description for this trait.',
          },
          reason: {
            type: 'string',
            description: 'Optional: why you are making this change.',
          },
        },
        required: ['trait', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'henry_read_source_file',
      description: 'Read a source file from the Henry AI codebase (only available in development mode). Use when you need to inspect current code to understand what exists before making a change.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path from the project root (e.g., "src/henry/charter.ts").',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'henry_write_source_file',
      description: 'Write or overwrite a source file in the Henry AI codebase (only available in development mode). Use to add or fix code. Always read the file first before overwriting.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path from the project root (e.g., "src/henry/myFeature.ts").',
          },
          content: {
            type: 'string',
            description: 'The complete file content to write.',
          },
          reason: {
            type: 'string',
            description: 'Why you are writing this file.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'henry_run_typecheck',
      description: 'Run TypeScript typecheck (tsc --noEmit) on the Henry AI codebase (only available in development mode). Use after writing source files to verify there are no errors.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'henry_list_source_dir',
      description: 'List files and directories in a source directory of the Henry AI codebase (only available in development mode). Use to explore the codebase before reading or writing files.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative directory path from the project root (e.g., "src/henry").',
          },
        },
        required: ['path'],
      },
    },
  },
];

// ── Detection ──────────────────────────────────────────────────────────────────

const SELF_TOOL_PATTERNS = [
  /\b(fix yourself|fix your(self)?|repair yourself|heal yourself)\b/i,
  /\b(you have an error|you.{0,15}broken|something.{0,15}broken in you)\b/i,
  /\b(learn (from|this)|remember (this|that) (always|forever|permanently))\b/i,
  /\b(add (a|this|that) rule|update your (rules|constitution|personality|traits))\b/i,
  /\b(add (a|new) feature|add (this|that) to yourself|build yourself|improve yourself)\b/i,
  /\b(read (the )?source|look at (your )?code|see (the )?code)\b/i,
  /\b(write (to )?source|modify (the )?code|update (the )?code|fix (the )?code)\b/i,
  /\b(typecheck|type check|run tsc|check for errors)\b/i,
  /\b(check (your )?errors|what errors|show (me )?(the )?error log)\b/i,
  /\b(change (your )?personality|change how you|adjust how you|be (more|less))\b/i,
];

export function shouldUseSelfTools(message: string): boolean {
  return SELF_TOOL_PATTERNS.some((p) => p.test(message));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function isElectron(): boolean {
  return typeof (window as any).henryAPI?.readSourceFile === 'function';
}

function isElectronBasic(): boolean {
  return typeof (window as any).henryAPI?.execTerminal === 'function';
}

// ── Executor ───────────────────────────────────────────────────────────────────

export interface SelfToolResult {
  toolName: string;
  output: string;
  error?: string;
}

async function executeSelfTool(
  name: string,
  args: Record<string, string>
): Promise<SelfToolResult> {
  try {
    switch (name) {

      case 'henry_get_errors': {
        const unresolvedOnly = args.unresolved_only === 'true';
        const errors = unresolvedOnly ? getUnresolvedErrors() : getRecentErrors(15);
        if (errors.length === 0) {
          return { toolName: name, output: 'No errors found in the error log — things look clean.' };
        }
        const lines = errors.map(
          (e) =>
            `[${e.type} / ${e.severity}${e.resolved ? ' / RESOLVED' : ''}] ${e.message}` +
            (e.component ? ` (${e.component})` : '') +
            (e.capturedAt ? ` — ${new Date(e.capturedAt).toLocaleString()}` : '')
        );
        return {
          toolName: name,
          output: `Error log (${errors.length} entries):\n${lines.join('\n')}`,
        };
      }

      case 'henry_learn_lesson': {
        const content = args.content?.trim();
        if (!content) return { toolName: name, output: '', error: 'No lesson content provided.' };
        const category = (['behavior', 'preference', 'correction', 'capability', 'pattern'].includes(args.category ?? ''))
          ? (args.category as import('./selfRepairStore').Lesson['category'])
          : 'pattern';
        const lesson = addLesson(content, category);
        return {
          toolName: name,
          output: `Lesson recorded [${lesson.category}]: "${lesson.content}"\nThis will be part of my permanent self-knowledge going forward.`,
        };
      }

      case 'henry_update_constitution': {
        const section = args.section?.trim();
        const rule = args.rule?.trim();
        if (!section || !rule) return { toolName: name, output: '', error: 'section and rule are required.' };
        const override = addConstitutionOverride(section, rule, args.reason);
        return {
          toolName: name,
          output: `Constitution rule added [${override.section}]: "${override.rule}"\nThis rule is now permanent and will apply in all future sessions.`,
        };
      }

      case 'henry_update_personality': {
        const trait = args.trait?.trim();
        const value = args.value?.trim();
        if (!trait || !value) return { toolName: name, output: '', error: 'trait and value are required.' };
        const patch = patchPersonality(trait, value, args.reason);
        return {
          toolName: name,
          output: `Personality updated [${patch.trait}]: "${patch.value}"${patch.previous ? `\nPrevious: "${patch.previous}"` : ''}\nThis trait is now permanently updated.`,
        };
      }

      case 'henry_read_source_file': {
        const filePath = args.path?.trim();
        if (!filePath) return { toolName: name, output: '', error: 'path is required.' };
        if (!isElectron()) {
          return {
            toolName: name,
            output: '',
            error: 'Source file access requires the desktop app (Electron) in development mode. Not available in the browser.',
          };
        }
        try {
          const content = await (window as any).henryAPI.readSourceFile(filePath) as string;
          const lines = content.split('\n');
          const preview = lines.length > 200
            ? lines.slice(0, 200).join('\n') + `\n\n[...${lines.length - 200} more lines truncated]`
            : content;
          return {
            toolName: name,
            output: `File: ${filePath} (${lines.length} lines)\n\n${preview}`,
          };
        } catch (err) {
          return { toolName: name, output: '', error: `Could not read ${filePath}: ${String(err)}` };
        }
      }

      case 'henry_write_source_file': {
        const filePath = args.path?.trim();
        const content = args.content;
        if (!filePath || content === undefined) return { toolName: name, output: '', error: 'path and content are required.' };
        if (!isElectron()) {
          return {
            toolName: name,
            output: '',
            error: 'Source file writing requires the desktop app (Electron) in development mode.',
          };
        }
        try {
          await (window as any).henryAPI.writeSourceFile(filePath, content);
          logError('ai_failure', `Self-wrote source file: ${filePath}`, {
            context: args.reason || 'No reason provided',
            severity: 'low',
          });
          return {
            toolName: name,
            output: `Written: ${filePath}\n${args.reason ? `Reason: ${args.reason}\n` : ''}File saved. Run henry_run_typecheck to verify there are no TypeScript errors.`,
          };
        } catch (err) {
          return { toolName: name, output: '', error: `Could not write ${filePath}: ${String(err)}` };
        }
      }

      case 'henry_run_typecheck': {
        if (!isElectronBasic()) {
          return {
            toolName: name,
            output: '',
            error: 'TypeScript check requires the desktop app (Electron) in development mode.',
          };
        }
        try {
          const result = await (window as any).henryAPI.execTerminal({
            command: 'npx tsc --noEmit 2>&1',
            timeout: 60000,
          }) as { success: boolean; stdout: string; stderr: string; exitCode: number };
          const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
          if (result.success || result.exitCode === 0) {
            return { toolName: name, output: 'TypeScript check passed — zero errors.' };
          }
          const errorLines = combined.split('\n').slice(0, 40).join('\n');
          return {
            toolName: name,
            output: `TypeScript check found errors (exit ${result.exitCode}):\n${errorLines}`,
          };
        } catch (err) {
          return { toolName: name, output: '', error: `typecheck failed to run: ${String(err)}` };
        }
      }

      case 'henry_list_source_dir': {
        const dirPath = args.path?.trim() || 'src';
        if (!isElectronBasic()) {
          return {
            toolName: name,
            output: '',
            error: 'Directory listing requires the desktop app (Electron) in development mode.',
          };
        }
        try {
          const result = await (window as any).henryAPI.execTerminal({
            command: `find "${dirPath}" -maxdepth 2 -type f \\( -name "*.ts" -o -name "*.tsx" \\) | head -80 2>&1`,
            timeout: 10000,
          }) as { stdout: string; stderr: string };
          const output = (result.stdout || result.stderr || '').trim();
          return {
            toolName: name,
            output: output || `No TypeScript files found in ${dirPath}.`,
          };
        } catch (err) {
          return { toolName: name, output: '', error: `Could not list ${dirPath}: ${String(err)}` };
        }
      }

      default:
        return { toolName: name, output: '', error: `Unknown self-repair tool: ${name}` };
    }
  } catch (err) {
    logError('tool_failure', `Self-repair tool "${name}" threw unexpectedly: ${String(err)}`, {
      severity: 'medium',
    });
    return { toolName: name, output: '', error: String(err) };
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface SelfToolRunResult {
  contextBlock: string;
  results: SelfToolResult[];
}

/**
 * Run self-repair tool pipeline for a user message.
 * Returns a context block to inject before the LLM streaming call.
 */
export async function runSelfTools(
  userMessage: string,
  opts: { onStatus?: (msg: string) => void } = {}
): Promise<SelfToolRunResult> {
  const { onStatus } = opts;

  // Determine which tools to invoke based on message patterns
  const toolsToRun: Array<{ name: string; args: Record<string, string> }> = [];

  if (/\b(error|broken|fix|repair|crash|bug)\b/i.test(userMessage)) {
    toolsToRun.push({ name: 'henry_get_errors', args: { unresolved_only: 'false' } });
  }

  if (/\b(learn|lesson|remember (this|that) (always|forever|permanently))\b/i.test(userMessage)) {
    // Don't auto-run — let the LLM decide when to call henry_learn_lesson
  }

  // For simple status check requests with no specific tool, just surface errors
  if (toolsToRun.length === 0 && /\b(check|status|health|how are you doing)\b/i.test(userMessage)) {
    toolsToRun.push({ name: 'henry_get_errors', args: { unresolved_only: 'true' } });
  }

  if (toolsToRun.length === 0) {
    // Provide self tools as context but let LLM decide what to call
    return {
      contextBlock: buildSelfToolsContextHint(userMessage),
      results: [],
    };
  }

  onStatus?.('Checking my own systems…');

  const results: SelfToolResult[] = [];
  for (const { name, args } of toolsToRun) {
    const result = await executeSelfTool(name, args);
    results.push(result);
  }

  const contextParts = results.map((r) => {
    if (r.error) return `🔧 ${r.toolName}: Error — ${r.error}`;
    return `🔧 ${r.toolName}:\n${r.output}`;
  });

  return {
    contextBlock: contextParts.length > 0
      ? `\n\n🔧 Self-Repair Context:\n${contextParts.join('\n\n')}`
      : '',
    results,
  };
}

function buildSelfToolsContextHint(message: string): string {
  const lessons = getLessons().slice(0, 3);
  const parts: string[] = [];

  if (lessons.length > 0) {
    parts.push(`Recent lessons you've recorded:\n${lessons.map((l) => `- ${l.content}`).join('\n')}`);
  }

  if (/\b(add|write|create|build|implement|feature)\b/i.test(message) && isElectron()) {
    parts.push('Source file tools available: henry_read_source_file, henry_write_source_file, henry_run_typecheck, henry_list_source_dir');
  }

  return parts.length > 0
    ? `\n\n🔧 Self-context:\n${parts.join('\n\n')}`
    : '';
}

/**
 * Execute a single named self-repair tool call.
 * Called when the LLM explicitly invokes a tool by name in its response.
 */
export async function executeSingleSelfTool(
  name: string,
  args: Record<string, string>
): Promise<string> {
  const result = await executeSelfTool(name, args);
  if (result.error) return `Error: ${result.error}`;
  return result.output;
}
