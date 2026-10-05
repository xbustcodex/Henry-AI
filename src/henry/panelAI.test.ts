/**
 * The renderer must not be able to name a provider.
 *
 * Nine features across six panels used to `fetch` a Cloudflare worker URL from
 * the renderer with a hardcoded model. That put financial summaries, task
 * triage, goal coaching, weekly reviews, capture reviews, the daily plan,
 * "Henry's word" and "focus now" outside every control Henry has over an AI
 * call: no provider classification, no credential policy, no security layer, no
 * retry, no cost row.
 *
 * Two things are asserted here, and they are different kinds of claim:
 *
 *   1. **No renderer source calls that host.** A source scan over `src/`, so a
 *      panel cannot reintroduce the bypass by editing one URL literal. This is
 *      the guard against regression, and it fails loudly on any new call site.
 *
 *   2. **Each migrated feature reaches the governed path, on an unchanged
 *      provider and model.** Every feature is driven for real through
 *      `runPanelAI` with the install's configured engine, and the payload
 *      handed to `ai:send` is asserted: the provider and model the user chose,
 *      plus a `logPurpose` so the cost lands in `cost_log`.
 *
 * The provider/model assertion is the load-bearing one. "It still answers" would
 * pass if a panel quietly rerouted to whatever provider happened to be
 * available; "it answers from exactly the configured engine, and names that
 * engine in the cost log" cannot.
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runPanelAI, panelAIErrorMessage, type PanelAIPurpose, type PanelAIRequest } from './panelAI';
import { NoBackendAvailableError } from './henryAI';

/**
 * The host that must not be reachable from renderer code. Written out rather
 * than imported so the assertion is about the literal, not about a constant
 * that a future edit could move.
 */
const PROXY_HOST = 'henry-proxy.henryai.workers.dev';

const SRC_ROOT = join(__dirname, '..');

function rendererSources(dir: string = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...rendererSources(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Every AI feature that used to call the proxy, with the accounting label it now
 * carries. Each is exercised for real below — the list is the contract, so a
 * feature cannot be dropped from the migration without failing here.
 */
const MIGRATED_FEATURES: Array<{ purpose: PanelAIPurpose; prompt: string }> = [
  { purpose: 'today.henrys-word', prompt: 'Give Sam one short encouraging thought for this morning.' },
  { purpose: 'today.focus-now', prompt: 'Sam is asking what to focus on right now.' },
  { purpose: 'today.daily-plan', prompt: 'Create a focused daily plan for Sam.' },
  { purpose: 'tasks.triage', prompt: 'Triage these open tasks: ship invoice, renew domain.' },
  { purpose: 'goals.coach', prompt: 'Give a coaching response to the goal "double revenue".' },
  { purpose: 'weekly.review', prompt: 'Write a brief weekly review for Sam.' },
  { purpose: 'captures.review', prompt: 'Review these captures from the day.' },
  { purpose: 'finance.pl-summary', prompt: "Sam's finances for October: Income $5000, Expenses $4200." },
  { purpose: 'finance.insight', prompt: 'Sam spent $4200 this month with income of $5000.' },
];

const SETTINGS_KEY = 'henry:settings';
const PROVIDERS_KEY = 'henry:providers';

const OPENAI_ROW = {
  id: 'openai',
  name: 'OpenAI',
  api_key: 'sk-panel-test-key-1234567890',
  enabled: true,
  models: ['gpt-4o-mini'],
};

const OLLAMA_ROW = {
  id: 'ollama',
  name: 'Ollama',
  api_key: '',
  enabled: true,
  models: ['llama3.2:3b'],
};

function seedInstall(settings: Record<string, string>, providers: unknown[]): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers));
  (window as unknown as { henryAPI: unknown }).henryAPI = {
    getSettings: async () => settings,
    getProviders: async () => providers,
  };
}

/** The payload the transport received, as an open record for assertions. */
type SentPayload = Record<string, unknown>;

/** Records what reached `ai:send`, and answers like the transport does. */
function stubSendMessage(reply = 'an answer') {
  const calls: SentPayload[] = [];
  const api = (window as unknown as { henryAPI: { sendMessage?: unknown } }).henryAPI;
  api.sendMessage = async (params: SentPayload) => {
    calls.push(params);
    return { content: reply, cost: 0.000123, usage: { input: 100, output: 20 } };
  };
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as { henryAPI?: unknown }).henryAPI;
  seedInstall({}, []);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderer source never calls the hosted proxy', () => {
  const files = rendererSources();

  it('finds renderer source files to scan', () => {
    // Guards the scan itself: an empty file list would make the assertion below
    // vacuously true.
    expect(files.length).toBeGreaterThan(100);
  });

  it('contains no reference to the proxy host', () => {
    const offenders = files.filter((f) => readFileSync(f, 'utf-8').includes(PROXY_HOST));
    expect(
      offenders.map((f) => f.replace(SRC_ROOT + '/', '')),
      'a renderer file references the hosted proxy — route the call through panelAI/ai:send',
    ).toEqual([]);
  });

  it('contains no panel that hand-rolls a chat completion', () => {
    // The nine call sites this ticket removed all lived in `src/components/`, so
    // that is where the guard applies: a panel must not speak the OpenAI
    // chat-completions dialect — or an Ollama `/api/chat` — to an endpoint of its
    // own choosing. Every such turn belongs in `ai:send`, where it is classified,
    // validated, retried and priced.
    //
    // Deliberately scoped this narrowly, for two honest reasons.
    //
    //   - `src/henry/` still contains provider *adapters* (henryAI.ts,
    //     ollamaProviderAdapter.ts, providers/cerebras.ts) and the web mock
    //     (webMock.ts). Reaching a provider from an adapter is the job of an
    //     adapter; the defect was a *panel* choosing a provider, not a transport
    //     existing. Widening this to them would assert a refactor that has not
    //     happened and is not what was fixed here.
    //   - Image, video, speech and geocoding calls post to their own APIs with
    //     their own credentials — a different concern from the chat path.
    //     Henry's loopback services (127.0.0.1:4242 sync bridge, :11434 Ollama)
    //     are local to the machine, not egress.
    const panelFiles = files.filter((f) => f.includes(`${join('src', 'components')}/`));
    const offenders = panelFiles.filter((f) => {
      const src = readFileSync(f, 'utf-8');
      const speaksChat = /(chat\/completions|\/v1\/chat|\/api\/chat)/.test(src);
      return speaksChat && /\bfetch\(/.test(src);
    });
    expect(
      offenders.map((f) => f.replace(SRC_ROOT + '/', '')),
      'a renderer file both names a chat endpoint and calls fetch — it may be hand-rolling an AI turn',
    ).toEqual([]);
  });
});

describe('each migrated feature reaches the governed path', () => {
  beforeEach(() => {
    seedInstall(
      { companion_provider: 'openai', companion_model: 'gpt-4o-mini' },
      [OPENAI_ROW],
    );
  });

  it('covers every feature that used to call the proxy', () => {
    // Nine of the ten call sites are `runPanelAI` features exercised below. The
    // tenth, `today.briefing`, streams and is asserted separately — so a feature
    // cannot be dropped from the migration without this list going stale.
    expect(MIGRATED_FEATURES).toHaveLength(9);
    const purposes = MIGRATED_FEATURES.map((f) => f.purpose);
    expect(purposes.length).toBe(new Set(purposes).size);
  });

  for (const { purpose, prompt } of MIGRATED_FEATURES) {
    it(`${purpose} dispatches through ai:send on the configured engine`, async () => {
      const calls = stubSendMessage();

      const res = await runPanelAI({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200,
        purpose,
      });

      expect(calls).toHaveLength(1);
      const sent = calls[0];

      // The provider and model are the ones the user configured — not a
      // hardcoded one, and not whatever happened to have a key on the machine.
      expect(sent.provider).toBe('openai');
      expect(sent.model).toBe('gpt-4o-mini');
      expect(sent.apiKey).toBe(OPENAI_ROW.api_key);

      // Named so the call is attributable in `cost_log`.
      expect(sent.logPurpose).toBe(purpose);

      expect(sent.messages).toEqual([{ role: 'user', content: prompt }]);
      expect(sent.maxTokens).toBe(200);

      // The answer reaches the caller unchanged.
      expect(res.content).toBe('an answer');
    });
  }

  it('routes a keyless engine through the same path, with its base URL', async () => {
    seedInstall({ companion_provider: 'ollama', companion_model: 'llama3.2:3b' }, [OLLAMA_ROW]);
    const calls = stubSendMessage();

    await runPanelAI({
      messages: [{ role: 'user', content: 'summarise the week' }],
      maxTokens: 100,
      purpose: 'weekly.review',
    });

    expect(calls[0].provider).toBe('ollama');
    expect(calls[0].model).toBe('llama3.2:3b');
    // Ollama legitimately carries no credential; the panel must not treat that
    // as "no engine" and reroute.
    expect(calls[0].apiKey).toBe('');
    expect(calls[0].apiUrl).toBe('http://localhost:11434');
  });

  it('reports the cost the transport priced', async () => {
    stubSendMessage();
    const res = await runPanelAI({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      purpose: 'finance.insight',
    });
    expect(res.cost).toBe(0.000123);
    expect(res.provider).toBe('openai');
    expect(res.model).toBe('gpt-4o-mini');
  });
});

describe('provider and model selection is unchanged, never substituted', () => {
  it('dispatches nothing when the user has selected no engine', async () => {
    seedInstall({}, [OPENAI_ROW]);
    const calls = stubSendMessage();

    await expect(
      runPanelAI({
        messages: [{ role: 'user', content: 'give me a P&L summary' }],
        maxTokens: 250,
        purpose: 'finance.pl-summary',
      }),
    ).rejects.toBeInstanceOf(NoBackendAvailableError);

    // A key sitting on the machine is not a selection. Nothing is sent.
    expect(calls).toHaveLength(0);
  });

  it('dispatches nothing when the selected provider has no credential', async () => {
    seedInstall(
      { companion_provider: 'anthropic', companion_model: 'claude-3-5-haiku-20241022' },
      [OPENAI_ROW, { id: 'anthropic', name: 'Anthropic', api_key: '', enabled: true }],
    );
    const calls = stubSendMessage();

    await expect(
      runPanelAI({
        messages: [{ role: 'user', content: 'coach me on this goal' }],
        maxTokens: 300,
        purpose: 'goals.coach',
      }),
    ).rejects.toBeInstanceOf(NoBackendAvailableError);

    // It must not answer from OpenAI instead.
    expect(calls).toHaveLength(0);
  });

  it('refuses a retired provider instead of routing to a live one', async () => {
    seedInstall(
      { companion_provider: 'groq', companion_model: 'llama-3.3-70b-versatile' },
      [OPENAI_ROW],
    );
    const calls = stubSendMessage();

    await expect(
      runPanelAI({
        messages: [{ role: 'user', content: 'triage my tasks' }],
        maxTokens: 300,
        purpose: 'tasks.triage',
      }),
    ).rejects.toBeInstanceOf(NoBackendAvailableError);

    expect(calls).toHaveLength(0);
  });

  it('refuses a model the selected provider does not offer', async () => {
    seedInstall(
      { companion_provider: 'openai', companion_model: 'llama-3.3-70b-versatile' },
      [OPENAI_ROW],
    );
    const calls = stubSendMessage();

    await expect(
      runPanelAI({
        messages: [{ role: 'user', content: 'what should I focus on' }],
        maxTokens: 120,
        purpose: 'today.focus-now',
      }),
    ).rejects.toBeInstanceOf(NoBackendAvailableError);

    expect(calls).toHaveLength(0);
  });

  it('takes no provider or model from the caller', async () => {
    seedInstall({ companion_provider: 'openai', companion_model: 'gpt-4o-mini' }, [OPENAI_ROW]);
    const calls = stubSendMessage();

    // A panel cannot name a provider even by mistake. The type has no such
    // field, so this literal is a compile error — asserted here so the guarantee
    // is not just "the compiler happened to notice".
    const smuggled = {
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'review these captures' }],
      maxTokens: 350,
      purpose: 'captures.review',
    };
    // @ts-expect-error provider/model are not part of PanelAIRequest by design.
    const rejected: PanelAIRequest = smuggled;

    await runPanelAI(rejected);

    // What the transport received is the configured engine, whatever the caller
    // put in the object.
    expect(calls[0].provider).toBe('openai');
    expect(calls[0].model).toBe('gpt-4o-mini');
  });
});

describe('the user sees the truth when a panel turn fails', () => {
  it('shows the setup path, not a false "could not reach AI"', async () => {
    seedInstall({}, []);
    const err = new NoBackendAvailableError();

    const msg = panelAIErrorMessage(err);
    // "Could not reach Henry AI" would be untrue: nothing was sent.
    expect(msg).not.toBe('Could not reach Henry AI.');
    expect(msg).toContain('Settings');
  });

  it('surfaces the transport error for a real failure', async () => {
    seedInstall({ companion_provider: 'openai', companion_model: 'gpt-4o-mini' }, [OPENAI_ROW]);
    const api = (window as unknown as { henryAPI: { sendMessage?: unknown } }).henryAPI;
    api.sendMessage = async () => {
      throw new Error('OpenAI returned an error (503)');
    };

    await expect(
      runPanelAI({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        purpose: 'today.henrys-word',
      }),
    ).rejects.toThrow('OpenAI returned an error (503)');

    expect(panelAIErrorMessage(new Error('OpenAI returned an error (503)'))).toBe(
      'OpenAI returned an error (503)',
    );
  });
});