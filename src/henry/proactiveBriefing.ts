/**
 * Henry Proactive Briefing — generates a daily briefing on new day.
 * Stored per-day, shows in Today panel, auto-triggers in chat.
 */

const BRIEFING_KEY_PREFIX = 'henry:briefing:';
const BRIEFING_GENERATING_KEY = 'henry:briefing:generating';
const BRIEFING_GENERATING_TS_KEY = 'henry:briefing:generating_ts';
const BRIEFING_GENERATING_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface DailyBriefing {
  date: string;
  content: string;
  generatedAt: string;
  model?: string;
}

export function getTodayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getTodayBriefing(): DailyBriefing | null {
  try {
    const raw = localStorage.getItem(BRIEFING_KEY_PREFIX + getTodayKey());
    return raw ? (JSON.parse(raw) as DailyBriefing) : null;
  } catch {
    return null;
  }
}

export function saveBriefing(content: string, model?: string): DailyBriefing {
  const briefing: DailyBriefing = {
    date: getTodayKey(),
    content,
    generatedAt: new Date().toISOString(),
    model,
  };
  localStorage.setItem(BRIEFING_KEY_PREFIX + getTodayKey(), JSON.stringify(briefing));
  return briefing;
}

export function isGenerating(): boolean {
  if (localStorage.getItem(BRIEFING_GENERATING_KEY) !== 'true') return false;
  const ts = Number(localStorage.getItem(BRIEFING_GENERATING_TS_KEY) ?? '0');
  if (Date.now() - ts > BRIEFING_GENERATING_TTL_MS) {
    localStorage.removeItem(BRIEFING_GENERATING_KEY);
    localStorage.removeItem(BRIEFING_GENERATING_TS_KEY);
    return false;
  }
  return true;
}

export function setGenerating(v: boolean): void {
  if (v) {
    localStorage.setItem(BRIEFING_GENERATING_KEY, 'true');
    localStorage.setItem(BRIEFING_GENERATING_TS_KEY, String(Date.now()));
  } else {
    localStorage.removeItem(BRIEFING_GENERATING_KEY);
    localStorage.removeItem(BRIEFING_GENERATING_TS_KEY);
  }
}

/**
 * Pull today's real data from SQLite for a richer briefing context.
 * Returns a formatted context string for the briefing prompt.
 */
export async function buildLiveContext(): Promise<string> {
  const api = (window as any).henryAPI;
  if (!api) return '';
  try {
    const [tasks, reminders, finance] = await Promise.all([
      api.tasksList({ status: 'todo' }).catch(() => []),
      api.remindersDue().catch(() => []),
      api.financeSummary(new Date().toISOString().slice(0, 7)).catch(() => null),
    ]);
    const lines: string[] = [];
    if ((tasks || []).length > 0) {
      const titles = (tasks as {title:string}[]).slice(0, 4).map(t => '• ' + t.title).join('\n');
      lines.push('Open tasks:\n' + titles);
    }
    if ((reminders || []).length > 0) {
      const rems = (reminders as {title:string;due_at:string}[]).slice(0, 3)
        .map(r => '• ' + r.title + ' (due ' + r.due_at.slice(0,10) + ')').join('\n');
      lines.push('Due reminders:\n' + rems);
    }
    if (finance && (finance.income > 0 || finance.expenses > 0)) {
      lines.push(`This month: income $${finance.income.toFixed(0)}, expenses $${finance.expenses.toFixed(0)}, net $${finance.net.toFixed(0)}`);
    }
        return lines.join('\n\n');
  } catch {
    return '';
  }
}

export function buildBriefingPrompt(facts: string, liveContext?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const hour = now.getHours();
  const greeting = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  const ownerName = localStorage.getItem('henry:owner_name')?.trim() || 'you';
  const contextLabel = ownerName === 'you' ? 'Context' : `Context about ${ownerName}`;

  return `It's ${greeting} on ${dateStr} at ${timeStr}. Generate a brief, warm daily briefing for ${ownerName === 'you' ? 'the user' : ownerName}.

Structure (keep it tight — under 200 words total):
1. One opening line acknowledging the day (not generic — say something true about ${now.toLocaleDateString('en-US', { weekday: 'long' })}s)
2. What to focus on (1-2 priorities based on context below)
3. One thing to keep in mind today
4. One quick win to start with

${facts ? `${contextLabel}:\n${facts}\n` : ''}

Be warm and direct. No corporate language. Sound like you've been in the room all morning.`;
}
