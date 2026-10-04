import { useState, useRef, useEffect, useCallback } from 'react';

// ── ANSI Color Renderer ──────────────────────────────────────────────────────
const ANSI_FG: Record<number, string> = {
  30: '#4d4d4d', 31: '#ff5555', 32: '#50fa7b', 33: '#f1fa8c',
  34: '#bd93f9', 35: '#ff79c6', 36: '#8be9fd', 37: '#f8f8f2',
  90: '#6272a4', 91: '#ff6e6e', 92: '#69ff94', 93: '#ffffa5',
  94: '#d6acff', 95: '#ff92df', 96: '#a4ffff', 97: '#ffffff',
};

interface AnsiSpan { text: string; color?: string; bold?: boolean; dim?: boolean }

function parseAnsi(raw: string): AnsiSpan[] {
  const segments: AnsiSpan[] = [];
  const RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;]*[A-HJKSTf]|\r/g;
  let cur: Omit<AnsiSpan, 'text'> = {};
  let lastIdx = 0;

  for (const m of raw.matchAll(RE)) {
    if (m.index! > lastIdx) segments.push({ ...cur, text: raw.slice(lastIdx, m.index) });
    lastIdx = m.index! + m[0].length;

    if (!m[0].endsWith('m')) continue;
    const codes = m[1].split(';').map(Number).filter((n) => !isNaN(n));
    for (const c of codes) {
      if (c === 0) cur = {};
      else if (c === 1) cur.bold = true;
      else if (c === 2) cur.dim = true;
      else if (ANSI_FG[c]) cur.color = ANSI_FG[c];
    }
  }
  if (lastIdx < raw.length) segments.push({ ...cur, text: raw.slice(lastIdx) });
  return segments.filter((s) => s.text);
}

function AnsiLine({ text }: { text: string }) {
  const spans = parseAnsi(text);
  return (
    <span>
      {spans.map((s, i) => (
        <span
          key={i}
          style={{
            color: s.color,
            fontWeight: s.bold ? 700 : undefined,
            opacity: s.dim ? 0.6 : undefined,
          }}
        >
          {s.text}
        </span>
      ))}
    </span>
  );
}

// ── Types ────────────────────────────────────────────────────────────────────
interface OutputLine {
  id: string;
  type: 'stdin' | 'stdout' | 'stderr' | 'info' | 'henry';
  text: string;
  timestamp: number;
  exitCode?: number;
  durationMs?: number;
}

interface Session {
  id: string;
  label: string;
  output: OutputLine[];
  history: string[];
  historyIdx: number;
  cwd: string;
}

interface HenryResponse {
  id: string;
  content: string;
  isStreaming: boolean;
}

function newSession(n: number): Session {
  return {
    id: crypto.randomUUID(),
    label: `Shell ${n}`,
    output: [],
    history: [],
    historyIdx: -1,
    cwd: '~',
  };
}

// ── Main Component ───────────────────────────────────────────────────────────
export default function TerminalView() {
  const [sessions, setSessions] = useState<Session[]>([newSession(1)]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    const s = newSession(1);
    return s.id; // will be overridden on mount
  });
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [showHenry, setShowHenry] = useState(true);
  const [henryInput, setHenryInput] = useState('');
  const [henryRunning, setHenryRunning] = useState(false);
  const [henryResponses, setHenryResponses] = useState<HenryResponse[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [autoAnalyze, setAutoAnalyze] = useState(true);

  const outputRef = useRef<HTMLDivElement>(null);
  const henryRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const henryInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<any>(null);

  // Initialize with welcome message
  useEffect(() => {
    setSessions((prev) => {
      const s = prev[0];
      return [{
        ...s,
        output: [
          { id: crypto.randomUUID(), type: 'info', text: 'Henry Terminal — commands run in your workspace via the desktop app.', timestamp: Date.now() },
          { id: crypto.randomUUID(), type: 'info', text: 'Henry is watching. Ask him anything about your output.', timestamp: Date.now() },
          { id: crypto.randomUUID(), type: 'info', text: '', timestamp: Date.now() },
        ],
      }];
    });
    setSessions((prev) => { setActiveSessionId(prev[0].id); return prev; });
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];

  useEffect(() => {
    outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
  }, [activeSession?.output]);

  useEffect(() => {
    henryRef.current?.scrollTo(0, henryRef.current.scrollHeight);
  }, [henryResponses]);

  const updateSession = useCallback((id: string, patch: Partial<Session>) => {
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, ...patch } : s));
  }, []);

  const addLine = useCallback((sessionId: string, line: Omit<OutputLine, 'id'>) => {
    setSessions((prev) => prev.map((s) =>
      s.id === sessionId
        ? { ...s, output: [...s.output, { ...line, id: crypto.randomUUID() }] }
        : s
    ));
  }, []);

  function addSession() {
    if (sessions.length >= 4) return;
    const s = newSession(sessions.length + 1);
    s.output = [{ id: crypto.randomUUID(), type: 'info', text: `New session — ${s.label}`, timestamp: Date.now() }];
    setSessions((prev) => [...prev, s]);
    setActiveSessionId(s.id);
  }

  function closeSession(id: string) {
    if (sessions.length === 1) return;
    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);
    if (activeSessionId === id) setActiveSessionId(remaining[remaining.length - 1].id);
  }

  async function executeCommand(cmd: string) {
    if (!cmd.trim() || running) return;
    const sid = activeSessionId;
    const t0 = Date.now();

    updateSession(sid, {
      history: [cmd, ...(activeSession?.history ?? []).slice(0, 50)],
      historyIdx: -1,
    });

    addLine(sid, { type: 'stdin', text: `${activeSession?.cwd ?? '~'} $ ${cmd}`, timestamp: t0 });
    setInput('');
    setRunning(true);

    // Track cd commands for cwd display
    const cdMatch = cmd.match(/^cd\s+(.+)$/);

    try {
      const result = await window.henryAPI.execTerminal({ command: cmd, timeout: 60000 });
      const dur = Date.now() - t0;

      if (result.stdout) {
        for (const line of result.stdout.split('\n')) {
          if (line || result.stdout.endsWith('\n')) {
            addLine(sid, { type: 'stdout', text: line, timestamp: Date.now() });
          }
        }
      }
      if (result.stderr) {
        for (const line of result.stderr.split('\n')) {
          if (line) addLine(sid, { type: 'stderr', text: line, timestamp: Date.now() });
        }
        // Auto-analyze errors
        if (autoAnalyze && result.stderr.trim()) {
          void analyzeError(cmd, result.stderr, result.stdout);
        }
      }

      addLine(sid, {
        type: 'info',
        text: ``,
        timestamp: Date.now(),
        exitCode: result.exitCode ?? 0,
        durationMs: dur,
      });

      if (cdMatch && result.success) {
        updateSession(sid, { cwd: cdMatch[1].replace(/^~/, '~') });
      }
    } catch (err: any) {
      addLine(sid, { type: 'stderr', text: `Error: ${err.message}`, timestamp: Date.now() });
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  }

  async function analyzeError(cmd: string, stderr: string, stdout: string) {
    const lastN = (activeSession?.output ?? []).slice(-20).map((l) => l.text).join('\n');
    const prompt = `I ran \`${cmd}\` in my terminal and got this error:\n\`\`\`\n${stderr.slice(0, 800)}\n\`\`\`\n${stdout ? `stdout: ${stdout.slice(0, 400)}\n` : ''}Recent terminal context:\n${lastN.slice(0, 500)}\n\nQuickly diagnose what went wrong and suggest how to fix it.`;
    await askHenry(prompt, true);
  }

  async function askHenry(question: string, isAuto = false) {
    if (henryRunning) return;

    const q = question || henryInput.trim();
    if (!q) return;

    if (!isAuto) setHenryInput('');

    const context = (activeSession?.output ?? [])
      .slice(-30)
      .filter((l) => l.type !== 'info' || l.text)
      .map((l) => l.text)
      .join('\n');

    const fullPrompt = isAuto
      ? q
      : `Terminal context (last 30 lines):\n\`\`\`\n${context.slice(0, 1000)}\n\`\`\`\n\nQuestion: ${q}`;

    const rid = crypto.randomUUID();
    setHenryResponses((prev) => [...prev, { id: rid, content: isAuto ? '🔍 Analyzing error...' : '', isStreaming: true }]);
    setHenryRunning(true);

    try {
      const providers = await window.henryAPI.getProviders();
      const { useStore } = await import('../../store');
      const s = useStore.getState().settings;
      const provider = providers.find((p: any) => p.id === s.companion_provider);
      if (!provider || !s.companion_model) {
        setHenryResponses((prev) => prev.map((r) =>
          r.id === rid ? { ...r, content: '⚠️ No model configured. Set up an engine in Settings.', isStreaming: false } : r
        ));
        return;
      }

      const stream = window.henryAPI.streamMessage({
        provider: s.companion_provider,
        model: s.companion_model,
        apiKey: provider.api_key || provider.apiKey || '',
        messages: [
          { role: 'system', content: 'You are Henry, a personal AI. The user is asking about their terminal. Be concise, direct, and give actionable answers. Format code with backticks. Keep responses under 300 words unless asked for more.' },
          { role: 'user', content: fullPrompt },
        ],
        temperature: 0.4,
      });

      streamRef.current = stream;
      let full = '';

      stream.onChunk((chunk: string) => {
        full += chunk;
        setHenryResponses((prev) => prev.map((r) =>
          r.id === rid ? { ...r, content: full } : r
        ));
      });

      stream.onDone(() => {
        setHenryResponses((prev) => prev.map((r) =>
          r.id === rid ? { ...r, isStreaming: false } : r
        ));
        setHenryRunning(false);
      });

      stream.onError((err: string) => {
        setHenryResponses((prev) => prev.map((r) =>
          r.id === rid ? { ...r, content: `Error: ${err}`, isStreaming: false } : r
        ));
        setHenryRunning(false);
      });
    } catch (err: any) {
      setHenryResponses((prev) => prev.map((r) =>
        r.id === rid ? { ...r, content: `Error: ${err.message}`, isStreaming: false } : r
      ));
      setHenryRunning(false);
    }
  }

  function extractSuggestedCommands(content: string): string[] {
    const cmds: string[] = [];
    const RE = /```(?:bash|sh|shell|zsh)?\s*\n?([\s\S]+?)```/g;
    for (const m of content.matchAll(RE)) {
      const lines = m[1].trim().split('\n').filter((l) => l.trim() && !l.startsWith('#'));
      cmds.push(...lines.slice(0, 3));
    }
    // Also single-backtick commands that start with common verbs
    const singleRE = /`((?:npm|pip|pip3|python3?|node|git|cd|ls|cat|echo|brew|yarn|cargo|go) [^`]{1,80})`/g;
    for (const m of content.matchAll(singleRE)) {
      if (!cmds.includes(m[1])) cmds.push(m[1]);
    }
    return cmds.slice(0, 5);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !running) {
      executeCommand(input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const hist = activeSession?.history ?? [];
      const next = Math.min((activeSession?.historyIdx ?? -1) + 1, hist.length - 1);
      updateSession(activeSessionId, { historyIdx: next });
      if (hist[next]) setInput(hist[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const hist = activeSession?.history ?? [];
      const next = Math.max((activeSession?.historyIdx ?? -1) - 1, -1);
      updateSession(activeSessionId, { historyIdx: next });
      setInput(next >= 0 ? hist[next] : '');
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      updateSession(activeSessionId, { output: [] });
    } else if (e.key === 'c' && e.ctrlKey && running) {
      e.preventDefault();
    }
  }

  const filteredOutput = searchQuery
    ? (activeSession?.output ?? []).filter((l) =>
        l.text.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : (activeSession?.output ?? []);

  const isWeb = typeof window.henryAPI.execTerminal === 'function';

  return (
    <div className="h-full flex flex-col bg-[#0a0a10] overflow-hidden">
      {/* Tab bar */}
      <div className="shrink-0 flex items-center gap-0 bg-[#0d0d16] border-b border-[#1e1e2e]">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`group flex items-center gap-2 px-4 py-2.5 cursor-pointer border-r border-[#1e1e2e] text-xs transition-all ${
              s.id === activeSessionId
                ? 'bg-[#13131f] text-[#cdd6f4] border-b-2 border-b-[#bd93f9]'
                : 'text-[#6272a4] hover:text-[#cdd6f4] hover:bg-[#12121c]'
            }`}
            onClick={() => setActiveSessionId(s.id)}
          >
            <span className="font-mono">▸</span>
            <span>{s.label}</span>
            {sessions.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}
                className="opacity-0 group-hover:opacity-100 ml-1 text-[#6272a4] hover:text-[#ff5555] transition-all leading-none"
              >
                ×
              </button>
            )}
          </div>
        ))}
        {sessions.length < 4 && (
          <button
            onClick={addSession}
            className="px-3 py-2.5 text-[#6272a4] hover:text-[#cdd6f4] text-xs transition-colors"
            title="New session"
          >
            +
          </button>
        )}
        <div className="flex-1" />
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-3">
          {searching ? (
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setSearching(false); setSearchQuery(''); } }}
              placeholder="Search output..."
              className="bg-[#1e1e2e] text-[#cdd6f4] text-xs px-2 py-1 rounded border border-[#313244] outline-none w-36"
            />
          ) : (
            <button
              onClick={() => setSearching(true)}
              className="text-[10px] text-[#6272a4] hover:text-[#cdd6f4] px-2 py-1 rounded hover:bg-[#1e1e2e] transition-all"
              title="Search output (⌘F)"
            >
              🔍
            </button>
          )}
          <button
            onClick={() => updateSession(activeSessionId, { output: [] })}
            className="text-[10px] text-[#6272a4] hover:text-[#cdd6f4] px-2 py-1 rounded hover:bg-[#1e1e2e] transition-all"
            title="Clear (Ctrl+L)"
          >
            Clear
          </button>
          <button
            onClick={() => setAutoAnalyze((v) => !v)}
            className={`text-[10px] px-2 py-1 rounded transition-all ${autoAnalyze ? 'text-[#50fa7b] bg-[#50fa7b]/10' : 'text-[#6272a4] hover:text-[#cdd6f4] hover:bg-[#1e1e2e]'}`}
            title="Auto-analyze errors"
          >
            ⚡ Auto
          </button>
          <button
            onClick={() => setShowHenry((v) => !v)}
            className={`text-[10px] px-2 py-1 rounded transition-all ${showHenry ? 'text-[#bd93f9] bg-[#bd93f9]/10' : 'text-[#6272a4] hover:text-[#cdd6f4] hover:bg-[#1e1e2e]'}`}
          >
            🧠 Henry
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Terminal pane */}
        <div className={`flex flex-col overflow-hidden ${showHenry ? 'flex-[3]' : 'flex-1'} border-r border-[#1e1e2e]`}>
          {/* Output */}
          <div
            ref={outputRef}
            className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-[1.6] cursor-text"
            onClick={() => inputRef.current?.focus()}
          >
            {filteredOutput.map((line) => (
              <div key={line.id} className="flex items-start gap-0 group">
                <span
                  className={`whitespace-pre-wrap break-all flex-1 ${
                    line.type === 'stdin'
                      ? 'text-[#bd93f9]'
                      : line.type === 'stderr'
                      ? 'text-[#ff5555]'
                      : line.type === 'info' && !line.exitCode
                      ? 'text-[#6272a4] italic'
                      : line.type === 'henry'
                      ? 'text-[#8be9fd]'
                      : 'text-[#f8f8f2]'
                  }`}
                >
                  {line.type === 'stdout' ? <AnsiLine text={line.text} /> : line.text}
                  {line.exitCode !== undefined && line.durationMs !== undefined && (
                    <span className={`not-italic text-[10px] ml-2 ${line.exitCode === 0 ? 'text-[#50fa7b]/60' : 'text-[#ff5555]/70'}`}>
                      [{line.exitCode === 0 ? '✓' : `✗ ${line.exitCode}`} {(line.durationMs / 1000).toFixed(1)}s]
                    </span>
                  )}
                </span>
                {line.type === 'stderr' && !autoAnalyze && (
                  <button
                    onClick={() => analyzeError('', line.text, '')}
                    className="opacity-0 group-hover:opacity-100 ml-2 text-[10px] text-[#bd93f9] hover:text-[#d6acff] transition-all shrink-0 mt-0.5"
                  >
                    Ask Henry
                  </button>
                )}
              </div>
            ))}
            {running && (
              <div className="flex items-center gap-2 text-[#6272a4]">
                <span className="animate-pulse">▋</span>
                <span className="text-[11px]">running...</span>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-t border-[#1e1e2e] bg-[#0d0d16]">
            <span className="text-[#6272a4] font-mono text-xs shrink-0">
              {activeSession?.cwd ?? '~'}
            </span>
            <span className="text-[#50fa7b] font-mono text-xs shrink-0">$</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={running}
              placeholder={running ? '' : 'enter command...'}
              className="flex-1 bg-transparent text-[#f8f8f2] font-mono text-[13px] outline-none placeholder:text-[#3d3d5c] disabled:opacity-50"
              autoFocus
              spellCheck={false}
            />
            {running && (
              <span className="text-[10px] text-[#6272a4]">Ctrl+C to cancel</span>
            )}
          </div>
        </div>

        {/* Henry AI panel */}
        {showHenry && (
          <div className="flex-[2] min-w-0 flex flex-col bg-[#0d0d18] overflow-hidden">
            {/* Henry panel header */}
            <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-[#1e1e2e]">
              <div className="flex items-center gap-2">
                <div className={`w-1.5 h-1.5 rounded-full ${henryRunning ? 'bg-[#bd93f9] animate-pulse' : 'bg-[#6272a4]'}`} />
                <span className="text-xs font-medium text-[#cdd6f4]">Henry</span>
                <span className="text-[10px] text-[#6272a4]">watching your terminal</span>
              </div>
              {henryResponses.length > 0 && (
                <button
                  onClick={() => setHenryResponses([])}
                  className="text-[10px] text-[#6272a4] hover:text-[#cdd6f4] transition-colors"
                >
                  clear
                </button>
              )}
            </div>

            {/* Henry responses */}
            <div
              ref={henryRef}
              className="flex-1 overflow-y-auto px-4 py-3 space-y-4"
            >
              {henryResponses.length === 0 ? (
                <div className="text-center pt-8">
                  <div className="text-2xl mb-3">🧠</div>
                  <p className="text-xs text-[#6272a4] leading-relaxed">
                    Henry is watching.<br />
                    Run commands and I'll help when things go wrong.
                  </p>
                  <div className="mt-4 space-y-2 text-left">
                    {[
                      'Explain my last error',
                      'What does this output mean?',
                      'How do I check disk usage?',
                    ].map((q) => (
                      <button
                        key={q}
                        onClick={() => { setHenryInput(q); henryInputRef.current?.focus(); }}
                        className="block w-full text-left text-[11px] px-3 py-2 rounded-lg border border-[#1e1e2e] text-[#6272a4] hover:text-[#cdd6f4] hover:border-[#313244] hover:bg-[#13131f] transition-all"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                henryResponses.map((r) => (
                  <div key={r.id}>
                    <div className={`text-[12.5px] leading-relaxed text-[#cdd6f4] whitespace-pre-wrap ${r.isStreaming ? '' : ''}`}>
                      <HenryResponseRenderer content={r.content} isStreaming={r.isStreaming} onRunCommand={executeCommand} />
                    </div>
                    {!r.isStreaming && extractSuggestedCommands(r.content).length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {extractSuggestedCommands(r.content).map((cmd) => (
                          <button
                            key={cmd}
                            onClick={() => executeCommand(cmd)}
                            disabled={running}
                            className="flex items-center gap-2 w-full text-left text-[11px] font-mono px-3 py-2 rounded-lg bg-[#1e1e2e] border border-[#313244] text-[#bd93f9] hover:bg-[#252540] hover:border-[#bd93f9]/40 transition-all disabled:opacity-50 group"
                          >
                            <span className="text-[#50fa7b] shrink-0">▶</span>
                            <span className="truncate">{cmd}</span>
                            <span className="ml-auto text-[10px] text-[#6272a4] opacity-0 group-hover:opacity-100 shrink-0">run</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
              {henryRunning && henryResponses.every((r) => !r.isStreaming) && (
                <div className="text-[#6272a4] text-xs animate-pulse">Thinking...</div>
              )}
            </div>

            {/* Henry input */}
            <div className="shrink-0 p-3 border-t border-[#1e1e2e]">
              <div className="flex gap-2">
                <input
                  ref={henryInputRef}
                  value={henryInput}
                  onChange={(e) => setHenryInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') askHenry(henryInput); }}
                  disabled={henryRunning}
                  placeholder="Ask Henry about your terminal..."
                  className="flex-1 bg-[#13131f] border border-[#1e1e2e] focus:border-[#bd93f9]/40 rounded-lg px-3 py-2 text-xs text-[#cdd6f4] outline-none placeholder:text-[#3d3d5c] transition-all disabled:opacity-50 font-sans"
                />
                <button
                  onClick={() => askHenry(henryInput)}
                  disabled={henryRunning || !henryInput.trim()}
                  className="px-3 py-2 bg-[#bd93f9]/20 text-[#bd93f9] rounded-lg text-xs hover:bg-[#bd93f9]/30 transition-all disabled:opacity-40"
                >
                  Ask
                </button>
              </div>
              <div className="flex gap-2 mt-2">
                {['Explain last output', 'What failed?', 'Suggest next step'].map((q) => (
                  <button
                    key={q}
                    onClick={() => askHenry(q)}
                    disabled={henryRunning}
                    className="text-[10px] px-2.5 py-1 rounded-full border border-[#1e1e2e] text-[#6272a4] hover:text-[#cdd6f4] hover:border-[#313244] transition-all disabled:opacity-40"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Henry Response Renderer ──────────────────────────────────────────────────
function HenryResponseRenderer({
  content,
  isStreaming,
  onRunCommand,
}: {
  content: string;
  isStreaming: boolean;
  onRunCommand: (cmd: string) => void;
}) {
  const parts = content.split(/(```[\s\S]*?```)/g);
  return (
    <div className="space-y-2">
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const lines = part.slice(3);
          const langEnd = lines.indexOf('\n');
          const code = langEnd >= 0 ? lines.slice(langEnd + 1).replace(/```$/, '').trim() : lines.replace(/```$/, '').trim();
          return (
            <pre
              key={i}
              className="bg-[#1e1e2e] rounded-lg px-3 py-2.5 text-[11.5px] font-mono text-[#f8f8f2] overflow-x-auto leading-relaxed border border-[#313244]"
            >
              <code>{code}</code>
            </pre>
          );
        }
        return (
          <p key={i} className="text-[12.5px] text-[#cdd6f4] leading-relaxed whitespace-pre-wrap">
            {part}
            {isStreaming && i === parts.length - 1 && (
              <span className="inline-block w-[2px] h-[14px] bg-[#bd93f9] ml-0.5 animate-pulse align-middle" />
            )}
          </p>
        );
      })}
    </div>
  );
}
