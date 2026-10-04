/**
 * Message content convention — pure, Electron-free so it can be imported and
 * unit-tested anywhere. Re-exported from sessionStore.ts for existing callers.
 *
 * A message's `content` is either a plain string OR a list of typed blocks, so
 * one message can represent tool use and agent actions — not just text. Use
 * these builders everywhere (chat, tool runner, scheduler, the future
 * computer-use layer) so the whole corpus shares one shape; the Python store
 * flattens block text into messages.content_text for FTS. Mirrors the
 * convention documented at the top of session_store.py.
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'image'; uri?: string; artifact_id?: string; alt?: string }
  | { type: 'action'; kind: string; target?: string; params?: unknown; status?: string; duration_ms?: number }
  | { type: 'observation'; source: string; data: unknown };

export const block = {
  text: (text: string): ContentBlock => ({ type: 'text', text }),
  toolUse: (id: string, name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id, name, input }),
  toolResult: (toolUseId: string, content: unknown, isError = false): ContentBlock =>
    ({ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }),
  image: (ref: { uri?: string; artifactId?: string; alt?: string }): ContentBlock =>
    ({ type: 'image', uri: ref.uri, artifact_id: ref.artifactId, alt: ref.alt }),
  action: (kind: string, opts: { target?: string; params?: unknown; status?: string; durationMs?: number } = {}): ContentBlock =>
    ({ type: 'action', kind, target: opts.target, params: opts.params, status: opts.status, duration_ms: opts.durationMs }),
  observation: (source: string, data: unknown): ContentBlock => ({ type: 'observation', source, data }),
};

/**
 * Canonical content for a completed tool/agent call: the assistant's `tool_use`
 * paired with its `tool_result`. Pass straight to recordSessionMessage as
 * `content` (with kind: 'tool_result').
 */
export function toolCallBlocks(
  name: string, id: string, input: unknown, result: unknown, isError = false,
): ContentBlock[] {
  return [block.toolUse(id, name, input), block.toolResult(id, result, isError)];
}

/** Discriminator for messages.kind — lets the agent layer query actions
 * without parsing JSON content. */
export type MessageKind = 'chat' | 'tool_call' | 'tool_result' | 'action' | 'observation';

/** What triggered a session — distinguishes a user chat from automated runs. */
export type SessionOrigin = 'chat' | 'webhook' | 'schedule' | 'api' | 'automation';
