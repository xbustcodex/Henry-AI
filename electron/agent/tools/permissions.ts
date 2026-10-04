/**
 * Permissions check (design §2 "request permissions lazily").
 *
 * `permissions_check` probes whether Henry can actually reach the macOS apps
 * the automation tools depend on, so Henry can surface a setup prompt on
 * startup instead of failing mid-task. It is `silent`.
 *
 * Calendar / Messages / Mail access is tested with a tiny JXA probe (touching
 * each app forces the Automation permission evaluation). Full Disk Access is
 * tested by attempting a read-only open of the Messages database — that file is
 * unreadable without it.
 *
 * Each capability resolves to 'granted' | 'denied' | 'unknown'. Running this
 * may trigger the first-use permission prompts, which is the intended setup
 * flow.
 */

import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { runJXAJson } from "../macos";
import type { ToolDefinition, ToolResult } from "../types";

const CHAT_DB_PATH = path.join(os.homedir(), "Library", "Messages", "chat.db");

type Status = "granted" | "denied" | "unknown";

/**
 * One JXA call probes all three apps. Each is wrapped so a permission denial
 * for one app doesn't abort the others; a thrown/denied access yields 'denied'.
 */
const PROBE_JXA = `
function probe(fn) {
  try { fn(); return 'granted'; }
  catch (e) {
    const msg = String(e && e.message || e);
    if (/not authoriz|-1743|access/i.test(msg)) return 'denied';
    return 'denied';
  }
}
const result = {
  calendar: probe(function () { Application('Calendar').calendars.length; }),
  messages: probe(function () { Application('Messages').services.length; }),
  mail: probe(function () { Application('Mail').inbox.name(); }),
};
JSON.stringify(result);
`;

function checkFullDiskAccess(): Status {
  let db: Database.Database | null = null;
  try {
    db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    // Touch the schema to be sure the open is real, not lazy.
    db.prepare("SELECT 1 FROM message LIMIT 1").get();
    return "granted";
  } catch {
    return "denied";
  } finally {
    db?.close();
  }
}

export function permissionsTools(): ToolDefinition[] {
  return [
    {
      name: "permissions_check",
      description:
        "Check whether Henry has the macOS permissions its automation tools " +
        "need: Calendar, Messages, and Mail (Automation) plus Full Disk Access " +
        "(for reading Messages history). Returns a status object so Henry can " +
        "prompt the user to grant anything missing. Safe to call on startup.",
      category: "system",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(): Promise<ToolResult> {
        const status: Record<string, Status> = {
          calendar: "unknown",
          messages: "unknown",
          mail: "unknown",
          fullDiskAccess: "unknown",
        };

        try {
          const probe = await runJXAJson<Record<string, Status>>(PROBE_JXA);
          if (probe && typeof probe === "object") {
            status.calendar = probe.calendar ?? "unknown";
            status.messages = probe.messages ?? "unknown";
            status.mail = probe.mail ?? "unknown";
          }
        } catch {
          // Whole-probe failure (e.g. osascript missing) — leave as 'unknown'.
        }

        status.fullDiskAccess = checkFullDiskAccess();

        const allGranted = Object.values(status).every((s) => s === "granted");
        return {
          ok: true,
          data: {
            ...status,
            allGranted,
            hint: allGranted
              ? undefined
              : 'Grant any "denied" items under System Settings → Privacy & Security ' +
                "(Automation, Calendars, Full Disk Access).",
          },
        };
      },
    },
  ];
}
