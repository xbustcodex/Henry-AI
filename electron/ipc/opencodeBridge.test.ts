import { describe, it, expect } from 'vitest';
import {
  messagesToPrompt,
  checkChatRequest,
  chatCompletionChunk,
  TOOLS_UNSUPPORTED_MESSAGE,
} from './opencodeBridge';

/**
 * The two pure translators in the bridge: the OpenAI-shaped chat request into
 * the single prompt `opencode run` accepts, and the CLI's NDJSON stream back
 * into assistant text. Both run inside the HTTP request path, so a silent
 * mistake shows up as an empty chat bubble rather than a crash.
 */
describe('messagesToPrompt — role labels survive multi-turn context', () => {
  it('labels system and assistant but leaves the user turn bare', () => {
    const prompt = messagesToPrompt([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
      { role: 'user', content: 'again' },
    ]);
    expect(prompt).toBe('[SYSTEM]\nYou are terse.\n\nping\n\n[ASSISTANT]\npong\n\nagain');
  });

  it('treats a message with no role as the user', () => {
    expect(messagesToPrompt([{ content: 'no role here' }])).toBe('no role here');
  });

  it('still produces a prompt from a system-only message list', () => {
    // A system-only turn is legal and must not collapse to an empty prompt,
    // which the CLI would answer with nothing at all.
    const prompt = messagesToPrompt([{ role: 'system', content: 'Answer only in haiku.' }]);
    expect(prompt).toBe('[SYSTEM]\nAnswer only in haiku.');
  });
});

describe('messagesToPrompt — OpenAI content parts', () => {
  it('flattens text parts and drops non-text parts', () => {
    const prompt = messagesToPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this picture?' },
          { type: 'image_url', image_url: { url: 'file:///tmp/a.png' } },
          { type: 'text', text: 'be brief' },
        ],
      },
    ]);
    expect(prompt).toBe('what is in this picture?\nbe brief');
  });

  it('skips a content array whose only parts carry no text', () => {
    expect(messagesToPrompt([{ role: 'user', content: [{ type: 'reasoning' }] }])).toBe('');
  });

  it('skips a non-array, non-string content object', () => {
    // Malformed payloads must not stringify to "[object Object]" in the prompt.
    const bad = { role: 'user', content: { text: 'hi' } } as unknown as { role?: string; content?: unknown };
    expect(messagesToPrompt([bad])).toBe('');
  });
});

describe('messagesToPrompt — empty turns are dropped', () => {
  it('drops absent, empty and whitespace-only content', () => {
    const messages = [
      { role: 'user' as const, content: undefined },
      { role: 'assistant' as const, content: '' },
      { role: 'user' as const, content: '   \n  ' },
      { role: 'user' as const, content: 'real question' },
    ];
    expect(messagesToPrompt(messages)).toBe('real question');
  });

  it('returns an empty string for an empty list', () => {
    expect(messagesToPrompt([])).toBe('');
  });
});

describe('checkChatRequest — tool-bearing requests are refused out loud', () => {
  /**
   * The bridge used to drop `tools` and answer with text only. That silence
   * is what made this look for weeks like a model-capability problem: 52
   * registered tools, a healthy model, and a permanent `{tool_calls: []}`.
   */
  it('refuses a request that carries tools', () => {
    const result = checkChatRequest({
      model: 'opencode/space-bunny-free',
      messages: [{ role: 'user', content: 'list files' }],
      tools: [{ type: 'function', function: { name: 'file_list', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.status).toBe(400);
    expect(result.error.type).toBe('bridge_tools_unsupported');
    expect(result.error.message).toBe(TOOLS_UNSUPPORTED_MESSAGE);
  });

  it('names the reason and the way out, so the message is actionable', () => {
    expect(TOOLS_UNSUPPORTED_MESSAGE).toContain('cannot execute');
    expect(TOOLS_UNSUPPORTED_MESSAGE).toMatch(/Ollama/);
  });

  it('accepts a plain chat request and plans the prompt', () => {
    const result = checkChatRequest({
      model: 'opencode/space-bunny-free',
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a plan');
    expect(result.plan).toEqual({ model: 'opencode/space-bunny-free', prompt: 'ping', stream: false });
  });

  it('treats an empty tools array as no tools', () => {
    const result = checkChatRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(result.ok).toBe(true);
  });

  it('still rejects a tool-bearing request that also has no model', () => {
    // Tools are checked first so the reason the user needs is the one they get.
    const result = checkChatRequest({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'x' }] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.type).toBe('bridge_tools_unsupported');
  });

  it('rejects a missing model', () => {
    const result = checkChatRequest({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.message).toBe('model is required');
  });

  it('rejects an empty message list', () => {
    const result = checkChatRequest({ model: 'm', messages: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.message).toBe('messages is required');
  });

  it('carries the stream flag through the plan', () => {
    const result = checkChatRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
    if (!result.ok) throw new Error('expected a plan');
    expect(result.plan.stream).toBe(true);
  });
});

describe('chatCompletionChunk — the SSE frame an OpenAI client expects', () => {
  it('emits a content delta', () => {
    expect(chatCompletionChunk('c1', 100, 'm', { content: 'Hel' })).toEqual({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 100,
      model: 'm',
      choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }],
    });
  });

  it('emits the terminal frame with a finish reason', () => {
    const frame = chatCompletionChunk('c1', 100, 'm', {}, 'stop') as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(frame.choices[0].finish_reason).toBe('stop');
  });

  it('emits usage on its own frame with no choices', () => {
    const frame = chatCompletionChunk('c1', 100, 'm', {}, null, {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });
    expect(frame.choices).toEqual([]);
    expect(frame.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });
});

describe('checkChatRequest — the refusal is not shape-dependent', () => {
  /**
   * A shape test (`Array.isArray`) let `tools: {}`, `tools: "x"` and
   * `tools: {"a":1}` through. Nothing executes them, so it was never a
   * code-execution hole — but the caller would believe its tool definitions
   * were honoured and would report zero tool calls without ever being told the
   * bridge cannot do them. That is the silent gap the refusal exists to close.
   */
  const base = { model: 'opencode/space-bunny-free', messages: [{ role: 'user', content: 'hi' }] };

  const refused = (extra: Record<string, unknown>) => {
    const result = checkChatRequest({ ...base, ...extra });
    if (result.ok) throw new Error(`expected ${JSON.stringify(extra)} to be refused`);
    expect(result.status).toBe(400);
    expect(result.error.type).toBe('bridge_tools_unsupported');
    expect(result.error.message).toBe(TOOLS_UNSUPPORTED_MESSAGE);
  };

  it('refuses a non-array tools object', () => refused({ tools: {} }));
  it('refuses a tools object with content', () => refused({ tools: { a: 1 } }));
  it('refuses a string tools value', () => refused({ tools: 'file_list' }));
  it('refuses a numeric tools value', () => refused({ tools: 7 }));
  it('refuses a boolean tools value', () => refused({ tools: true }));
  it('treats tools: null as "not specified" rather than as a request', () => {
    const result = checkChatRequest({ ...base, tools: null });
    expect(result.ok).toBe(true);
  });

  it('refuses the legacy functions field', () => refused({ functions: [{ name: 'file_list' }] }));
  it('refuses a non-array functions value', () => refused({ functions: { file_list: {} } }));

  it('refuses function_call: auto', () => refused({ function_call: 'auto' }));
  it('refuses function_call naming a function', () => refused({ function_call: { name: 'file_list' } }));
  it('refuses a non-empty function_call array', () => refused({ function_call: [{ name: 'x' }] }));

  it('still allows no tools at all', () => {
    const result = checkChatRequest(base);
    expect(result.ok).toBe(true);
  });

  it('still allows an empty tools array', () => {
    expect(checkChatRequest({ ...base, tools: [] }).ok).toBe(true);
  });

  it('still allows an empty legacy functions array', () => {
    expect(checkChatRequest({ ...base, functions: [] }).ok).toBe(true);
  });

  it("allows function_call 'none', which opts out of tools rather than asking for them", () => {
    expect(checkChatRequest({ ...base, function_call: 'none' }).ok).toBe(true);
  });

  it('refuses tools even when a model is also missing, keeping the actionable reason', () => {
    const result = checkChatRequest({ messages: [{ role: 'user', content: 'hi' }], tools: {} });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.type).toBe('bridge_tools_unsupported');
  });

  it('does not confuse a message body with a tools field', () => {
    // A user turn that merely mentions tools is not a tool request.
    const result = checkChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'use the file_list tool please' }],
    });
    expect(result.ok).toBe(true);
  });
});
