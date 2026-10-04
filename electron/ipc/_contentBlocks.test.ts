import { describe, it, expect } from 'vitest';
import { block, toolCallBlocks } from './_contentBlocks';

describe('content block builders', () => {
  it('builds a text block', () => {
    expect(block.text('hello')).toEqual({ type: 'text', text: 'hello' });
  });

  it('builds a tool_use block', () => {
    expect(block.toolUse('id1', 'open_app', { name: 'Safari' })).toEqual({
      type: 'tool_use', id: 'id1', name: 'open_app', input: { name: 'Safari' },
    });
  });

  it('builds a tool_result block, defaulting is_error to false', () => {
    expect(block.toolResult('id1', 'ok')).toEqual({
      type: 'tool_result', tool_use_id: 'id1', content: 'ok', is_error: false,
    });
    expect(block.toolResult('id1', 'boom', true)).toMatchObject({ is_error: true });
  });

  it('builds an image block as a reference (never inline bytes)', () => {
    const b = block.image({ artifactId: 'art_42', alt: 'screenshot' });
    expect(b).toMatchObject({ type: 'image', artifact_id: 'art_42', alt: 'screenshot' });
    // No base64/data field is produced by the builder.
    expect(JSON.stringify(b)).not.toMatch(/data:|base64/);
  });

  it('builds an action block with status + timing', () => {
    expect(block.action('click', { target: 'Submit', params: { x: 1, y: 2 }, status: 'ok', durationMs: 45 }))
      .toEqual({ type: 'action', kind: 'click', target: 'Submit', params: { x: 1, y: 2 }, status: 'ok', duration_ms: 45 });
  });
});

describe('toolCallBlocks', () => {
  it('pairs a tool_use with its tool_result, linked by id', () => {
    const blocks = toolCallBlocks('run_shell', 'tc1', { command: 'ls' }, 'file_a', false);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'tool_use', id: 'tc1', name: 'run_shell' });
    expect(blocks[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'tc1', is_error: false });
  });

  it('marks the result as an error when isError is true', () => {
    const [, result] = toolCallBlocks('run_shell', 'tc2', {}, 'permission denied', true);
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'tc2', is_error: true });
  });
});
