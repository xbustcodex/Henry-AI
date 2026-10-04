/**
 * Henry Computer Agent — real agentic computer control loop.
 *
 * Uses Groq's native tool-use API (not plain chat) so tool calls are
 * structured JSON, not hallucinated text. Executes actual IPC, verifies
 * with screenshots, feeds results back to model for next step.
 */

export interface ComputerAgentOptions {
  userRequest: string;
  provider: string;
  model: string;
  apiKey: string;
  onStep: (step: ComputerStep) => void;
  onDone: (summary: string) => void;
  onError: (err: string) => void;
  maxSteps?: number;
}

export interface ComputerStep {
  type: 'thinking' | 'action' | 'result' | 'screenshot' | 'done';
  label: string;
  detail?: string;
  screenshotUrl?: string;
}

// Tool definitions sent to the model
const COMPUTER_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'run_shell',
      description: 'Run a shell command on the Mac. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_folder',
      description: 'Create a folder at the given path. Use ~ for home directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Full path including folder name, e.g. ~/Desktop/MyFolder' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'open_app',
      description: 'Open an application by name or file path.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'App name (e.g. "Safari", "Finder") or file path' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'take_screenshot',
      description: 'Take a screenshot to see the current state of the screen.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_applescript',
      description: 'Run an AppleScript command to control macOS apps.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'The AppleScript to execute' },
        },
        required: ['script'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'type_text',
      description: 'Type text at the current cursor position.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'task_complete',
      description: 'Call this when the task is fully complete. Provide a brief summary.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What was accomplished' },
        },
        required: ['summary'],
      },
    },
  },
];

async function executeTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; result: string; screenshotUrl?: string }> {
  const api = window.henryAPI;
  if (!api) return { ok: false, result: 'Henry API not available' };

  try {
    switch (toolName) {
      case 'run_shell': {
        const r = await api.computerRunShell({ command: args.command as string });
        const out = (r as any).output || (r as any).stdout || '';
        const err = (r as any).error || (r as any).stderr || '';
        const ok = (r as any).success !== false && (r as any).exitCode !== undefined
          ? (r as any).exitCode === 0
          : !(r as any).error;
        return { ok, result: ok ? (out || 'Command ran successfully') : `Error: ${err || 'Unknown error'}` };
      }
      case 'create_folder': {
        const r = await (api as any).computerNewFolder({ path: args.path as string });
        return { ok: r.ok, result: r.ok ? `Folder created: ${r.path}` : `Failed: ${r.error}` };
      }
      case 'open_app': {
        const r = await api.computerOpenApp(args.name as string);
        return { ok: (r as any).ok !== false, result: `Opened: ${args.name}` };
      }
      case 'take_screenshot': {
        const r = await api.computerScreenshot({});
        if ((r as any).base64) {
          const url = `data:image/png;base64,${(r as any).base64}`;
          return { ok: true, result: 'Screenshot taken', screenshotUrl: url };
        }
        return { ok: false, result: 'Screenshot failed' };
      }
      case 'run_applescript': {
        const r = await api.computerOsascript(args.script as string);
        return { ok: (r as any).ok !== false, result: (r as any).output || 'AppleScript ran' };
      }
      case 'type_text': {
        const r = await api.computerTypeText(args.text as string);
        return { ok: (r as any).ok !== false, result: `Typed: "${args.text}"` };
      }
      default:
        return { ok: false, result: `Unknown tool: ${toolName}` };
    }
  } catch (e) {
    return { ok: false, result: `Tool error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function runComputerAgent(opts: ComputerAgentOptions): Promise<void> {
  const {
    userRequest, provider, model, apiKey,
    onStep, onDone, onError, maxSteps = 20,
  } = opts;

  // Only Groq and OpenAI support function calling reliably
  if (provider !== 'groq' && provider !== 'openai') {
    onError(`Computer control requires Groq or OpenAI. Current provider: ${provider}. Change in Settings.`);
    return;
  }

  const apiUrl = provider === 'groq'
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';

  // Use a model that supports tool use well
  const effectiveModel = provider === 'groq' ? 'llama-3.3-70b-versatile' : model;

  const messages: any[] = [
    {
      role: 'system',
      content: `You are Henry, an AI that controls a Mac computer. When the user asks you to do something, use the available tools to actually do it — don't describe what you would do, just do it. After each action, use take_screenshot to verify it worked. When the task is complete, call task_complete with a brief summary. Be efficient — don't ask for confirmation, just execute.`,
    },
    { role: 'user', content: userRequest },
  ];

  onStep({ type: 'thinking', label: 'Henry is planning…' });

  for (let step = 0; step < maxSteps; step++) {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: effectiveModel,
          messages,
          tools: COMPUTER_TOOLS,
          tool_choice: 'auto',
          max_tokens: 1024,
          temperature: 0.1,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        onError(`API error ${res.status}: ${(err as any).error?.message || 'Unknown'}`);
        return;
      }

      const data = await res.json();
      const choice = data.choices?.[0];
      if (!choice) { onError('No response from model'); return; }

      const msg = choice.message;
      messages.push(msg);

      // If model returned text (thinking), show it
      if (msg.content) {
        onStep({ type: 'thinking', label: 'Henry', detail: msg.content });
      }

      // Check for tool calls
      const toolCalls = msg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls — task complete or model gave up
        onDone(msg.content || 'Task complete');
        return;
      }

      // Execute each tool call
      const toolResults: any[] = [];
      for (const tc of toolCalls) {
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }

        // task_complete is special
        if (name === 'task_complete') {
          onStep({ type: 'done', label: 'Done', detail: args.summary as string });
          onDone(args.summary as string || 'Task complete');
          return;
        }

        onStep({ type: 'action', label: name.replace(/_/g, ' '), detail: JSON.stringify(args) });

        const result = await executeTool(name, args);

        onStep({
          type: result.ok ? 'result' : 'result',
          label: result.ok ? '✓ ' + name : '✗ ' + name,
          detail: result.result,
          screenshotUrl: result.screenshotUrl,
        });

        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.result,
        });
      }

      // Add all tool results back to messages
      messages.push(...toolResults);

    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      return;
    }
  }

  onError('Max steps reached. Task may be incomplete.');
}
