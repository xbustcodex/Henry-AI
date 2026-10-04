/**
 * Agent routing — the seam between an ordinary chat turn and the agent/tool path.
 *
 * The bug: `agentMode` defaulted ON for every install, and the send path attached
 * `tools: [{ name: 'henry-agent' }]` whenever it was on. So an ordinary
 * "what's the weather" on a model that cannot call tools went down the agent
 * route, the model answered in tool-call syntax, and `interceptAndExecute` ran
 * it. A user preference was being used as a capability report.
 *
 * These tests assert the REQUEST SHAPE the send path produces — the thing the
 * main process reads to decide whether to run the ToolRunner — and the gate in
 * front of the action interceptor.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyActionResults,
  applyAgentRoute,
  resolveAgentRouting,
  type AgentRouting,
} from './agentRouting';
import { buildLeanSystemPrompt } from './charter';
import {
  cachedToolCapability,
  clearToolCapabilityCache,
  loadToolCapability,
  rememberDiscoveredCapabilities,
  toolCapabilityFor,
} from './modelCapability';
import type { LocalModelInfo } from '../../electron/ipc/ollamaCapabilities';

const OLLAMA = 'ollama';

/** A `/api/show` answer, as `discoverOllamaModels` would surface it. */
function discovered(
  over: Partial<LocalModelInfo> & { id: string; capabilities: string[] }
): LocalModelInfo {
  return {
    provider: OLLAMA,
    runtime: 'ollama',
    name: over.id,
    displayName: over.id,
    local: true,
    requiresApiKey: false,
    sizeBytes: 0,
    sizeGB: '0',
    contextLength: 8192,
    capabilitySource: 'runtime',
    detailStatus: 'ok',
    loadable: true,
    ...over,
  };
}

/** The payload the send path builds for an ordinary chat turn. */
function ordinaryPayload() {
  return {
    provider: OLLAMA,
    model: 'deepseek-coder:6.7b',
    apiKey: '',
    messages: [{ role: 'user', content: "what's the weather" }],
    temperature: 0.7,
    maxTokens: 1024,
  };
}

function routeFor(over: Partial<Parameters<typeof resolveAgentRouting>[0]> = {}): AgentRouting {
  return resolveAgentRouting({
    agentModePreference: null,
    capability: 'not-tool-capable',
    mode: 'companion',
    ...over,
  });
}

describe('ordinary chat never reaches the agent route', () => {
  it('sends no tools key when the runtime reports the model cannot call tools', () => {
    const routing = routeFor({ capability: 'not-tool-capable' });
    const payload = applyAgentRoute(ordinaryPayload(), routing, 'conv-1');

    expect(payload).not.toHaveProperty('tools');
    expect(payload).not.toHaveProperty('sessionId');
    // The rest of the request is untouched — routing adds, it never rewrites.
    expect(payload).toEqual(ordinaryPayload());
  });

  it('is not a vacuous "no tools anywhere": a tool-capable model does send them', () => {
    const payload = applyAgentRoute(
      ordinaryPayload(),
      routeFor({ capability: 'tool-capable' }),
      'conv-1'
    );

    expect(payload.tools).toEqual([{ name: 'henry-agent' }]);
    expect(payload.sessionId).toBe('conv-1');
  });

  it('an explicitly enabled agent mode also sends tools on a tool-capable model', () => {
    const routing = resolveAgentRouting({
      agentModePreference: true,
      capability: 'tool-capable',
      mode: 'companion',
    });
    expect(routing.agentMode).toBe(true);
    expect(applyAgentRoute(ordinaryPayload(), routing, 'conv-1')).toHaveProperty('tools');
  });

  it('an explicit agent-mode opt-out is honoured for a tool-capable model', () => {
    const routing = resolveAgentRouting({
      agentModePreference: false,
      capability: 'tool-capable',
      mode: 'companion',
    });

    expect(routing.agentMode).toBe(false);
    expect(applyAgentRoute(ordinaryPayload(), routing, 'conv-1')).not.toHaveProperty('tools');
  });

  it('never sends tools for a non-tool-capable model, whatever the user set', () => {
    // A model that cannot emit a tool call cannot be given a tool route. The
    // toggle is a preference; the runtime's answer is the capability.
    const routing = resolveAgentRouting({
      agentModePreference: true,
      capability: 'not-tool-capable',
      mode: 'companion',
    });

    expect(routing.attachTools).toBe(false);
    expect(applyAgentRoute(ordinaryPayload(), routing, 'conv-1')).not.toHaveProperty('tools');
  });
});

describe('capability comes from the runtime, never from the model name', () => {
  it('treats a tool-shaped name with no tools capability as not tool-capable', () => {
    // `qwen2.5-coder:7b` and `llama3.2:3b` are the same shape of name; only one
    // of them can actually call tools on this runtime.
    const model = discovered({
      id: 'qwen2.5-coder:7b',
      displayName: 'Qwen2.5 Coder 7B',
      capabilities: ['completion'],
    });

    expect(toolCapabilityFor(model)).toBe('not-tool-capable');
    expect(
      applyAgentRoute(ordinaryPayload(), routeFor({ capability: toolCapabilityFor(model) }))
    ).not.toHaveProperty('tools');
  });

  it('reads the tools capability the runtime reported, not the other way round', () => {
    expect(toolCapabilityFor(discovered({ id: 'llama3.2:3b', capabilities: ['completion', 'tools'] })))
      .toBe('tool-capable');
    expect(toolCapabilityFor(discovered({ id: 'moondream:latest', capabilities: ['completion', 'vision'] })))
      .toBe('not-tool-capable');
  });

  it('refuses to route on an ASSUMED capability list', () => {
    // `capabilitySource: 'fallback'` is the last-resort list derived from the
    // model name. Routing on it would be the name-based inference by other means.
    const model = discovered({
      id: 'mystery-model:7b',
      capabilities: ['completion', 'tools'],
      capabilitySource: 'fallback',
      detailStatus: 'assumed',
    });

    expect(toolCapabilityFor(model)).toBe('unknown');
  });

  it('answers from the discovered catalogue the app already loads', async () => {
    clearToolCapabilityCache();
    const models = [
      discovered({ id: 'llama3.2:3b', capabilities: ['completion', 'tools'] }),
      discovered({ id: 'deepseek-coder:6.7b', capabilities: ['completion'] }),
    ];
    const api = {
      ollamaModels: vi.fn(async () => ({
        models,
        baseUrl: 'http://127.0.0.1:11434',
        runtime: 'ollama' as const,
      })),
    };
    vi.stubGlobal('window', { henryAPI: api });

    await expect(loadToolCapability(OLLAMA, 'llama3.2:3b', 'http://127.0.0.1:11434'))
      .resolves.toBe('tool-capable');
    // The catalogue is asked once, then cached — the send path reads it per turn.
    await expect(loadToolCapability(OLLAMA, 'deepseek-coder:6.7b', 'http://127.0.0.1:11434'))
      .resolves.toBe('not-tool-capable');
    expect(api.ollamaModels).toHaveBeenCalledTimes(1);
    expect(cachedToolCapability(OLLAMA, 'deepseek-coder:6.7b', 'http://127.0.0.1:11434'))
      .toBe('not-tool-capable');
    // A model the runtime does not hold has no answer to give.
    expect(cachedToolCapability(OLLAMA, 'never-pulled:70b', 'http://127.0.0.1:11434'))
      .toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('does not ask a runtime that has no capability channel', async () => {
    clearToolCapabilityCache();
    const api = { ollamaModels: vi.fn(async () => ({ models: [], baseUrl: '', runtime: 'ollama' as const })) };
    vi.stubGlobal('window', { henryAPI: api });

    await expect(loadToolCapability('anthropic', 'claude-x', 'http://127.0.0.1:11434'))
      .resolves.toBe('unknown');
    expect(api.ollamaModels).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('remembers what discovery reported, without inventing answers for the rest', () => {
    clearToolCapabilityCache();
    rememberDiscoveredCapabilities(
      [discovered({ id: 'llama3.2:3b', capabilities: ['completion', 'tools'] })],
      'http://127.0.0.1:11434'
    );

    expect(cachedToolCapability(OLLAMA, 'llama3.2:3b', 'http://127.0.0.1:11434')).toBe('tool-capable');
    expect(cachedToolCapability(OLLAMA, 'moondream:latest', 'http://127.0.0.1:11434')).toBeUndefined();
  });
});

describe('the action interceptor', () => {
  const commandReply = 'computer:runShell(command="rm -rf /")';

  it('is never reached for an ordinary turn on a non-tool-capable model', async () => {
    const execute = vi.fn(async () => [{ output: 'ran it' }]);
    const routing = routeFor({ capability: 'not-tool-capable' });

    expect(routing.runActionInterceptor).toBe(false);
    const text = await applyActionResults(commandReply, routing, execute);

    expect(execute).not.toHaveBeenCalled();
    expect(text).toBe(commandReply);
  });

  it('still runs when the turn was routed to the agent', async () => {
    const execute = vi.fn(async () => [{ output: 'ran it' }]);
    const routing = routeFor({ capability: 'tool-capable' });

    const text = await applyActionResults(commandReply, routing, execute);

    expect(execute).toHaveBeenCalledWith(commandReply);
    expect(text).toContain('**Execution result:** ran it');
  });

  it('still runs in computer mode — that mode is an explicit request to operate the machine', async () => {
    const execute = vi.fn(async () => [{ output: 'ok' }]);
    const routing = routeFor({ capability: 'not-tool-capable', mode: 'computer' });

    expect(routing.runActionInterceptor).toBe(true);
    await applyActionResults(commandReply, routing, execute);
    expect(execute).toHaveBeenCalled();
  });

  it('keeps the answer when the action fails', async () => {
    const execute = vi.fn(async () => {
      throw new Error('IPC refused');
    });

    await expect(
      applyActionResults('Here is the plan.', routeFor({ capability: 'tool-capable' }), execute)
    ).resolves.toBe('Here is the plan.');
  });
});

describe('the local-model prompt agrees with the router', () => {
  it('teaches computer-action syntax only on a turn allowed to act', () => {
    expect(buildLeanSystemPrompt('companion', { allowComputerActions: true }))
      .toContain('computer:runShell');
    expect(buildLeanSystemPrompt('companion', { allowComputerActions: false }))
      .not.toContain('computer:');
    // Unset is the safe reading: a prompt that cannot act teaches no actions.
    expect(buildLeanSystemPrompt('companion')).not.toContain('computer:');
  });

  it('an ordinary turn on a non-tool-capable model produces a prompt with no syntax to copy', () => {
    const routing = routeFor({ capability: 'not-tool-capable' });
    const prompt = buildLeanSystemPrompt('companion', {
      allowComputerActions: routing.runActionInterceptor,
    });

    expect(prompt).not.toContain('computer:runShell');
    expect(prompt).not.toContain('computer:osascript');
  });
});