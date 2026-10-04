/**
 * Daily Intention — user sets a one-line focus for the day.
 * Injected into Henry's system prompt so every response is anchored to it.
 */

const INTENTION_KEY = 'henry:daily_intention';
const INTENTION_DATE_KEY = 'henry:daily_intention_date';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DailyIntention {
  text: string;
  date: string;
  setAt: string;
}

export function getDailyIntention(): DailyIntention | null {
  try {
    const date = localStorage.getItem(INTENTION_DATE_KEY);
    const text = localStorage.getItem(INTENTION_KEY);
    if (!text || date !== todayKey()) return null;
    return { text, date, setAt: '' };
  } catch { return null; }
}

export function setDailyIntention(text: string): void {
  try {
    localStorage.setItem(INTENTION_KEY, text.trim());
    localStorage.setItem(INTENTION_DATE_KEY, todayKey());
  } catch { /* ignore */ }
}

export function clearDailyIntention(): void {
  try {
    localStorage.removeItem(INTENTION_KEY);
    localStorage.removeItem(INTENTION_DATE_KEY);
  } catch { /* ignore */ }
}

export function buildIntentionBlock(): string {
  const intention = getDailyIntention();
  if (!intention?.text) return '';
  return `Today's intention (set by ${localStorage.getItem('henry:owner_name') || 'user'}, anchor all responses to this): "${intention.text}"`;
}
