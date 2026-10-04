/**
 * Agent layer — shared types.
 *
 * Mirrors the contract in `henry-agent-layer-design-2026-06-07.md` §1. Every
 * tool Henry can call is a `ToolDefinition`: a name + description the model
 * sees, a JSON Schema for its params, a `category`, and a `safetyLevel` that
 * the tool runner uses to decide whether to execute silently, notify, or pause
 * for confirmation.
 */

import type Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';

/** Controls what the runner does before/after executing a tool. See §5. */
export type SafetyLevel = 'silent' | 'notify' | 'confirm';

export type ToolCategory =
  | 'memory'
  | 'calendar'
  | 'communication'
  | 'finance'
  | 'automation'
  | 'system'
  | 'external';

/** Minimal JSON Schema shape — enough to describe a params object. */
export interface JSONSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** Uniform result every tool returns. `retryable` hints the runner. */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  retryable?: boolean;
}

/**
 * Runtime context handed to every tool's `execute`. The DB is the live
 * better-sqlite3 handle from `database.ts`; `getWindow` lets a tool reach the
 * renderer if it ever needs to (most don't — the runner owns UI signalling).
 */
export interface AgentContext {
  db: Database.Database;
  getWindow: () => BrowserWindow | null;
  sessionId?: string;
}

export interface ToolDefinition {
  /** Stable identifier the model calls by. snake_case, e.g. `quote_create`. */
  name: string;
  /** Sent to the model — be specific about when to use it. */
  description: string;
  /** JSON Schema for the params object the model must produce. */
  inputSchema: JSONSchema;
  category: ToolCategory;
  safetyLevel: SafetyLevel;
  /** Human-readable "Henry wants to…" string shown in the confirm modal. */
  confirmPrompt?: (params: Record<string, unknown>) => string;
  execute: (params: Record<string, unknown>, context: AgentContext) => Promise<ToolResult>;
}

/** OpenAI / Anthropic-compatible function-tool wire format (OpenAI flavour). */
export interface ModelTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}
