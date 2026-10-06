/**
 * A tool-bearing Ollama round must always reach a terminal state.
 *
 * The failure this guards against is not an error — it is the ABSENCE of one.
 * Ollama accepts a `tools` body and then never answers: no response, no error,
 * no stream close. Nothing in the fetch path noticed, so the agent turn settled
 * on nothing at all and the renderer stayed on "Thinking…" forever.
 *
 * Time is driven with fake timers so the budget is asserted, not waited out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  callOllamaToolsRound,
  streamOllamaToolsRound,
  OllamaToolsTimeoutError,
  isOllamaToolsTimeout,
  OLLAMA_TOOLS_TIMEOUT_MS,
} from './ollama';
import type { OllamaFetch, OllamaHttpResponse } from './ollama';

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'henry-agent',
      description: 'agent',
      parameters: { type: 'object' as const, properties: {} },
    },
  },
];

const messages = [{ role: 'user' as const, content: 'Name one colour.' }];

/** A fetch that never settles — the exact shape of the reported stall. */
const neverSettles: OllamaFetch = () => new Promise(() => {});

/** Headers arrive, but the body never emits a record and never closes. */
const openBodyNoRecords: OllamaFetch = (async () => ({
  ok: true,
  status: 200,
  body: new ReadableStream({ start() {} }),
})) as unknown as OllamaFetch;

/** A well-behaved single-record stream. */
const oneRecord = (text: string): OllamaFetch =>
  (async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ message: { content: text }, done: true }) + '\n'),
        );
        controller.close();
      },
    }),
  })) as unknown as OllamaFetch;

/** Resolve to `'rejected'`/`'resolved'` without asserting on the thrown value. */
const settle = <T,>(p: Promise<T>): Promise<'rejected' | 'resolved'> =>
  p.then(
    () => 'resolved',
    () => 'rejected',
  );

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bounded Ollama tools rounds', () => {
  it('C: the round is not abandoned early — the budget is respected', async () => {
    let done = false;
    const promise = streamOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      fetchImpl: neverSettles,
    }).finally(() => {
      done = true;
    });
    promise.catch(() => {});

    // Still outstanding one tick short of the budget.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true);
  });

  it('C: the stall rejects with a typed timeout naming the model', async () => {
    const guarded = streamOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      fetchImpl: neverSettles,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(30_000);
    const err = await guarded;
    expect(err).toBeInstanceOf(OllamaToolsTimeoutError);
    expect(isOllamaToolsTimeout(err)).toBe(true);
    expect(String(err)).toContain('llama3.2:3b');
  });

  it('C: the buffered round is bounded on the same terms as the streamed one', async () => {
    const guarded = callOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      fetchImpl: neverSettles,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(await guarded).toBeInstanceOf(OllamaToolsTimeoutError);
  });

  it('C: a response whose stream never closes is abandoned too', async () => {
    const guarded = streamOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      fetchImpl: openBodyNoRecords,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(await guarded).toBeInstanceOf(OllamaToolsTimeoutError);
  });

  it('G: the outstanding request is ABORTED on timeout, not left running', async () => {
    let seen: AbortSignal | undefined;
    const fetchImpl: OllamaFetch = (_url, init) =>
      new Promise(() => {
        seen = init?.signal ?? undefined;
      });

    const guarded = streamOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      fetchImpl,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(30_000);
    await guarded;

    // Abandoning the call while leaving it running is what the rule forbids, so
    // the abort must actually have fired on the request's own signal.
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(true);
  });

  it('E: a completion arriving after the timeout cannot revive the abandoned round', async () => {
    let release!: (v: OllamaHttpResponse) => void;
    const fetchImpl: OllamaFetch = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const promise = streamOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      fetchImpl,
    });

    const guarded = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await guarded;
    expect(isOllamaToolsTimeout(err)).toBe(true);

    // The provider answers long after the turn was abandoned. Nothing may
    // re-settle the promise or push the text into the dead turn.
    release({ ok: true, status: 200, json: async () => ({ message: { content: 'Blue.' } }) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(isOllamaToolsTimeout(await guarded)).toBe(true);
    expect(await settle(promise)).toBe('rejected');
  });

  it('F: caller cancellation stays a cancellation, not a timeout', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchImpl: OllamaFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        seen = init?.signal ?? undefined;
        seen?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    const guarded = streamOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      signal: controller.signal,
      fetchImpl,
    }).catch((e: unknown) => e);

    controller.abort();
    const err = await guarded;

    expect(seen?.aborted).toBe(true);
    expect(isOllamaToolsTimeout(err)).toBe(false);
  });

  it('F: a round cancelled before it starts is not reported as a timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    const guarded = streamOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      signal: controller.signal,
      fetchImpl: neverSettles,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(30_000);
    const err = await guarded;
    expect(isOllamaToolsTimeout(err)).toBe(false);
  });

  it('G: the timer is released on the success path', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const round = await streamOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      fetchImpl: oneRecord('Blue.'),
    });

    expect(round.content).toBe('Blue.');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('G: the timer is released on the failure path too', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const guarded = callOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      fetchImpl: neverSettles,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(30_000);
    await guarded;

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('H: a genuine provider error survives — it is not replaced by the timeout', async () => {
    const guarded = callOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      fetchImpl: (async () => ({
        ok: false,
        status: 500,
        text: async () => 'upstream exploded',
      })) as unknown as OllamaFetch,
    }).catch((e: unknown) => e);

    const err = await guarded;
    expect(isOllamaToolsTimeout(err)).toBe(false);
    expect(String(err)).toContain('upstream exploded');
  });

  it('B: a round that answers is returned untouched — no timeout is invented', async () => {
    const deltas: string[] = [];
    const round = await streamOllamaToolsRound({
      model: 'llama3.2:3b',
      messages,
      modelTools: TOOLS,
      timeoutMs: 30_000,
      onDelta: (t) => deltas.push(t),
      fetchImpl: oneRecord('Blue.'),
    });

    expect(round.content).toBe('Blue.');
    expect(round.toolCalls).toEqual([]);
    expect(deltas).toEqual(['Blue.']);
  });

  it('the shipped budget is bounded and overridable per call', () => {
    expect(OLLAMA_TOOLS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(OLLAMA_TOOLS_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
