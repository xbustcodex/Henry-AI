/**
 * ToolRegistry — the single source of truth for the tools Henry can call.
 *
 * Tool modules (memory, finance, …) build their `ToolDefinition[]` and hand
 * them here at startup. The runner asks the registry for a tool by name and
 * for the model-facing `toModelTools()` list it passes to the AI engine.
 *
 * See `henry-agent-layer-design-2026-06-07.md` §1.
 */

import type { ModelTool, ToolDefinition } from './types';

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** Register a tool. Later registrations of the same name win (last-wins). */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** Convenience for registering a batch. */
  registerAll(tools: ToolDefinition[]): void {
    for (const t of tools) this.register(t);
  }

  /** Look up a tool by its model-facing name. */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Every registered tool definition. */
  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Returns the tools array in OpenAI / Anthropic function-call format, ready
   * to drop into a chat completion request. Anthropic's `input_schema` is
   * derived from `function.parameters` by the AI engine when needed.
   */
  toModelTools(): ModelTool[] {
    return this.getAllTools().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  /**
   * Lightweight view for the renderer — name, description, safety tier, and
   * category. Backs the `agent:list-tools` IPC channel.
   */
  describe(): Array<{
    name: string;
    description: string;
    safetyLevel: string;
    category: string;
  }> {
    return this.getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      safetyLevel: t.safetyLevel,
      category: t.category,
    }));
  }
}

/** Process-wide singleton. Tool modules register against this at startup. */
export const registry = new ToolRegistry();
