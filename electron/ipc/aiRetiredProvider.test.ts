/**
 * The transport boundary for a provider Henry has retired.
 *
 * The failure this pins down was not a crash — it was an answer. An install
 * whose `companion_provider` still read `groq` reached the router, found no
 * usable provider, and re-asked for a Groq key the user had already given,
 * while the credential it actually wanted sat in the database. Silently
 * answering from a different provider is the same bug wearing a hat, so the
 * boundary has one behaviour: refuse, name the provider, and issue no request.
 *
 * `fetch` is stubbed to throw on contact — if any of these tests ever reached a
 * transport, they would fail rather than quietly pass against the network.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
  BrowserWindow: class {},
}));

import { callAI, callAIWithTools, registerAIHandlers } from './ai';
import { RETIRED_PROVIDER_UNAVAILABLE_MESSAGE, isRetiredProviderId } from '../providers/retiredProviders';

let transportCalls = 0;

beforeEach(() => {
  transportCalls = 0;
  vi.stubGlobal('fetch', (async () => {
    transportCalls += 1;
    throw new Error('a retired provider must never reach the network');
  }) as unknown as typeof fetch);
});

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

// Obviously fake, but shaped like a real one so a leak would be visible.
const SECRET = 'gsk_not-a-real-secret-000000000';

describe('callAI with a retired provider', () => {
  it('fails with the unavailable-provider message instead of a provider it does not recognise', async () => {
    await expect(
      callAI({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'fake-test-key-000', messages: MESSAGES }),
    ).rejects.toThrow(RETIRED_PROVIDER_UNAVAILABLE_MESSAGE);
    expect(transportCalls).toBe(0);
  });

  it('names the provider, so the message is actionable rather than a generic failure', async () => {
    const error = await callAI({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'fake-test-key-000',
      messages: MESSAGES,
    }).catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain('groq');
  });

  it('writes no credential to the console while refusing', async () => {
    // The apiKey argument is the shape a stale row still carries. Whatever the
    // boundary does with it, it must not echo it: a refusal message is read
    // aloud and written to the renderer.
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    const error = await callAI({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      apiKey: SECRET,
      messages: MESSAGES,
    }).catch((e: unknown) => e as Error);
    vi.restoreAllMocks();

    expect((error as Error).message).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('callAIWithTools with a retired provider', () => {
  it('throws rather than degrading into a text-only round', async () => {
    // A text-only round would return `{toolCalls: []}` by construction, which
    // is indistinguishable from "the model chose not to call a tool" — the
    // exact silent-wrong-answer shape the bridge already refuses to produce.
    await expect(
      callAIWithTools({
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        apiKey: 'fake-test-key-000',
        messages: MESSAGES,
        modelTools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } } }],
      }),
    ).rejects.toThrow(RETIRED_PROVIDER_UNAVAILABLE_MESSAGE);
    expect(transportCalls).toBe(0);
  });
});

describe('ai:stream with a retired provider', () => {
  it('reports the error on the stream channel and opens no stream', async () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const win = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }) },
    };
    registerAIHandlers({} as unknown as Database.Database, () => win as never);

    const result = (await ipcHandlers.get('ai:stream')!({}, {
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'fake-test-key-000',
      messages: MESSAGES,
      channelId: 'ch-retired',
    })) as { started: boolean };

    expect(result.started).toBe(false);
    const errors = sent.filter((s) => s.channel === 'ai:stream:error');
    expect(errors).toHaveLength(1);
    expect(String(errors[0].payload.error)).toContain(RETIRED_PROVIDER_UNAVAILABLE_MESSAGE);
    expect(transportCalls).toBe(0);
  });
});

describe('the guard does not disturb supported providers', () => {
  it.each(['openai', 'anthropic', 'google', 'ollama', 'opencode', 'opencode-zen', 'relay'])(
    '%s is not treated as retired',
    (provider) => {
      expect(isRetiredProviderId(provider)).toBe(false);
    },
  );
});