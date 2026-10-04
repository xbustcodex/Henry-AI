import { describe, it, expect } from 'vitest';
import {
  parseClaudeStreamJsonLine,
  summarizeToolInput,
  createLineBuffer,
  type CoderStreamEvent,
} from './streamJson';

describe('parseClaudeStreamJsonLine', () => {
  it('parses the init event with session id and model', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-123',
      model: 'claude-sonnet-4-20250514',
      cwd: '/tmp/proj',
      tools: ['Bash', 'Edit'],
    });
    expect(parseClaudeStreamJsonLine(line)).toEqual([
      { kind: 'init', sessionId: 'sess-123', model: 'claude-sonnet-4-20250514' },
    ]);
  });

  it('parses assistant text and tool_use blocks in order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look at that file.' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/proj/src/a.ts' } },
        ],
      },
      session_id: 'sess-123',
    });
    expect(parseClaudeStreamJsonLine(line)).toEqual([
      { kind: 'text', text: 'Let me look at that file.' },
      { kind: 'tool', name: 'Read', summary: '/tmp/proj/src/a.ts' },
    ]);
  });

  it('parses a success result with session, cost, and turns', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done — added the function.',
      session_id: 'sess-123',
      total_cost_usd: 0.0123,
      duration_ms: 4200,
      num_turns: 3,
    });
    expect(parseClaudeStreamJsonLine(line)).toEqual([
      {
        kind: 'result',
        ok: true,
        text: 'Done — added the function.',
        sessionId: 'sess-123',
        costUsd: 0.0123,
        durationMs: 4200,
        numTurns: 3,
      },
    ]);
  });

  it('marks error results as not ok', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'sess-9',
      num_turns: 1,
    });
    const events = parseClaudeStreamJsonLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'result', ok: false, sessionId: 'sess-9' });
  });

  it('ignores user (tool_result) events, blank lines, and malformed JSON', () => {
    expect(
      parseClaudeStreamJsonLine(
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
      )
    ).toEqual([]);
    expect(parseClaudeStreamJsonLine('')).toEqual([]);
    expect(parseClaudeStreamJsonLine('   ')).toEqual([]);
    expect(parseClaudeStreamJsonLine('{not json')).toEqual([]);
    expect(parseClaudeStreamJsonLine('"just a string"')).toEqual([]);
  });

  it('ignores unknown event types (forward compatibility)', () => {
    expect(parseClaudeStreamJsonLine(JSON.stringify({ type: 'stream_event', event: {} }))).toEqual([]);
  });
});

describe('summarizeToolInput', () => {
  it('picks the most descriptive field and flattens whitespace', () => {
    expect(summarizeToolInput({ command: 'ls  -la\n/tmp' })).toBe('ls -la /tmp');
    expect(summarizeToolInput({ file_path: '/a/b.ts', command: 'ignored' })).toBe('/a/b.ts');
  });

  it('truncates long values to 120 chars', () => {
    const long = 'x'.repeat(300);
    const out = summarizeToolInput({ command: long });
    expect(out.length).toBe(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty string for missing or non-object input', () => {
    expect(summarizeToolInput(undefined)).toBe('');
    expect(summarizeToolInput(null)).toBe('');
    expect(summarizeToolInput('str')).toBe('');
    expect(summarizeToolInput({ unrelated: 42 })).toBe('');
  });
});

describe('createLineBuffer', () => {
  it('reassembles lines split across chunks', () => {
    const lines: string[] = [];
    const buf = createLineBuffer((l) => lines.push(l));
    buf.push('{"type":"sys');
    buf.push('tem"}\n{"type":"assistant"}\n{"partial');
    expect(lines).toEqual(['{"type":"system"}', '{"type":"assistant"}']);
    buf.flush();
    expect(lines).toEqual(['{"type":"system"}', '{"type":"assistant"}', '{"partial']);
  });

  it('skips empty lines', () => {
    const lines: string[] = [];
    const buf = createLineBuffer((l) => lines.push(l));
    buf.push('\n\n  \na\n');
    expect(lines).toEqual(['a']);
  });
});

describe('event vocabulary round-trip', () => {
  it('a full session transcript produces the expected event sequence', () => {
    const transcript = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] },
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'passed' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All tests pass.' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All tests pass.', session_id: 's1' }),
    ];
    const events: CoderStreamEvent[] = transcript.flatMap(parseClaudeStreamJsonLine);
    expect(events.map((e) => e.kind)).toEqual(['init', 'tool', 'text', 'result']);
  });
});
