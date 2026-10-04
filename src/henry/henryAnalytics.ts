/**
 * Henry Usage Analytics — lightweight tracker for session patterns.
 * Stores locally, never transmitted. Used to surface "what Henry does most for you."
 */

interface UsageEvent {
  mode: string;
  view: string;
  ts: number;
}

const ANALYTICS_KEY = 'henry:usage_events';
const MAX_EVENTS = 200;

function loadEvents(): UsageEvent[] {
  try { return JSON.parse(localStorage.getItem(ANALYTICS_KEY) || '[]'); }
  catch { return []; }
}

function saveEvents(events: UsageEvent[]): void {
  try { localStorage.setItem(ANALYTICS_KEY, JSON.stringify(events.slice(-MAX_EVENTS))); }
  catch { /* ignore */ }
}

export function trackUsage(mode: string, view: string): void {
  try {
    const events = loadEvents();
    events.push({ mode, view, ts: Date.now() });
    saveEvents(events);
  } catch { /* non-critical */ }
}

export interface UsageSummary {
  topModes: Array<{ mode: string; count: number }>;
  topViews: Array<{ view: string; count: number }>;
  totalSessions: number;
  last7DaySessions: number;
}

export function getUsageSummary(): UsageSummary {
  const events = loadEvents();
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Count by mode
  const modeCounts: Record<string, number> = {};
  const viewCounts: Record<string, number> = {};
  let last7 = 0;

  for (const e of events) {
    modeCounts[e.mode] = (modeCounts[e.mode] || 0) + 1;
    viewCounts[e.view] = (viewCounts[e.view] || 0) + 1;
    if (e.ts > week) last7++;
  }

  const topModes = Object.entries(modeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([mode, count]) => ({ mode, count }));

  const topViews = Object.entries(viewCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([view, count]) => ({ view, count }));

  return {
    topModes,
    topViews,
    totalSessions: events.length,
    last7DaySessions: last7,
  };
}

export function getMostUsedMode(): string {
  const summary = getUsageSummary();
  return summary.topModes[0]?.mode ?? 'companion';
}
