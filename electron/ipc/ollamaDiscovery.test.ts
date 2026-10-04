/**
 * The defect: Henry's local models came from a hand-written table, so the list
 * was a claim about the user's disk that could be wrong in both directions.
 *
 * Every test here mocks the two endpoints Ollama actually serves — `/api/tags`
 * for the inventory and `/api/show` for capabilities — and asserts that what
 * Henry exposes is what the runtime said. The `dynamic inventory` block is the
 * one the campaign requires: it changes the mocked runtime between two calls and
 * asserts Henry's catalogue follows. No table can pass that, and that is the
 * point of writing it.
 */
import { describe, it, expect } from 'vitest';
import {
  discoverOllamaModels,
  describeOllamaModel,
  displayNameFor,
  legacyCapabilitiesFor,
  type OllamaFetcher,
} from './ollamaCapabilities';

interface FakeTag {
  name: string;
  size?: number;
  digest?: string;
  modified_at?: string;
  details?: Record<string, unknown>;
}

/** Exactly the shape `/api/tags` returns, verbatim field names. */
interface FakeRuntime {
  tags: FakeTag[];
  /** `/api/show` per model id, exactly as Ollama returns it. */
  show: Record<string, unknown>;
  /** Model ids the runtime reports it cannot serve. */
  unloadable?: string[];
  /** Ids whose `/api/show` never answers, to exercise the timeout path. */
  hang?: string[];
  /** Make the whole runtime unreachable. */
  down?: boolean;
  showStatus?: number;
}

function fakeOllama(rt: FakeRuntime): { fetchImpl: OllamaFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: OllamaFetcher = async (url, init) => {
    calls.push(url);
    if (rt.down) throw new Error('ECONNREFUSED');
    if (url.endsWith('/api/tags')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: rt.tags.map((t) => ({
            name: t.name,
            model: t.name,
            size: t.size ?? 1_000_000_000,
            digest: t.digest ?? 'abc123',
            modified_at: t.modified_at ?? '2026-01-01T00:00:00Z',
            details: t.details ?? { family: 'llama', parameter_size: '3B' },
          })),
        }),
      };
    }
    if (url.endsWith('/api/show')) {
      const id = String(JSON.parse(init?.body ?? '{}').model);
      if (rt.hang?.includes(id)) return new Promise(() => {}) as never;
      if (rt.unloadable?.includes(id)) return { ok: false, status: 404, json: async () => ({}) };
      if (rt.showStatus) return { ok: false, status: rt.showStatus, json: async () => ({}) };
      const show = rt.show[id];
      if (show === undefined) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => show };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const BASE = 'http://127.0.0.1:11434';

describe('discovery exposes exactly what the runtime reports', () => {
  it('returns one entry per installed model, with the ids Ollama uses', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'llama3.2:3b' }, { name: 'qwen2.5-coder:7b' }],
      show: {
        'llama3.2:3b': { capabilities: ['completion', 'tools'] },
        'qwen2.5-coder:7b': { capabilities: ['completion', 'tools', 'insert'] },
      },
    });

    const found = await discoverOllamaModels(BASE, fetchImpl);

    expect(found.models.map((m) => m.id)).toEqual(['llama3.2:3b', 'qwen2.5-coder:7b']);
  });

  it('asks the runtime about each model rather than deciding from the name', async () => {
    const { fetchImpl, calls } = fakeOllama({
      tags: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      show: {
        a: { capabilities: ['completion'] },
        b: { capabilities: ['completion', 'tools'] },
        c: { capabilities: ['completion', 'vision'] },
      },
    });

    await discoverOllamaModels(BASE, fetchImpl);

    expect(calls.filter((c) => c.endsWith('/api/show'))).toHaveLength(3);
  });

  it('keeps the inventory even when some models cannot be inspected', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'good:1b' }, { name: 'broken:1b' }],
      show: { 'good:1b': { capabilities: ['completion'] } },
    });

    const found = await discoverOllamaModels(BASE, fetchImpl);

    expect(found.models.map((m) => m.id)).toEqual(['good:1b', 'broken:1b']);
    expect(found.models[1]!.detailStatus).toBe('missing');
  });
});

describe('dynamic inventory — the test a table cannot pass', () => {
  it('gains a model the runtime gained, with no change to Henry', async () => {
    const rt: FakeRuntime = {
      tags: [{ name: 'llama3.2:3b' }],
      show: { 'llama3.2:3b': { capabilities: ['completion', 'tools'] } },
    };

    const before = await discoverOllamaModels(BASE, fakeOllama(rt).fetchImpl);
    expect(before.models.map((m) => m.id)).toEqual(['llama3.2:3b']);

    rt.tags.push({ name: 'moondream:latest' });
    rt.show['moondream:latest'] = { capabilities: ['completion', 'vision'] };

    const after = await discoverOllamaModels(BASE, fakeOllama(rt).fetchImpl);
    expect(after.models.map((m) => m.id)).toEqual(['llama3.2:3b', 'moondream:latest']);
  });

  it('loses a model the user deleted — a table would keep offering it forever', async () => {
    const rt: FakeRuntime = {
      tags: [{ name: 'llama3.2:3b' }, { name: 'gpt-oss:20b' }],
      show: {
        'llama3.2:3b': { capabilities: ['completion', 'tools'] },
        'gpt-oss:20b': { capabilities: ['completion', 'tools', 'thinking'] },
      },
    };

    expect((await discoverOllamaModels(BASE, fakeOllama(rt).fetchImpl)).models).toHaveLength(2);

    rt.tags = rt.tags.filter((t) => t.name !== 'gpt-oss:20b');

    const after = await discoverOllamaModels(BASE, fakeOllama(rt).fetchImpl);
    expect(after.models.map((m) => m.id)).toEqual(['llama3.2:3b']);
  });

  it('never returns a model the runtime does not hold, whatever it is called', async () => {
    const rt: FakeRuntime = {
      tags: [{ name: 'moondream:latest' }],
      show: { 'moondream:latest': { capabilities: ['completion', 'vision'] } },
    };

    const found = await discoverOllamaModels(BASE, fakeOllama(rt).fetchImpl);

    // The 19 models the old static table offered included none of these.
    for (const phantom of ['mistral-nemo', 'codellama:34b', 'qwen2.5:72b', 'llama3.1:70b', 'phi4']) {
      expect(found.models.map((m) => m.id)).not.toContain(phantom);
    }
  });

  it('exposes a model nobody had written down, because the runtime holds it', async () => {
    const rt: FakeRuntime = {
      tags: [{ name: 'some-model-nobody-predicted:9b' }],
      show: { 'some-model-nobody-predicted:9b': { capabilities: ['completion', 'tools'] } },
    };

    const found = await discoverOllamaModels(BASE, fakeOllama(rt).fetchImpl);

    expect(found.models.map((m) => m.id)).toEqual(['some-model-nobody-predicted:9b']);
  });
});

describe('capabilities come from /api/show, never from the name', () => {
  it('refuses vision for a model named for vision that the runtime says has none', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'llama3.2-vision-actually-text:3b' }],
      show: { 'llama3.2-vision-actually-text:3b': { capabilities: ['completion', 'tools'] } },
    });

    const [model] = (await discoverOllamaModels(BASE, fetchImpl)).models;

    expect(model!.capabilities).not.toContain('vision');
    expect(model!.capabilitySource).toBe('runtime');
  });

  it('grants vision for a model whose name says nothing about seeing', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'tiny-text-model:1b' }],
      show: { 'tiny-text-model:1b': { capabilities: ['completion', 'vision'] } },
    });

    const [model] = (await discoverOllamaModels(BASE, fetchImpl)).models;

    expect(model!.capabilities).toContain('vision');
  });

  it('reports insert and embedding, which decide whether fill-in and vectors are possible', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'nomic-embed-text:latest' }, { name: 'qwen2.5-coder:7b' }],
      show: {
        'nomic-embed-text:latest': { capabilities: ['embedding'] },
        'qwen2.5-coder:7b': { capabilities: ['completion', 'tools', 'insert'] },
      },
    });

    const found = await discoverOllamaModels(BASE, fetchImpl);

    expect(found.models[0]!.capabilities).toEqual(['embedding']);
    expect(found.models[1]!.capabilities).toEqual(['completion', 'tools', 'insert']);
  });

  it('distinguishes three same-family models that a name rule would merge', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'llama3.2:3b' }, { name: 'deepseek-coder:6.7b' }, { name: 'moondream:latest' }],
      show: {
        'llama3.2:3b': { capabilities: ['completion', 'tools'] },
        'deepseek-coder:6.7b': { capabilities: ['completion'] },
        'moondream:latest': { capabilities: ['completion', 'vision'] },
      },
    });

    const found = await discoverOllamaModels(BASE, fetchImpl);

    // These are the three live measurements from this machine that make the
    // whole point: two of them are `llama`-family models with different answers.
    expect(found.models[0]!.capabilities).toEqual(['completion', 'tools']);
    expect(found.models[1]!.capabilities).toEqual(['completion']);
    expect(found.models[2]!.capabilities).toEqual(['completion', 'vision']);
  });

  it('keeps a capability this build has no name for instead of dropping it', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'future:1b' }],
      show: { 'future:1b': { capabilities: ['completion', 'audio'] } },
    });

    const [model] = (await discoverOllamaModels(BASE, fetchImpl)).models;

    expect(model!.capabilities).toEqual(['completion', 'audio']);
  });
});

describe('the metadata needed to route a local model', () => {
  it('reports what the runtime reported, not what the model name suggests', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [
        {
          name: 'llama3.2:3b',
          size: 2_019_393_189,
          details: {
            family: 'llama',
            families: ['llama'],
            parameter_size: '3.2B',
            quantization_level: 'Q4_K_M',
          },
        },
      ],
      show: {
        'llama3.2:3b': {
          capabilities: ['completion', 'tools'],
          model_info: { 'llama.context_length': 131072, 'llama.embedding_length': 3072 },
        },
      },
    });

    const [model] = (await discoverOllamaModels(BASE, fetchImpl)).models;

    expect(model).toMatchObject({
      provider: 'ollama',
      runtime: 'ollama',
      id: 'llama3.2:3b',
      local: true,
      requiresApiKey: false,
      family: 'llama',
      parameterSize: '3.2B',
      quantization: 'Q4_K_M',
      contextLength: 131072,
    });
  });

  it('bounds every request, so a wedged runtime cannot hang the picker', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchImpl: OllamaFetcher = async (url, init) => {
      signals.push(init?.signal);
      if (url.endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: [{ name: 'x:1b', model: 'x:1b' }] }) };
      }
      // The abort this signal carries is the only thing that ends this call.
      throw new DOMException('The operation was aborted.', 'AbortError');
    };

    const found = await discoverOllamaModels(BASE, fetchImpl);

    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    // Aborted rather than dropped: the model is still listed, marked degraded.
    expect(found.models.map((m) => m.id)).toEqual(['x:1b']);
    expect(found.models[0]!.detailStatus).toBe('unreachable');
    expect(found.models[0]!.warning).toMatch(/could not reach Ollama/);
  });
  it('reads context length from /api/tags details when /api/show omits it', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'moondream:latest', details: { family: 'phi2', families: ['phi2', 'clip'], parameter_size: '1B', context_length: 2048 } }],
      show: { 'moondream:latest': { capabilities: ['completion', 'vision'] } },
    });

    const [model] = (await discoverOllamaModels(BASE, fetchImpl)).models;

    expect(model!.contextLength).toBe(2048);
    expect(model!.families).toEqual(['phi2', 'clip']);
  });

  it('states plainly that a local model needs no key', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'llama3.2:3b' }],
      show: { 'llama3.2:3b': { capabilities: ['completion'] } },
    });

    const [model] = (await discoverOllamaModels(BASE, fetchImpl)).models;

    // Explicit false, not `undefined`: nothing downstream may have to infer it.
    expect(model!.requiresApiKey).toBe(false);
    expect(model!.local).toBe(true);
  });

  it('reports an unknown context length as unknown rather than inventing one', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'mystery:1b', details: { family: 'x', parameter_size: '1B' } }],
      show: { 'mystery:1b': { capabilities: ['completion'] } },
    });

    const [model] = (await discoverOllamaModels(BASE, fetchImpl)).models;

    expect(model!.contextLength).toBeNull();
  });
});

describe('a local model is not gated on an API key', () => {
  it('lists models even when nothing at all is configured', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'llama3.2:3b' }],
      show: { 'llama3.2:3b': { capabilities: ['completion', 'tools'] } },
    });

    // Discovery takes no credentials at all — there is nowhere to pass one.
    const found = await discoverOllamaModels(BASE, fetchImpl);

    expect(found.models).toHaveLength(1);
    expect(found.models[0]!.requiresApiKey).toBe(false);
  });
});

describe('a model that cannot be loaded produces a clean state, not a hang', () => {
  it('marks a model the runtime cannot serve as unloadable and says how to fix it', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'corrupt:7b' }],
      show: {},
      unloadable: ['corrupt:7b'],
    });

    const [model] = (await discoverOllamaModels(BASE, fetchImpl)).models;

    expect(model!.loadable).toBe(false);
    expect(model!.detailStatus).toBe('missing');
    expect(model!.warning).toMatch(/ollama pull corrupt:7b/);
  });

  it('resolves with an empty catalogue and an actionable message when Ollama is down', async () => {
    const { fetchImpl } = fakeOllama({ tags: [], show: {}, down: true });

    const found = await discoverOllamaModels(BASE, fetchImpl);

    expect(found.models).toEqual([]);
    expect(found.warnings[0]).toMatch(/ollama serve/i);
  });

  it('does not claim a model is unusable when the lookup merely failed', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'llama3.2:3b' }],
      show: {},
      showStatus: 500,
    });

    const [model] = (await discoverOllamaModels(BASE, fetchImpl)).models;

    // Unknown loadability must stay unknown: a 500 is our problem, not the
    // model's, and disabling a working model over it would be a new bug.
    expect(model!.loadable).toBeNull();
    expect(model!.capabilities).toEqual([]);
    expect(model!.capabilitySource).toBe('unknown');
  });

  it('keeps the models it could describe when one lookup does not answer', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'fine:1b' }, { name: 'mute:1b' }],
      show: { 'fine:1b': { capabilities: ['completion'] } },
      showStatus: undefined,
      hang: [],
    });

    const found = await discoverOllamaModels(BASE, fetchImpl);

    // `mute:1b` has no /api/show record, so it is reported as unloadable rather
    // than silently omitted — an absent model and a broken one are different
    // states and the user has to be able to tell them apart.
    expect(found.models.map((m) => m.id)).toEqual(['fine:1b', 'mute:1b']);
    expect(found.models[0]!.capabilitySource).toBe('runtime');
    expect(found.models[1]!.detailStatus).toBe('missing');
  });

});

describe('the legacy fallback is last-resort and says so', () => {
  it('applies only when the runtime answers without a capabilities array', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'moondream:latest' }, { name: 'some-new-thing:7b' }],
      show: {
        // An old runtime: /api/show works, but has no `capabilities` field.
        'moondream:latest': { details: { family: 'phi2' } },
        'some-new-thing:7b': { details: { family: 'qwen2' } },
      },
    });

    const found = await discoverOllamaModels(BASE, fetchImpl);
    const [known, unknown] = found.models;

    expect(known!.capabilities).toEqual(['completion', 'vision']);
    expect(known!.capabilitySource).toBe('fallback');
    expect(known!.detailStatus).toBe('assumed');
    // Visible, not silent — the user must be able to tell a guess from a fact.
    expect(known!.warning).toMatch(/does not report capabilities/);
    expect(found.warnings).toContain(known!.warning);

    // A model the fallback has never heard of gets nothing invented.
    expect(unknown!.capabilities).toEqual([]);
    expect(unknown!.capabilitySource).toBe('unknown');
    expect(unknown!.warning).toBeUndefined();
  });

  it('is bypassed entirely as soon as the runtime reports capabilities', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'llava:7b' }],
      show: { 'llava:7b': { capabilities: ['completion'] } },
    });

    const [model] = (await discoverOllamaModels(BASE, fetchImpl)).models;

    // The name matches the legacy vision list; the runtime says text-only. The
    // runtime wins, because the fallback only exists when the runtime is mute.
    expect(legacyCapabilitiesFor('llava:7b')).toContain('vision');
    expect(model!.capabilities).toEqual(['completion']);
    expect(model!.capabilitySource).toBe('runtime');
  });

  it('never fires for the live 0.34.4 inventory, because that runtime answers', async () => {
    // The seven models this machine actually holds, with the capabilities
    // `/api/show` returns for each. Every one must come back `runtime`-sourced;
    // if the fallback ever starts answering for them, the runtime has been
    // silently replaced by a table again.
    const { fetchImpl } = fakeOllama({
      tags: [
        { name: 'moondream:latest', details: { family: 'phi2', families: ['phi2', 'clip'], parameter_size: '1B', context_length: 2048 } },
        { name: 'llama3.2:3b', details: { family: 'llama', parameter_size: '3.2B', context_length: 131072 } },
        { name: 'gpt-oss:20b', details: { family: 'gptoss', parameter_size: '20.9B', context_length: 131072 } },
        { name: 'deepseek-coder:6.7b', details: { family: 'llama', parameter_size: '7B', context_length: 16384 } },
        { name: 'deepseek-r1:1.5b', details: { family: 'qwen2', parameter_size: '1.8B', context_length: 131072 } },
        { name: 'qwen2.5-coder:7b', details: { family: 'qwen2', parameter_size: '7.6B', context_length: 32768 } },
        { name: 'qwen2.5-coder:3b', details: { family: 'qwen2', parameter_size: '3.1B', context_length: 32768 } },
      ],
      show: {
        'moondream:latest': { capabilities: ['completion', 'vision'] },
        'llama3.2:3b': { capabilities: ['completion', 'tools'] },
        'gpt-oss:20b': { capabilities: ['completion', 'tools', 'thinking'] },
        'deepseek-coder:6.7b': { capabilities: ['completion'] },
        'deepseek-r1:1.5b': { capabilities: ['tools', 'thinking', 'completion'] },
        'qwen2.5-coder:7b': { capabilities: ['completion', 'tools', 'insert'] },
        'qwen2.5-coder:3b': { capabilities: ['completion', 'tools', 'insert'] },
      },
    });

    const found = await discoverOllamaModels(BASE, fetchImpl);

    expect(found.models).toHaveLength(7);
    expect(found.models.every((m) => m.capabilitySource === 'runtime')).toBe(true);
    expect(found.warnings).toEqual([]);
    // The materially-different cases survive intact: one vision model, one
    // tool+insert model, one text-only model that can do neither.
    expect(found.models.find((m) => m.id === 'moondream:latest')!.capabilities).toEqual(['completion', 'vision']);
    expect(found.models.find((m) => m.id === 'qwen2.5-coder:7b')!.capabilities).toEqual(['completion', 'tools', 'insert']);
    expect(found.models.find((m) => m.id === 'deepseek-coder:6.7b')!.capabilities).toEqual(['completion']);
  });
});

describe('robustness of the discovery seam itself', () => {
  it('ignores malformed entries in /api/tags rather than failing the whole call', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [{ name: 'real:1b' }],
      show: { 'real:1b': { capabilities: ['completion'] } },
    });

    const found = await discoverOllamaModels(BASE, fetchImpl);

    expect(found.models.map((m) => m.id)).toEqual(['real:1b']);
  });

  it('preserves the runtime inventory order', async () => {
    const rt: FakeRuntime = {
      tags: [{ name: 'c:1b' }, { name: 'a:1b' }, { name: 'b:1b' }],
      show: { 'c:1b': { capabilities: ['completion'] }, 'a:1b': { capabilities: ['completion'] }, 'b:1b': { capabilities: ['completion'] } },
    };

    const found = await discoverOllamaModels(BASE, fakeOllama(rt).fetchImpl, { concurrency: 3 });

    expect(found.models.map((m) => m.id)).toEqual(['c:1b', 'a:1b', 'b:1b']);
  });

  it('strips a trailing slash so base URLs join correctly', async () => {
    const { fetchImpl, calls } = fakeOllama({
      tags: [{ name: 'x:1b' }],
      show: { 'x:1b': { capabilities: ['completion'] } },
    });

    await discoverOllamaModels(`${BASE}/`, fetchImpl);

    expect(calls.every((c) => !c.includes('//api'))).toBe(true);
  });

  it('describes a single model directly, for callers that already have the tag', async () => {
    const { fetchImpl } = fakeOllama({
      tags: [],
      show: { 'gpt-oss:20b': { capabilities: ['completion', 'tools', 'thinking'] } },
    });

    const model = await describeOllamaModel(
      BASE,
      { name: 'gpt-oss:20b', details: { family: 'gptoss', parameter_size: '20.9B' } },
      fetchImpl
    );

    expect(model.capabilities).toEqual(['completion', 'tools', 'thinking']);
    expect(model.displayName).toBe('GPT OSS 20B');
  });
});

describe('display names are cosmetic', () => {
  it('renders tags readably without touching the id', () => {
    expect(displayNameFor('qwen2.5-coder:7b')).toBe('Qwen2.5 Coder 7B');
    expect(displayNameFor('moondream:latest')).toBe('Moondream');
    expect(displayNameFor('llama3.2:3b')).toBe('Llama3.2 3B');
  });
});