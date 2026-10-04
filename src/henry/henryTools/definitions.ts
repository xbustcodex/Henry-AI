/**
 * Allowlisted Henry tools for the local Ollama agent — model may only request these;
 * Henry executes them. Schemas follow OpenAI/Ollama `tools` shape (`type: function`).
 */

export const HENRY_TOOL_NAMES = [
  'get_system_status',
  'organize_files',
  'open_terminal',
  'open_path',
  'write_note',
] as const;

export type HenryToolName = (typeof HENRY_TOOL_NAMES)[number];

/** Valid strategies for `organize_files` (enforced again at execution time). */
export const ORGANIZE_STRATEGIES = ['type-then-date', 'date-then-type', 'flat'] as const;

export function isAllowedToolName(name: string): name is HenryToolName {
  return (HENRY_TOOL_NAMES as readonly string[]).includes(name);
}

/** Strict JSON-Schema-style parameter objects (`additionalProperties: false`). */
export type HenryFunctionToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties: false;
    };
  };
};

/**
 * Normalized tool definition list for the model (first Henry / Ollama pass).
 * No generic shell or command execution tool — only these five.
 */
export const HENRY_OLLAMA_TOOL_DEFINITIONS: readonly HenryFunctionToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_system_status',
      description: 'Get the current machine/system status and return a short summary.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'organize_files',
      description: 'Organize files in a target folder using a simple strategy.',
      parameters: {
        type: 'object',
        properties: {
          rootPath: {
            type: 'string',
            description: 'Target folder path or label (e.g. Desktop, Documents, or an absolute path).',
          },
          strategy: {
            type: 'string',
            description:
              'Organization strategy. Allowed values: type-then-date, date-then-type, flat.',
          },
        },
        required: ['rootPath', 'strategy'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_terminal',
      description: 'Open a terminal session or terminal view for the current platform.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_path',
      description: 'Open a file or folder path using the local system.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path to open: absolute or home-relative path, file:// URL, or http(s) URL.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_note',
      description: 'Create a simple local note/document.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the note.' },
          content: { type: 'string', description: 'Body text of the note.' },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
    },
  },
];

/** Ollama `/api/chat` `tools` payload (mutable copy if callers need to amend). */
export function buildHenryToolDefinitions(): HenryFunctionToolDefinition[] {
  return JSON.parse(JSON.stringify(HENRY_OLLAMA_TOOL_DEFINITIONS)) as HenryFunctionToolDefinition[];
}
