/**
 * Email tools — macOS Mail via JXA (design §1.3, §4.3).
 *
 * Sending (`email_send`) is `confirm` tier — outbound communication pauses for
 * the user. Reads (`email_read_recent`, `email_search`) are `silent`.
 *
 * All user/model content (recipients, subject, body, search query, mailbox
 * name) reaches JXA through `HENRY_*` env vars read with `$.getenv(...)`. The
 * script bodies are static constants — see `electron/agent/macos.ts`.
 *
 * Note: this uses Mail.app's own scripting `send`, per the Sprint-2 brief. The
 * design doc flags Mail JXA send as occasionally unreliable when Mail is not
 * running and suggests SMTP/nodemailer as a future hardening step; that is out
 * of scope here.
 */

import { runJXAJson, MacOSAutomationError } from "../macos";
import type { ToolDefinition, ToolResult } from "../types";

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

function fromError(e: unknown, verb: string): ToolResult {
  if (e instanceof MacOSAutomationError) {
    const needsPerm = /not authoriz|access|-1743/i.test(
      `${e.message} ${e.stderr}`,
    );
    return fail(
      needsPerm
        ? `Mail automation not granted. Approve Henry under System Settings → Privacy & ` +
            `Security → Automation → Mail. (${e.message})`
        : `Could not ${verb}: ${e.message}`,
      e.timedOut,
    );
  }
  return fail(e instanceof Error ? e.message : String(e));
}

const SEND_JXA = `
ObjC.import('stdlib');
const to = $.getenv('HENRY_EMAIL_TO');
const cc = $.getenv('HENRY_EMAIL_CC') || '';
const subject = $.getenv('HENRY_EMAIL_SUBJECT') || '';
const body = $.getenv('HENRY_EMAIL_BODY') || '';
const Mail = Application('Mail');
const msg = Mail.OutgoingMessage({ subject: subject, content: body, visible: false });
Mail.outgoingMessages.push(msg);
msg.toRecipients.push(Mail.Recipient({ address: to }));
if (cc) msg.ccRecipients.push(Mail.Recipient({ address: cc }));
msg.send();
JSON.stringify({ sent: true, to: to, subject: subject });
`;

const READ_RECENT_JXA = `
ObjC.import('stdlib');
const boxName = $.getenv('HENRY_MAIL_BOX') || 'INBOX';
const count = parseInt($.getenv('HENRY_MAIL_COUNT') || '10', 10);
const Mail = Application('Mail');
function resolveBox() {
  if (boxName.toUpperCase() === 'INBOX') return Mail.inbox;
  const accounts = Mail.accounts();
  for (let i = 0; i < accounts.length; i++) {
    const boxes = accounts[i].mailboxes.whose({ name: boxName })();
    if (boxes.length) return boxes[0];
  }
  return Mail.inbox;
}
const box = resolveBox();
const msgs = box.messages;
const total = msgs.length;
const n = Math.min(count, total);
const out = [];
for (let i = 0; i < n; i++) {
  const m = msgs[i];
  let snippet = '';
  try { snippet = (m.content() || '').slice(0, 200); } catch (e) {}
  out.push({
    sender: m.sender(),
    subject: m.subject(),
    date: m.dateReceived().toISOString(),
    snippet: snippet,
  });
}
JSON.stringify(out);
`;

const SEARCH_JXA = `
ObjC.import('stdlib');
const q = ($.getenv('HENRY_MAIL_QUERY') || '').toLowerCase();
const Mail = Application('Mail');
const msgs = Mail.inbox.messages;
const total = msgs.length;
// Cap the scan so a huge inbox can't blow the timeout.
const scanLimit = Math.min(total, 500);
const out = [];
for (let i = 0; i < scanLimit && out.length < 20; i++) {
  const m = msgs[i];
  const subject = m.subject() || '';
  const sender = m.sender() || '';
  if (subject.toLowerCase().indexOf(q) !== -1 || sender.toLowerCase().indexOf(q) !== -1) {
    out.push({ sender: sender, subject: subject, date: m.dateReceived().toISOString() });
  }
}
JSON.stringify(out);
`;

export function emailTools(): ToolDefinition[] {
  return [
    // ── email_send ───────────────────────────────────────────────────────
    {
      name: "email_send",
      description:
        "Send an email via macOS Mail. Provide to, subject, and body; cc is " +
        'optional. Use for "email Dave the quote" or invoice follow-ups.',
      category: "communication",
      safetyLevel: "confirm",
      confirmPrompt: (p) =>
        `Send email to ${String(p.to)} — Subject: "${String(p.subject ?? "")}"`,
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Email subject line." },
          body: { type: "string", description: "Plain-text email body." },
          cc: { type: "string", description: "Optional CC email address." },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
      async execute(params) {
        try {
          const to = String(params.to ?? "").trim();
          const subject = String(params.subject ?? "");
          const body = String(params.body ?? "");
          if (!to) return fail("to is required");
          if (!body.trim()) return fail("body is required");
          const result = await runJXAJson(SEND_JXA, {
            HENRY_EMAIL_TO: to,
            HENRY_EMAIL_CC: params.cc ? String(params.cc) : "",
            HENRY_EMAIL_SUBJECT: subject,
            HENRY_EMAIL_BODY: body,
          });
          return ok(result);
        } catch (e) {
          return fromError(e, "send email");
        }
      },
    },

    // ── email_read_recent ────────────────────────────────────────────────
    {
      name: "email_read_recent",
      description:
        "Read recent emails from macOS Mail, newest first. Defaults to the " +
        "Inbox and 10 messages. Returns sender, subject, date, and a 200-char " +
        "snippet of the body.",
      category: "communication",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          mailbox: {
            type: "string",
            description: "Mailbox name (default: Inbox).",
          },
          count: {
            type: "number",
            description: "How many to return (default 10).",
          },
        },
        additionalProperties: false,
      },
      async execute(params) {
        try {
          const mailbox = params.mailbox ? String(params.mailbox) : "INBOX";
          const count = Math.min(Math.max(Number(params.count) || 10, 1), 50);
          const emails = await runJXAJson(READ_RECENT_JXA, {
            HENRY_MAIL_BOX: mailbox,
            HENRY_MAIL_COUNT: String(count),
          });
          const list = Array.isArray(emails) ? emails : [];
          return ok({ mailbox, emails: list, count: list.length });
        } catch (e) {
          return fromError(e, "read mail");
        }
      },
    },

    // ── email_search ─────────────────────────────────────────────────────
    {
      name: "email_search",
      description:
        "Search the Mail inbox for messages whose subject or sender contains a " +
        "query string (case-insensitive). Returns up to 20 matches with sender, " +
        "subject, and date.",
      category: "communication",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to match in subject or sender.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(params) {
        try {
          const query = String(params.query ?? "").trim();
          if (!query) return fail("query is required");
          const emails = await runJXAJson(SEARCH_JXA, {
            HENRY_MAIL_QUERY: query,
          });
          const list = Array.isArray(emails) ? emails : [];
          return ok({ query, emails: list, count: list.length });
        } catch (e) {
          return fromError(e, "search mail");
        }
      },
    },
  ];
}
