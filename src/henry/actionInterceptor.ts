/**
 * Action Interceptor — detects computer action requests in Henry's
 * text responses and executes them via real Electron IPC.
 * 
 * Works by parsing common patterns Henry uses when describing actions,
 * executing the real IPC, and returning structured results.
 */

export interface InterceptedAction {
  type: 'shell' | 'folder' | 'app' | 'applescript' | 'screenshot';
  raw: string;     // the original text that triggered this
  args: Record<string, string>;
}

export interface ActionResult {
  action: InterceptedAction;
  ok: boolean;
  output: string;
  screenshotUrl?: string;
}

// Patterns Henry commonly writes when attempting computer actions
const HOME = typeof window !== 'undefined'
  ? (localStorage.getItem('henry:mac_home') || '~')
  : '~';

function resolvePath(p: string): string {
  return p
    .replace(/^~/, HOME)
    .replace(/\/Users\/yourusername\//g, HOME + '/')
    .replace(/\/Users\/your_username\//g, HOME + '/')
    .replace(/\/Users\/USERNAME\//g, HOME + '/');
}

const ACTION_PATTERNS: Array<{
  regex: RegExp;
  type: InterceptedAction['type'];
  extract: (m: RegExpMatchArray) => Record<string, string>;
}> = [
  // computer:newFolder(path="...", name="...") — combined form
  {
    regex: /computer:newFolder\s*\([^)]*path=["']?([^"',)]+)["']?[^)]*name=["']?([^"',)]+)["']?/i,
    type: 'folder',
    extract: (m) => ({ path: resolvePath(m[1].trim().replace(/\/$/, '') + '/' + m[2].trim()) }),
  },
  // computer:newFolder(path="~/Desktop/test") — path only
  {
    regex: /computer:newFolder\s*\([^)]*path=["']?([^"',)]+)["']?/i,
    type: 'folder',
    extract: (m) => ({ path: resolvePath(m[1].trim()) }),
  },
  // computer:newFolder path="/..." name="..." — space separated
  {
    regex: /computer:newFolder\s+path=["']?([^"'\s]+)["']?\s+name=["']?([^"'\s]+)["']?/i,
    type: 'folder',
    extract: (m) => ({ path: resolvePath(m[1].trim().replace(/\/$/, '') + '/' + m[2].trim()) }),
  },
  // computer:runShell(command="mkdir ...")
  {
    regex: /computer:runShell\s*\([^)]*command=["']([^"']+)["']/i,
    type: 'shell',
    extract: (m) => ({ command: m[1].trim() }),
  },
  // `computer:runShell(mkdir ~/Desktop/test)`
  {
    regex: /computer:runShell\s*\(([^)]+)\)/i,
    type: 'shell',
    extract: (m) => ({ command: m[1].replace(/command=["']?/i, '').replace(/["']$/, '').trim() }),
  },
  // computer:openApp(name="Safari")
  {
    regex: /computer:openApp\s*\([^)]*["']?([^"',)]+)["']?\)/i,
    type: 'app',
    extract: (m) => ({ name: m[1].trim() }),
  },
  // computer:screenshot()
  {
    regex: /computer:screenshot\s*\(\s*\)/i,
    type: 'screenshot',
    extract: () => ({}),
  },
  // computer:osascript(script="...")
  {
    regex: /computer:osascript\s*\([^)]*["']([^"']+)["']/i,
    type: 'applescript',
    extract: (m) => ({ script: m[1].trim() }),
  },
  // computer:typeText(text="...")
  {
    regex: /computer:typeText\s*\([^)]*text=["']([^"']+)["']/i,
    type: 'shell' as const,
    extract: (m: RegExpMatchArray) => ({
      command: `osascript -e 'tell application "System Events" to keystroke "${m[1].trim().replace(/"/g, '\\"')}"'`
    }),
  },
  // computer:typeText("...") or computer:typeText('...')
  {
    regex: /computer:typeText\s*\(\s*["']([^"']+)["']\s*\)/i,
    type: 'shell' as const,
    extract: (m: RegExpMatchArray) => ({
      command: `osascript -e 'tell application "System Events" to keystroke "${m[1].trim().replace(/"/g, '\\"')}"'`
    }),
  },
  // computer:pressEnter() or computer:pressReturn()
  {
    regex: /computer:press(?:Enter|Return)\s*\(\s*\)/i,
    type: 'shell' as const,
    extract: () => ({
      command: `osascript -e 'tell application "System Events" to key code 36'`
    }),
  },
  // computer:activateApp("Safari") or computer:switchTo("Chrome")
  {
    regex: /computer:(?:activateApp|switchTo|focusApp)\s*\(\s*["']?([^"',)]+)["']?\s*\)/i,
    type: 'app' as const,
    extract: (m: RegExpMatchArray) => ({ name: m[1].trim() }),
  },
  // computer:keyPress(key="return") or computer:keyPress("escape")
  {
    regex: /computer:keyPress\s*\([^)]*["']?([^"',)]+)["']?\)/i,
    type: 'shell' as const,
    extract: (m: RegExpMatchArray) => {
      const key = m[1].trim().toLowerCase();
      const keyCodes: Record<string, number> = {
        'return': 36, 'enter': 36, 'escape': 53, 'tab': 48,
        'space': 49, 'delete': 51, 'backspace': 51,
      };
      const code = keyCodes[key];
      if (code) return { command: `osascript -e 'tell application "System Events" to key code ${code}'` };
      return { command: `osascript -e 'tell application "System Events" to keystroke "${key}"'` };
    },
  },
  // Bare shell patterns: mkdir ~/Desktop/foo or open -a Safari
  {
    regex: /`(mkdir\s+[^`\n]+)`/,
    type: 'shell',
    extract: (m) => ({ command: m[1].trim() }),
  },
  {
    regex: /`(open\s+[^`\n]+)`/,
    type: 'shell',
    extract: (m) => ({ command: m[1].trim() }),
  },
  {
    regex: /```(?:bash|shell|zsh)?\n((?:mkdir|open|cp|mv|rm|touch|echo|defaults|osascript)[^\n]+)\n```/,
    type: 'shell',
    extract: (m) => ({ command: m[1].trim() }),
  },
];

export function detectActions(text: string): InterceptedAction[] {
  const actions: InterceptedAction[] = [];
  for (const pattern of ACTION_PATTERNS) {
    const match = text.match(pattern.regex);
    if (match) {
      actions.push({
        type: pattern.type,
        raw: match[0],
        args: pattern.extract(match),
      });
    }
  }
  return actions;
}

export async function executeAction(action: InterceptedAction): Promise<ActionResult> {
  const api = window.henryAPI;
  if (!api) {
    return { action, ok: false, output: 'Henry IPC not available — restart the app.' };
  }

  try {
    switch (action.type) {
      case 'folder': {
        const rawPath = action.args.path || '';
        // Final safety: resolve any remaining placeholders before calling IPC
        const home = localStorage.getItem('henry:mac_home') || '~';
        const resolvedFolderPath = rawPath
          .replace(/^~/, home)
          .replace(/\/Users\/yourusername\//g, home + '/')
          .replace(/\/Users\/your_username\//g, home + '/');
        const r = await (api as any).computerNewFolder({ path: resolvedFolderPath }) as any;
        return {
          action, ok: r.ok,
          output: r.ok
            ? `✓ Folder created: ${r.path}`
            : `✗ Could not create folder: ${r.error || 'Unknown error'}`,
        };
      }
      case 'shell': {
        const r = await api.computerRunShell({ command: action.args.command }) as any;
        const ok = r.success !== false && r.exitCode === 0;
        const out = r.output || r.stdout || '';
        const err = r.error || r.stderr || '';
        return {
          action, ok,
          output: ok
            ? (out ? `✓ ${out.trim()}` : '✓ Command completed')
            : `✗ Error: ${err || 'Exit code ' + r.exitCode}`,
        };
      }
      case 'app': {
        const r = await api.computerOpenApp(action.args.name) as any;
        return {
          action, ok: r.ok !== false,
          output: r.ok !== false ? `✓ Opened ${action.args.name}` : `✗ Could not open ${action.args.name}`,
        };
      }
      case 'screenshot': {
        const r = await api.computerScreenshot({}) as any;
        if (r.base64) {
          return {
            action, ok: true,
            output: '✓ Screenshot taken',
            screenshotUrl: `data:image/png;base64,${r.base64}`,
          };
        }
        return { action, ok: false, output: '✗ Screenshot failed — check Screen Recording permission in System Settings' };
      }
      case 'applescript': {
        const r = await api.computerOsascript(action.args.script) as any;
        return {
          action, ok: r.ok !== false,
          output: r.ok !== false
            ? `✓ ${r.output || 'AppleScript completed'}`
            : `✗ AppleScript error: ${r.error || 'Unknown'}`,
        };
      }
      default:
        return { action, ok: false, output: 'Unknown action type' };
    }
  } catch (e) {
    return { action, ok: false, output: `✗ ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function interceptAndExecute(text: string): Promise<ActionResult[]> {
  const actions = detectActions(text);
  if (actions.length === 0) return [];
  const results: ActionResult[] = [];
  for (const action of actions) {
    const result = await executeAction(action);
    results.push(result);
  }
  return results;
}
