/**
 * Messages tools — iMessage/SMS send (JXA) + history reads (chat.db) per
 * design §1.3, §4.1.
 *
 * Send (`messages_send`) is `confirm` tier — outbound communication always
 * pauses for the user. The body is passed to JXA via `HENRY_MSG_BODY` and read
 * with `$.getenv(...)`; it is never interpolated into the script string.
 *
 * Reads (`messages_read_recent`, `messages_list_contacts`) do NOT use JXA —
 * Messages.app scripting for history is slow and flaky. Instead we open
 * `~/Library/Messages/chat.db` read-only with better-sqlite3. This requires the
 * app to have Full Disk Access; if the open fails we surface a clear setup
 * hint. We never write to chat.db.
 *
 * chat.db stores timestamps as nanoseconds since the Apple/CoreData epoch
 * (2001-01-01 UTC); older databases use seconds. `appleToIso` handles both.
 */

import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { runJXAJson, MacOSAutomationError } from "../macos";
import type { ToolDefinition, ToolResult } from "../types";

type Row = Record<string, unknown>;

const CHAT_DB_PATH = path.join(os.homedir(), "Library", "Messages", "chat.db");
/** Seconds between the Unix epoch (1970) and the Apple epoch (2001). */
const APPLE_EPOCH_OFFSET = 978_307_200;

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

/** chat.db `date` → ISO. Handles both nanosecond and legacy second encodings. */
function appleToIso(raw: unknown): string | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return null;
  // Nanosecond timestamps are ~1e18; second timestamps are ~7e8.
  const seconds = n > 1e11 ? n / 1e9 : n;
  return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000).toISOString();
}

/** Open chat.db read-only, mapping the common Full-Disk-Access failure. */
function openChatDb(): Database.Database {
  try {
    return new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot open Messages history at ${CHAT_DB_PATH}. Grant Henry Full Disk Access ` +
        `under System Settings → Privacy & Security → Full Disk Access. (${msg})`,
    );
  }
}

/** Loose handle match: exact, or the trailing digits of a phone number. */
function handleVariants(contact: string): { exact: string; suffix: string } {
  const trimmed = contact.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  // Match on the last 10 digits to paper over +1 / formatting differences.
  const suffix =
    digits.length >= 10 ? `%${digits.slice(-10)}` : `%${digits || trimmed}`;
  return { exact: trimmed, suffix };
}

const SEND_JXA = `
ObjC.import('stdlib');
const recipient = $.getenv('HENRY_MSG_RECIPIENT');
const body = $.getenv('HENRY_MSG_BODY');
const app = Application('Messages');
// Prefer the iMessage service; fall back to whatever is configured (SMS).
let service = null;
const services = app.services();
for (let i = 0; i < services.length; i++) {
  try { if (String(services[i].serviceType()) === 'iMessage') { service = services[i]; break; } }
  catch (e) {}
}
if (!service && services.length) service = services[0];
let target = null;
try {
  const matches = (service ? service.buddies : app.buddies).whose({ handle: recipient })();
  if (matches.length) target = matches[0];
} catch (e) {}
if (!target) {
  const matches = app.buddies.whose({ handle: recipient })();
  if (matches.length) target = matches[0];
}
if (!target) throw new Error('No Messages buddy found for handle ' + recipient);
app.send(body, { to: target });
JSON.stringify({ sent: true, recipient: recipient });
`;

export function messagesTools(): ToolDefinition[] {
  return [
    // ── messages_send ────────────────────────────────────────────────────
    {
      name: "messages_send",
      description:
        "Send an iMessage or SMS to a phone number or email address. Use for " +
        '"text Dave that I\'ll be there by 9". The recipient must be reachable ' +
        "via Messages on this Mac.",
      category: "communication",
      safetyLevel: "confirm",
      confirmPrompt: (p) => {
        const body = String(p.body ?? "");
        const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
        return `Send iMessage to ${String(p.recipient)}: "${preview}"`;
      },
      inputSchema: {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            description:
              "Phone number or email address (an existing Messages handle).",
          },
          body: { type: "string", description: "Message text to send." },
        },
        required: ["recipient", "body"],
        additionalProperties: false,
      },
      async execute(params) {
        try {
          const recipient = String(params.recipient ?? "").trim();
          const body = String(params.body ?? "");
          if (!recipient) return fail("recipient is required");
          if (!body.trim()) return fail("body is required");
          const result = await runJXAJson(SEND_JXA, {
            HENRY_MSG_RECIPIENT: recipient,
            HENRY_MSG_BODY: body,
          });
          return ok(result);
        } catch (e) {
          if (e instanceof MacOSAutomationError) {
            const needsPerm = /not authoriz|access|-1743/i.test(
              `${e.message} ${e.stderr}`,
            );
            return fail(
              needsPerm
                ? `Messages automation not granted. Approve Henry under System Settings → ` +
                    `Privacy & Security → Automation → Messages. (${e.message})`
                : e.message,
            );
          }
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── messages_read_recent ─────────────────────────────────────────────
    {
      name: "messages_read_recent",
      description:
        "Read the most recent messages exchanged with one contact (phone or " +
        'email). Returns sender ("me" or the contact handle), body, and ' +
        "timestamp, newest first. Reads the local Messages database directly.",
      category: "communication",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          contact: {
            type: "string",
            description: "Phone number or email of the contact.",
          },
          limit: {
            type: "number",
            description: "Max messages to return (default 10).",
          },
        },
        required: ["contact"],
        additionalProperties: false,
      },
      async execute(params) {
        const contact = String(params.contact ?? "").trim();
        if (!contact) return fail("contact is required");
        const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 100);
        let db: Database.Database | null = null;
        try {
          db = openChatDb();
          const { exact, suffix } = handleVariants(contact);
          const rows = db
            .prepare(
              `SELECT m.text AS text, m.attributedBody IS NOT NULL AS has_rich,
                      m.is_from_me AS is_from_me, m.date AS date, h.id AS handle
               FROM message m
               JOIN handle h ON m.handle_id = h.ROWID
               WHERE h.id = ? OR h.id LIKE ?
               ORDER BY m.date DESC
               LIMIT ?`,
            )
            .all(exact, suffix, limit) as Row[];
          const messages = rows.map((r) => ({
            sender:
              Number(r.is_from_me) === 1 ? "me" : String(r.handle ?? contact),
            body:
              r.text != null && String(r.text).length > 0
                ? String(r.text)
                : Number(r.has_rich) === 1
                  ? "[message content not stored as plain text]"
                  : "",
            timestamp: appleToIso(r.date),
          }));
          return ok({ contact, messages, count: messages.length });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        } finally {
          db?.close();
        }
      },
    },

    // ── messages_list_contacts ───────────────────────────────────────────
    {
      name: "messages_list_contacts",
      description:
        "List contacts with message activity in the last 30 days, ordered by " +
        "most recent. Returns each handle, its last-message time, and message " +
        "count. Reads the local Messages database directly.",
      category: "communication",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max contacts to return (default 30).",
          },
        },
        additionalProperties: false,
      },
      async execute(params) {
        const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 200);
        let db: Database.Database | null = null;
        try {
          db = openChatDb();
          // 30-day cutoff expressed in Apple-epoch nanoseconds.
          const cutoffSeconds =
            Date.now() / 1000 - 30 * 86_400 - APPLE_EPOCH_OFFSET;
          const cutoffNs = Math.floor(cutoffSeconds * 1e9);
          const rows = db
            .prepare(
              `SELECT h.id AS handle, MAX(m.date) AS last_date, COUNT(*) AS msg_count
               FROM message m
               JOIN handle h ON m.handle_id = h.ROWID
               WHERE m.date >= ?
               GROUP BY h.id
               ORDER BY last_date DESC
               LIMIT ?`,
            )
            .all(cutoffNs, limit) as Row[];
          const contacts = rows.map((r) => ({
            handle: String(r.handle ?? ""),
            lastMessageAt: appleToIso(r.last_date),
            messageCount: Number(r.msg_count) || 0,
          }));
          return ok({ contacts, count: contacts.length });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        } finally {
          db?.close();
        }
      },
    },
  ];
}
