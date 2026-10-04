/**
 * Calendar tools — Henry's window into macOS Calendar via JXA (design §1.2, §4.2).
 *
 * Reads (`calendar_list_events`, `calendar_get_event`, `calendar_find_free_slots`)
 * are `silent`. Creating an event is `notify` — it executes immediately and the
 * runner fires a toast describing what landed on the calendar.
 *
 * Every string argument the model produces (titles, locations, notes, calendar
 * names, dates) is passed to JXA through `HENRY_*` env vars and read with
 * `$.getenv(...)`. The script bodies below are static constants — nothing the
 * model emits is interpolated into them. See `electron/agent/macos.ts`.
 */

import { runJXAJson, MacOSAutomationError } from "../macos";
import type { ToolDefinition, ToolResult } from "../types";

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

/** Map a JXA failure to a ToolResult, hinting at a permission problem. */
function fromError(e: unknown): ToolResult {
  if (e instanceof MacOSAutomationError) {
    const needsPerm = /not authoriz|access|-1743|errAEEventNotPermitted/i.test(
      `${e.message} ${e.stderr}`,
    );
    return fail(
      needsPerm
        ? `Calendar access not granted. Approve Henry under System Settings → Privacy & Security → Calendars (and Automation). (${e.message})`
        : e.message,
      e.timedOut,
    );
  }
  return fail(e instanceof Error ? e.message : String(e));
}

function isValidDate(s: string): boolean {
  return !Number.isNaN(new Date(s).getTime());
}

// ── JXA scripts (static — user data arrives via env) ─────────────────────────

const LIST_EVENTS_JXA = `
ObjC.import('stdlib');
const start = new Date($.getenv('HENRY_CAL_START'));
const end = new Date($.getenv('HENRY_CAL_END'));
const filter = $.getenv('HENRY_CAL_NAME') || '';
const app = Application('Calendar');
const out = [];
const cals = app.calendars();
for (let i = 0; i < cals.length; i++) {
  const cal = cals[i];
  const name = cal.name();
  if (filter && name !== filter) continue;
  const evs = cal.events.whose({ _and: [
    { startDate: { _greaterThanEquals: start } },
    { startDate: { _lessThan: end } },
  ] })();
  for (let j = 0; j < evs.length; j++) {
    const e = evs[j];
    out.push({
      id: e.uid(),
      title: e.summary(),
      start: e.startDate().toISOString(),
      end: e.endDate().toISOString(),
      location: e.location() || null,
      allDay: e.alldayEvent(),
      calendar: name,
    });
  }
}
out.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
JSON.stringify(out);
`;

const GET_EVENT_JXA = `
ObjC.import('stdlib');
const needle = ($.getenv('HENRY_EVT_TITLE') || '').toLowerCase();
const start = new Date($.getenv('HENRY_CAL_START'));
const end = new Date($.getenv('HENRY_CAL_END'));
const app = Application('Calendar');
let best = null;
const cals = app.calendars();
for (let i = 0; i < cals.length; i++) {
  const cal = cals[i];
  const evs = cal.events.whose({ _and: [
    { startDate: { _greaterThanEquals: start } },
    { startDate: { _lessThan: end } },
  ] })();
  for (let j = 0; j < evs.length; j++) {
    const e = evs[j];
    const title = (e.summary() || '').toLowerCase();
    if (needle && title.indexOf(needle) === -1) continue;
    const rec = {
      id: e.uid(),
      title: e.summary(),
      start: e.startDate().toISOString(),
      end: e.endDate().toISOString(),
      location: e.location() || null,
      notes: e.description() || null,
      allDay: e.alldayEvent(),
      calendar: cal.name(),
    };
    if (!best || rec.start < best.start) best = rec;
  }
}
JSON.stringify(best);
`;

const CREATE_EVENT_JXA = `
ObjC.import('stdlib');
const title = $.getenv('HENRY_EVT_TITLE');
const start = new Date($.getenv('HENRY_EVT_START'));
const end = new Date($.getenv('HENRY_EVT_END'));
const location = $.getenv('HENRY_EVT_LOCATION') || '';
const notes = $.getenv('HENRY_EVT_NOTES') || '';
const calName = $.getenv('HENRY_CAL_NAME') || '';
const app = Application('Calendar');
let cal = null;
if (calName) {
  const matches = app.calendars.whose({ name: calName })();
  if (matches.length) cal = matches[0];
}
if (!cal) {
  // Default: first writable calendar, falling back to the very first one.
  const cals = app.calendars();
  for (let i = 0; i < cals.length; i++) {
    try { if (cals[i].writable()) { cal = cals[i]; break; } } catch (e) {}
  }
  if (!cal && cals.length) cal = cals[0];
}
if (!cal) throw new Error('No calendar available to write to.');
const props = { summary: title, startDate: start, endDate: end };
if (location) props.location = location;
if (notes) props.description = notes;
const ev = app.Event(props);
cal.events.push(ev);
JSON.stringify({
  id: ev.uid(),
  title: ev.summary(),
  start: ev.startDate().toISOString(),
  end: ev.endDate().toISOString(),
  location: ev.location() || null,
  calendar: cal.name(),
});
`;

const FREE_SLOTS_JXA = `
ObjC.import('stdlib');
const dateStr = $.getenv('HENRY_CAL_DATE');
const durationMin = parseInt($.getenv('HENRY_SLOT_DURATION') || '60', 10);
// Local 08:00–18:00 window for the given calendar day.
const dayStart = new Date(dateStr + 'T08:00:00');
const dayEnd = new Date(dateStr + 'T18:00:00');
const durMs = durationMin * 60 * 1000;
const app = Application('Calendar');
const busy = [];
const cals = app.calendars();
for (let i = 0; i < cals.length; i++) {
  const evs = cals[i].events.whose({ _and: [
    { endDate: { _greaterThan: dayStart } },
    { startDate: { _lessThan: dayEnd } },
  ] })();
  for (let j = 0; j < evs.length; j++) {
    const e = evs[j];
    if (e.alldayEvent()) continue;
    busy.push({ start: e.startDate().getTime(), end: e.endDate().getTime() });
  }
}
busy.sort((a, b) => a.start - b.start);
const slots = [];
let cursor = dayStart.getTime();
const endMs = dayEnd.getTime();
for (let i = 0; i < busy.length; i++) {
  const b = busy[i];
  if (b.start > cursor && (b.start - cursor) >= durMs) {
    slots.push({ start: new Date(cursor).toISOString(), end: new Date(b.start).toISOString() });
  }
  if (b.end > cursor) cursor = b.end;
}
if (endMs - cursor >= durMs) {
  slots.push({ start: new Date(cursor).toISOString(), end: new Date(endMs).toISOString() });
}
JSON.stringify(slots);
`;

export function calendarTools(): ToolDefinition[] {
  return [
    // ── calendar_list_events ─────────────────────────────────────────────
    {
      name: "calendar_list_events",
      description:
        "List calendar events in a date range across all calendars (or one " +
        "named calendar). Defaults to today through 7 days out. Returns title, " +
        'start, end, location, and calendar name. Use to answer "what do I ' +
        'have this week / tomorrow?".',
      category: "calendar",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          start: {
            type: "string",
            description: "ISO start of range (default: now).",
          },
          end: {
            type: "string",
            description: "ISO end of range (default: now + 7 days).",
          },
          calendar: {
            type: "string",
            description: "Only list this named calendar.",
          },
        },
        additionalProperties: false,
      },
      async execute(params) {
        try {
          const now = new Date();
          const startIso = params.start
            ? String(params.start)
            : now.toISOString();
          const endIso = params.end
            ? String(params.end)
            : new Date(now.getTime() + 7 * 86_400_000).toISOString();
          if (!isValidDate(startIso) || !isValidDate(endIso)) {
            return fail("start/end must be valid ISO datetimes");
          }
          const events = await runJXAJson(LIST_EVENTS_JXA, {
            HENRY_CAL_START: startIso,
            HENRY_CAL_END: endIso,
            HENRY_CAL_NAME: params.calendar ? String(params.calendar) : "",
          });
          const list = Array.isArray(events) ? events : [];
          return ok({
            start: startIso,
            end: endIso,
            events: list,
            count: list.length,
          });
        } catch (e) {
          return fromError(e);
        }
      },
    },

    // ── calendar_get_event ───────────────────────────────────────────────
    {
      name: "calendar_get_event",
      description:
        "Get full detail (including notes) for a single event matched by title " +
        "(fuzzy, case-insensitive substring) within a date window. Defaults to " +
        "searching from now through 30 days out. Returns the earliest match.",
      category: "calendar",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Title text to match (substring, fuzzy).",
          },
          start: {
            type: "string",
            description: "ISO start of search window (default: now).",
          },
          end: {
            type: "string",
            description: "ISO end of search window (default: now + 30 days).",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      async execute(params) {
        try {
          const title = String(params.title ?? "").trim();
          if (!title) return fail("title is required");
          const now = new Date();
          const startIso = params.start
            ? String(params.start)
            : now.toISOString();
          const endIso = params.end
            ? String(params.end)
            : new Date(now.getTime() + 30 * 86_400_000).toISOString();
          if (!isValidDate(startIso) || !isValidDate(endIso)) {
            return fail("start/end must be valid ISO datetimes");
          }
          const event = await runJXAJson(GET_EVENT_JXA, {
            HENRY_EVT_TITLE: title,
            HENRY_CAL_START: startIso,
            HENRY_CAL_END: endIso,
          });
          if (!event)
            return fail(`No event matching "${title}" in that window.`);
          return ok(event);
        } catch (e) {
          return fromError(e);
        }
      },
    },

    // ── calendar_create_event ────────────────────────────────────────────
    {
      name: "calendar_create_event",
      description:
        "Create a new calendar event. Provide a title and ISO start/end " +
        "datetimes; location, notes, and a target calendar are optional " +
        "(defaults to the primary writable calendar).",
      category: "calendar",
      // confirm: writes a real event to the user's calendar, which can sync to
      // shared/work calendars and other devices. Treated like other real-world
      // writes (qb_create_invoice, *_send) — pause for the user first.
      safetyLevel: "confirm",
      confirmPrompt: (p) =>
        `Create calendar event "${String(p.title)}" from ${String(p.startDate)} to ${String(
          p.endDate,
        )}` + (p.location ? ` at ${String(p.location)}` : ""),
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title." },
          startDate: { type: "string", description: "ISO start datetime." },
          endDate: { type: "string", description: "ISO end datetime." },
          location: { type: "string" },
          notes: { type: "string" },
          calendarName: {
            type: "string",
            description: "Target calendar (default: primary).",
          },
        },
        required: ["title", "startDate", "endDate"],
        additionalProperties: false,
      },
      async execute(params) {
        try {
          const title = String(params.title ?? "").trim();
          const startIso = String(params.startDate ?? "");
          const endIso = String(params.endDate ?? "");
          if (!title) return fail("title is required");
          if (!isValidDate(startIso) || !isValidDate(endIso)) {
            return fail("startDate/endDate must be valid ISO datetimes");
          }
          if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
            return fail("endDate must be after startDate");
          }
          const created = await runJXAJson(CREATE_EVENT_JXA, {
            HENRY_EVT_TITLE: title,
            HENRY_EVT_START: startIso,
            HENRY_EVT_END: endIso,
            HENRY_EVT_LOCATION: params.location ? String(params.location) : "",
            HENRY_EVT_NOTES: params.notes ? String(params.notes) : "",
            HENRY_CAL_NAME: params.calendarName
              ? String(params.calendarName)
              : "",
          });
          return ok(created);
        } catch (e) {
          return fromError(e);
        }
      },
    },

    // ── calendar_find_free_slots ─────────────────────────────────────────
    {
      name: "calendar_find_free_slots",
      description:
        "Find open time slots on a given day (8am–6pm local) that fit a " +
        "requested duration in minutes, skipping anything already on the " +
        'calendar. Use to schedule a job: "find me a 2-hour slot on Thursday".',
      category: "calendar",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Day to search, YYYY-MM-DD." },
          durationMinutes: {
            type: "number",
            description: "Required slot length in minutes.",
          },
        },
        required: ["date", "durationMinutes"],
        additionalProperties: false,
      },
      async execute(params) {
        try {
          const date = String(params.date ?? "").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return fail("date must be in YYYY-MM-DD format");
          }
          const duration = Math.round(Number(params.durationMinutes));
          if (!Number.isFinite(duration) || duration <= 0) {
            return fail("durationMinutes must be a positive number");
          }
          const slots = await runJXAJson(FREE_SLOTS_JXA, {
            HENRY_CAL_DATE: date,
            HENRY_SLOT_DURATION: String(duration),
          });
          const list = Array.isArray(slots) ? slots : [];
          return ok({
            date,
            durationMinutes: duration,
            slots: list,
            count: list.length,
          });
        } catch (e) {
          return fromError(e);
        }
      },
    },
  ];
}
