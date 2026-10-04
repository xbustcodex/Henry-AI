import { describe, it, expect, vi } from 'vitest';
import { runToolConversation, resolveConfirmation, type ModelCompletion } from './toolRunner';
import { ToolRegistry } from './toolRegistry';
import type { AgentContext, ToolDefinition, SafetyLevel } from './types';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** A fake tool whose execute is a spy. */
function fakeTool(
  name: string,
  safetyLevel: SafetyLevel,
  execute: ToolDefinition['execute'] = async () => ({ ok: true, data: 'done' }),
): ToolDefinition {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: { type: 'object' },
    category: 'system',
    safetyLevel,
    confirmPrompt: (p) => `do ${name} with ${JSON.stringify(p)}`,
    execute,
  };
}

/** A scripted `complete`: returns each queued completion in turn, then a final
 * no-tool answer. */
function scriptedComplete(queue: ModelCompletion[]) {
  let i = 0;
  return vi.fn(async () => {
    if (i < queue.length) return queue[i++];
    return { content: 'final answer', toolCalls: [] };
  });
}

/** A fake renderer window. `onConfirmRequired` lets a test answer the gate. */
function fakeContext(onConfirmRequired?: (payload: { id: string }) => void): {
  context: AgentContext;
  sent: Array<{ channel: string; payload: any }>;
} {
  const sent: Array<{ channel: string; payload: any }> = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: any) => {
        sent.push({ channel, payload });
        if (channel === 'agent:confirm-required') onConfirmRequired?.(payload);
      },
    },
  };
  const context = {
    db: {} as AgentContext['db'],
    getWindow: () => win as unknown as ReturnType<AgentContext['getWindow']>,
    // sessionId left undefined so the runner skips the session-store import.
  } as AgentContext;
  return { context, sent };
}

const callOnce = (name: string, args: Record<string, unknown> = {}): ModelCompletion => ({
  content: '',
  toolCalls: [{ id: `call-${name}`, name, arguments: args }],
});

// ── Silent / notify tiers: run without confirmation ──────────────────────────

describe('runToolConversation — silent & notify tiers', () => {
  it('executes a silent tool without any confirmation prompt', async () => {
    const exec = vi.fn(async () => ({ ok: true, data: 1 }));
    const reg = new ToolRegistry();
    reg.register(fakeTool('read_thing', 'silent', exec));
    const { context, sent } = fakeContext();

    const res = await runToolConversation({
      registry: reg, context,
      messages: [{ role: 'user', content: 'go' }],
      complete: scriptedComplete([callOnce('read_thing')]),
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(sent.some((s) => s.channel === 'agent:confirm-required')).toBe(false);
    expect(res.content).toBe('final answer');
  });

  it('executes a notify tool and emits a tool-notify event', async () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('write_note', 'notify'));
    const { context, sent } = fakeContext();

    await runToolConversation({
      registry: reg, context,
      messages: [{ role: 'user', content: 'go' }],
      complete: scriptedComplete([callOnce('write_note')]),
    });

    expect(sent.some((s) => s.channel === 'agent:confirm-required')).toBe(false);
    expect(sent.some((s) => s.channel === 'agent:tool-notify')).toBe(true);
  });
});

// ── Confirm tier: the security boundary ──────────────────────────────────────

describe('runToolConversation — confirm tier (approval gate)', () => {
  it('does NOT execute until approved, then executes', async () => {
    const exec = vi.fn(async () => ({ ok: true }));
    const reg = new ToolRegistry();
    reg.register(fakeTool('send_email', 'confirm', exec));
    // Approve as soon as the gate fires.
    const { context } = fakeContext((p) => resolveConfirmation(p.id, true));

    await runToolConversation({
      registry: reg, context,
      messages: [{ role: 'user', content: 'go' }],
      complete: scriptedComplete([callOnce('send_email', { to: 'a@b.c' })]),
    });

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('does NOT execute when the user declines', async () => {
    const exec = vi.fn(async () => ({ ok: true }));
    const reg = new ToolRegistry();
    reg.register(fakeTool('send_email', 'confirm', exec));
    const { context } = fakeContext((p) => resolveConfirmation(p.id, false));

    await runToolConversation({
      registry: reg, context,
      messages: [{ role: 'user', content: 'go' }],
      complete: scriptedComplete([callOnce('send_email')]),
    });

    expect(exec).not.toHaveBeenCalled();
  });

  it('fails safe (no execution) when there is no renderer window to confirm', async () => {
    const exec = vi.fn(async () => ({ ok: true }));
    const reg = new ToolRegistry();
    reg.register(fakeTool('send_email', 'confirm', exec));
    const context = {
      db: {} as AgentContext['db'],
      getWindow: () => null,
    } as AgentContext;

    await runToolConversation({
      registry: reg, context,
      messages: [{ role: 'user', content: 'go' }],
      complete: scriptedComplete([callOnce('send_email')]),
    });

    expect(exec).not.toHaveBeenCalled();
  });

  it('applies edited args from the confirmation', async () => {
    const exec = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true }));
    const reg = new ToolRegistry();
    reg.register(fakeTool('send_email', 'confirm', exec));
    const { context } = fakeContext((p) => resolveConfirmation(p.id, true, { to: 'edited@x.com' }));

    await runToolConversation({
      registry: reg, context,
      messages: [{ role: 'user', content: 'go' }],
      complete: scriptedComplete([callOnce('send_email', { to: 'original@x.com' })]),
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toEqual({ to: 'edited@x.com' });
  });
});

// ── Loop safety & error handling ─────────────────────────────────────────────

describe('runToolConversation — loop & error handling', () => {
  it('returns an error result for an unknown tool (and keeps going)', async () => {
    const reg = new ToolRegistry(); // no tools registered
    const { context } = fakeContext();
    const res = await runToolConversation({
      registry: reg, context,
      messages: [{ role: 'user', content: 'go' }],
      complete: scriptedComplete([callOnce('nonexistent')]),
    });
    // The model gets a tool error and we still terminate with the final answer.
    expect(res.content).toBe('final answer');
  });

  it('stops at maxRounds when the model keeps calling tools', async () => {
    const exec = vi.fn(async () => ({ ok: true }));
    const reg = new ToolRegistry();
    reg.register(fakeTool('loop_tool', 'silent', exec));
    const { context } = fakeContext();
    // complete ALWAYS asks for the tool again → would loop forever without the cap.
    const complete = vi.fn(async () => callOnce('loop_tool'));

    const res = await runToolConversation({
      registry: reg, context,
      messages: [{ role: 'user', content: 'go' }],
      complete,
      maxRounds: 3,
    });

    expect(res.rounds).toBe(3);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(res.content).toMatch(/action limit/i);
  });

  it('captures a thrown tool error as an error result rather than crashing', async () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('boom', 'silent', vi.fn(async () => { throw new Error('kaboom'); })));
    const { context } = fakeContext();
    const res = await runToolConversation({
      registry: reg, context,
      messages: [{ role: 'user', content: 'go' }],
      complete: scriptedComplete([callOnce('boom')]),
    });
    expect(res.content).toBe('final answer'); // loop survived the throw
  });
});
