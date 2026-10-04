/**
 * Henry Daily Summary — generates a structured end-of-day summary
 * combining tasks completed, journal notes, and what to carry forward.
 * Can be exported as text or drafted as an email.
 */

function safeGet<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DailySummaryData {
  date: string;
  owner: string;
  tasksCompleted: string[];
  tasksPending: string[];
  journalExcerpt: string | null;
  reminder_count: number;
  intention: string | null;
  captureCount: number;
  sessionCount: number;
}

export function buildDailySummaryData(): DailySummaryData {
  const today = todayStr();
  const owner = localStorage.getItem('henry:owner_name')?.trim() || 'you';

  // Tasks
  const tasks = safeGet<any[]>('henry:tasks', []);
  const completed = tasks
    .filter(t => (t.status === 'done' || t.status === 'completed') &&
      (t.updated_at || t.completedAt || '').slice(0, 10) === today)
    .map(t => t.title || t.prompt?.slice(0, 60) || 'Untitled task');
  const pending = tasks
    .filter(t => t.status === 'pending' || t.status === 'queued')
    .slice(0, 5)
    .map(t => t.title || t.prompt?.slice(0, 60) || 'Untitled task');

  // Journal
  const journalKey = `henry:journal:${today}`;
  const journalEntry = safeGet<{content?: string}>(journalKey, {});
  const journalExcerpt = journalEntry.content
    ? journalEntry.content.slice(0, 300) + (journalEntry.content.length > 300 ? '...' : '')
    : null;

  // Reminders due today
  const reminders = safeGet<any[]>('henry:reminders', []);
  const dueToday = reminders.filter(r =>
    !r.done && r.dueAt && r.dueAt.slice(0, 10) === today
  ).length;

  // Captures today
  const captures = safeGet<any[]>('henry:captures_v1', []);
  const todayCaptures = captures.filter(c =>
    (c.timestamp || c.createdAt || '').slice(0, 10) === today
  ).length;

  // Daily intention
  const intention = localStorage.getItem('henry:daily_intention_date') === today
    ? localStorage.getItem('henry:daily_intention')
    : null;

  // Focus sessions
  const sessions = safeGet<any[]>('henry:focus_sessions', []);
  const todaySessions = sessions.filter(s =>
    s.completedAt?.slice(0, 10) === today
  ).length;

  return {
    date: today,
    owner,
    tasksCompleted: completed,
    tasksPending: pending,
    journalExcerpt,
    reminder_count: dueToday,
    intention,
    captureCount: todayCaptures,
    sessionCount: todaySessions,
  };
}

export function buildDailySummaryPrompt(data: DailySummaryData): string {
  const lines: string[] = [
    `Generate a concise end-of-day summary for ${data.owner} for ${new Date(data.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`,
    '',
    '## Today\'s data',
  ];

  if (data.intention) {
    lines.push(`- Intention: "${data.intention}"`);
  }
  if (data.sessionCount > 0) {
    lines.push(`- Focus sessions completed: ${data.sessionCount}`);
  }
  if (data.tasksCompleted.length > 0) {
    lines.push(`- Tasks completed: ${data.tasksCompleted.join(', ')}`);
  }
  if (data.tasksPending.length > 0) {
    lines.push(`- Still pending: ${data.tasksPending.join(', ')}`);
  }
  if (data.captureCount > 0) {
    lines.push(`- Captures made: ${data.captureCount}`);
  }
  if (data.journalExcerpt) {
    lines.push(`- Journal: "${data.journalExcerpt}"`);
  }

  lines.push('');
  lines.push('Write a brief (3-5 sentence), warm, personal summary. Acknowledge what was accomplished. Note what carries forward. End with one practical thought for tomorrow. No bullet points — flowing prose.');

  return lines.join('\n');
}
