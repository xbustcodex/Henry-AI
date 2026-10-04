/**
 * Approval Queue (build plan, Phase 2) — a durable record of every confirm-tier
 * action Henry requests and how it was decided.
 *
 * The in-the-moment confirm prompt (toolRunner's `agent:confirm-required`) is
 * ephemeral: an in-memory promise that resolves once and is gone. This module
 * persists each request and its outcome so the queue is reviewable and
 * auditable after the fact — what's pending, what was approved, what was
 * rejected, what timed out.
 *
 * Flow:
 *   - toolRunner calls `recordApprovalRequest` when it asks for confirmation.
 *   - toolRunner calls `recordApprovalDecision` when the user approves/rejects,
 *     or when the request times out (status `expired`).
 *   - The renderer reads the queue via `approvals:list / :get / :stats`.
 *
 * Persistence helpers are best-effort: they never throw into the tool runner,
 * because failing to log an approval must not block (or wrongly allow) the action.
 */

import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import { getDb } from "./database";

const VALID_STATUS = new Set([
  "pending",
  "approved",
  "rejected",
  "needs_review",
  "expired",
  "completed",
]);

const SELECT_FIELDS = `id, tool_name, description, args_json, status,
  decided_args_json, session_id, requested_at, decided_at`;

function safe<T>(fn: () => T) {
  try {
    return { ok: true as const, result: fn() };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Record a new pending approval request. `id` is the confirm-request id minted
 * by toolRunner (so the later decision can find this row). INSERT OR REPLACE so
 * a re-emitted request id is idempotent rather than a constraint error.
 */
export function recordApprovalRequest(input: {
  id: string;
  toolName: string;
  description?: string;
  args?: Record<string, unknown>;
  sessionId?: string | null;
}): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO approvals
         (id, tool_name, description, args_json, status, session_id, requested_at)
       VALUES (?, ?, ?, ?, 'pending', ?, datetime('now'))`,
    ).run(
      input.id,
      input.toolName,
      input.description ?? null,
      input.args ? JSON.stringify(input.args) : null,
      input.sessionId ?? null,
    );
  } catch (e) {
    console.error("[approvals] record request failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Record the outcome of a pending request. `status` is approved | rejected |
 * expired (or needs_review / completed for later flows). No-ops on bad status
 * or if the row is already gone — best-effort, never throws.
 */
export function recordApprovalDecision(
  id: string,
  status: string,
  decidedArgs?: Record<string, unknown>,
): void {
  try {
    if (!VALID_STATUS.has(status)) return;
    const db = getDb();
    db.prepare(
      `UPDATE approvals
         SET status = ?, decided_args_json = ?, decided_at = datetime('now')
       WHERE id = ?`,
    ).run(status, decidedArgs ? JSON.stringify(decidedArgs) : null, id);
  } catch (e) {
    console.error("[approvals] record decision failed:", e instanceof Error ? e.message : e);
  }
}

export function registerApprovalHandlers(db: Database.Database): void {
  // All approvals, newest first, optionally filtered by status.
  ipcMain.handle("approvals:list", (_e, payload?: { status?: string; limit?: number }) =>
    safe(() => {
      const limit = Math.min(Number(payload?.limit) || 100, 500);
      const status = payload?.status;
      if (status && !VALID_STATUS.has(status)) throw new Error(`Invalid status: ${status}`);
      const sql = status
        ? `SELECT ${SELECT_FIELDS} FROM approvals WHERE status = ? ORDER BY requested_at DESC LIMIT ?`
        : `SELECT ${SELECT_FIELDS} FROM approvals ORDER BY requested_at DESC LIMIT ?`;
      return status
        ? db.prepare(sql).all(status, limit)
        : db.prepare(sql).all(limit);
    }),
  );

  ipcMain.handle("approvals:get", (_e, payload: { id: string }) =>
    safe(() => db.prepare(`SELECT ${SELECT_FIELDS} FROM approvals WHERE id = ?`).get(payload?.id) ?? null),
  );

  // Counts per status — for a queue badge / dashboard summary.
  ipcMain.handle("approvals:stats", () =>
    safe(() => {
      const rows = db
        .prepare(`SELECT status, COUNT(*) AS n FROM approvals GROUP BY status`)
        .all() as { status: string; n: number }[];
      const out: Record<string, number> = {
        pending: 0, approved: 0, rejected: 0, needs_review: 0, expired: 0, completed: 0,
      };
      for (const r of rows) out[r.status] = r.n;
      return out;
    }),
  );
}
