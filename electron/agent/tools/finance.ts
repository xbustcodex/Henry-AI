/**
 * Finance tools — Henry's money layer over the existing `quotes` /
 * `quote_line_items` tables (see `electron/ipc/quoting.ts`) and the
 * `transactions` table (see `electron/ipc/memory.ts`).
 *
 * Reads are `silent`, writes to Henry's own data are `notify`, and anything
 * that sends money/value outward is `confirm` (design §5). In Sprint 1 nothing
 * sends yet, so `quote_create` is `notify` — it only drafts.
 *
 * Invoices: there is no dedicated `invoices` table until the QuickBooks
 * connector lands (Sprint 4). Until then `invoice_list` and the receivables in
 * `finance_summary` are derived from quotes in a billable state (sent /
 * accepted), with `valid_until` standing in for a due date. This is documented
 * so the model's answers stay honest about the data source.
 */

import type Database from "better-sqlite3";
import type { ToolDefinition, ToolResult } from "../types";

type Row = Record<string, unknown>;

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Q-YYYY-NNNN, auto-incrementing per calendar year. Mirrors quoting.ts. */
function nextQuoteNumber(db: Database.Database): string {
  const year = new Date().getFullYear();
  const prefix = `Q-${year}-`;
  const row = db
    .prepare(
      `SELECT quote_number FROM quotes WHERE quote_number LIKE ? ORDER BY quote_number DESC LIMIT 1`,
    )
    .get(`${prefix}%`) as { quote_number?: string } | undefined;
  let next = 1;
  if (row?.quote_number) {
    const n = parseInt(row.quote_number.slice(prefix.length), 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  return `${prefix}${String(next).padStart(4, "0")}`;
}

/** Recompute subtotal/tax/total from line items. Mirrors quoting.ts. */
function recomputeTotals(db: Database.Database, quoteId: string): void {
  const items = db
    .prepare(
      `SELECT quantity, unit_cost, line_total, taxable FROM quote_line_items WHERE quote_id = ?`,
    )
    .all(quoteId) as Row[];
  let taxable = 0;
  let nonTaxable = 0;
  for (const it of items) {
    const total =
      it.line_total !== null && it.line_total !== undefined
        ? num(it.line_total)
        : num(it.quantity, 1) * num(it.unit_cost, 0);
    if (Number(it.taxable) === 1) taxable += total;
    else nonTaxable += total;
  }
  const quote = db
    .prepare(`SELECT tax_rate FROM quotes WHERE id = ?`)
    .get(quoteId) as { tax_rate?: number } | undefined;
  const taxRate = num(quote?.tax_rate, 0);
  const subtotal = taxable + nonTaxable;
  const taxAmount = taxable * (taxRate / 100);
  const total = subtotal + taxAmount;
  db.prepare(
    `UPDATE quotes SET subtotal = ?, tax_amount = ?, total = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(
    Math.round(subtotal * 100) / 100,
    Math.round(taxAmount * 100) / 100,
    Math.round(total * 100) / 100,
    quoteId,
  );
}

export function financeTools(): ToolDefinition[] {
  return [
    // ── quote_list ───────────────────────────────────────────────────────
    {
      name: "quote_list",
      description:
        "List quotes with their status (draft, sent, accepted, declined, " +
        "expired) and total. Optionally filter by status or a search query.",
      category: "finance",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["draft", "sent", "accepted", "declined", "expired"],
            description: "Filter by quote status.",
          },
          query: {
            type: "string",
            description: "Match project, customer, or quote number.",
          },
          limit: { type: "number", description: "Max results (default 50)." },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const where: string[] = [];
          const args: unknown[] = [];
          if (params.status) {
            where.push("status = ?");
            args.push(String(params.status));
          }
          const q = params.query ? String(params.query).trim() : "";
          if (q) {
            where.push(
              "(project_title LIKE ? OR customer_name LIKE ? OR customer_company LIKE ? OR quote_number LIKE ?)",
            );
            const l = `%${q}%`;
            args.push(l, l, l, l);
          }
          const limit = Math.min(Number(params.limit) || 50, 200);
          args.push(limit);
          const quotes = db
            .prepare(
              `SELECT id, quote_number, project_title, customer_name, status, total, currency,
                      valid_until, sent_at, updated_at
               FROM quotes
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY datetime(updated_at) DESC
               LIMIT ?`,
            )
            .all(...args) as Row[];
          return ok({ quotes, count: quotes.length });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── quote_get ────────────────────────────────────────────────────────
    {
      name: "quote_get",
      description:
        "Get full detail for one quote by id, including its line items.",
      category: "finance",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Quote id." } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const id = String(params.id ?? "");
          if (!id) return fail("id is required");
          const quote = db
            .prepare(`SELECT * FROM quotes WHERE id = ?`)
            .get(id) as Row | undefined;
          if (!quote) return fail(`No quote found for id "${id}"`);
          const lineItems = db
            .prepare(
              `SELECT * FROM quote_line_items WHERE quote_id = ? ORDER BY sort_order ASC, rowid ASC`,
            )
            .all(id) as Row[];
          return ok({ ...quote, line_items: lineItems });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── quote_create ─────────────────────────────────────────────────────
    {
      name: "quote_create",
      description:
        "Create a new draft quote for a job. Provide a project title, optional " +
        "customer details, and line items (description, quantity, unit cost, " +
        "kind). The draft appears in Henry's Quotes panel for review.",
      category: "finance",
      safetyLevel: "notify",
      confirmPrompt: (p) =>
        `Create a draft quote "${String(p.project_title)}"` +
        (p.customer_name ? ` for ${String(p.customer_name)}` : ""),
      inputSchema: {
        type: "object",
        properties: {
          project_title: {
            type: "string",
            description: "Title of the job/project.",
          },
          customer_name: { type: "string" },
          customer_email: { type: "string" },
          customer_phone: { type: "string" },
          tax_rate: {
            type: "number",
            description: "Tax rate as a percent, e.g. 8.5.",
          },
          notes: { type: "string" },
          line_items: {
            type: "array",
            description: "Line items for the quote.",
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: [
                    "material",
                    "labor",
                    "machine_time",
                    "setup",
                    "markup",
                    "discount",
                    "shipping",
                    "other",
                  ],
                },
                description: { type: "string" },
                quantity: { type: "number" },
                unit: { type: "string" },
                unit_cost: { type: "number" },
                taxable: { type: "boolean" },
              },
              required: ["description"],
            },
          },
        },
        required: ["project_title"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const projectTitle = String(params.project_title ?? "").trim();
          if (!projectTitle) return fail("project_title is required");

          const id = genId("quote");
          const quoteNumber = nextQuoteNumber(db);
          const now = new Date().toISOString();
          const validDays = 30;
          const validUntil = new Date(
            Date.now() + validDays * 86_400_000,
          ).toISOString();

          db.prepare(
            `INSERT INTO quotes (
               id, quote_number, project_title, customer_name, customer_email, customer_phone,
               status, tax_rate, currency, valid_days, valid_until, notes, created_at, updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            id,
            quoteNumber,
            projectTitle,
            params.customer_name ? String(params.customer_name) : null,
            params.customer_email ? String(params.customer_email) : null,
            params.customer_phone ? String(params.customer_phone) : null,
            "draft",
            num(params.tax_rate, 0),
            "USD",
            validDays,
            validUntil,
            params.notes ? String(params.notes) : null,
            now,
            now,
          );

          const items = Array.isArray(params.line_items)
            ? params.line_items
            : [];
          const insItem = db.prepare(
            `INSERT INTO quote_line_items (
               id, quote_id, kind, description, quantity, unit, unit_cost, taxable, sort_order
             ) VALUES (?,?,?,?,?,?,?,?,?)`,
          );
          items.forEach((raw, i) => {
            const it = (raw ?? {}) as Row;
            insItem.run(
              genId("qli"),
              id,
              it.kind ? String(it.kind) : "other",
              String(it.description ?? ""),
              num(it.quantity, 1),
              it.unit ? String(it.unit) : "ea",
              num(it.unit_cost, 0),
              it.taxable === false || it.taxable === 0 ? 0 : 1,
              i,
            );
          });

          recomputeTotals(db, id);

          const quote = db
            .prepare(`SELECT * FROM quotes WHERE id = ?`)
            .get(id) as Row;
          return ok({ id, quote_number: quoteNumber, quote });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── invoice_list ─────────────────────────────────────────────────────
    {
      name: "invoice_list",
      description:
        "List outstanding invoices with their amount and due date. (Until the " +
        "QuickBooks connector lands, invoices are derived from quotes that have " +
        "been sent or accepted — these are the current receivables.)",
      category: "finance",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (default 50)." },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const limit = Math.min(Number(params.limit) || 50, 200);
          const rows = db
            .prepare(
              `SELECT id, quote_number, project_title, customer_name, status,
                      total AS amount, currency, valid_until AS due_date, sent_at
               FROM quotes
               WHERE status IN ('sent','accepted')
               ORDER BY datetime(valid_until) ASC
               LIMIT ?`,
            )
            .all(limit) as Row[];
          const nowIso = new Date().toISOString();
          const invoices = rows.map((r) => ({
            ...r,
            overdue: r.due_date != null && String(r.due_date) < nowIso,
          }));
          return ok({
            source: "quotes (sent/accepted) — no dedicated invoices table yet",
            invoices,
            count: invoices.length,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── finance_summary ──────────────────────────────────────────────────
    {
      name: "finance_summary",
      description:
        "Summarize the money picture: revenue recorded this month, total " +
        "outstanding receivables, and how many receivables are overdue. Great " +
        "for a morning briefing.",
      category: "finance",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description: "Month as YYYY-MM (default: current month).",
          },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const month = params.month
            ? String(params.month)
            : new Date().toISOString().slice(0, 7);

          // Revenue this month: income transactions (memory.ts `transactions`).
          const incomeRow = db
            .prepare(
              `SELECT COALESCE(SUM(amount), 0) AS total
               FROM transactions
               WHERE type = 'income' AND date LIKE ?`,
            )
            .get(`${month}%`) as { total?: number };
          const revenueThisMonth = num(incomeRow?.total, 0);

          // Outstanding receivables: quotes in a billable state.
          const recvRow = db
            .prepare(
              `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS count
               FROM quotes WHERE status IN ('sent','accepted')`,
            )
            .get() as { total?: number; count?: number };

          // Overdue: billable quotes past their valid_until date.
          const nowIso = new Date().toISOString();
          const overdueRow = db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM quotes
               WHERE status IN ('sent','accepted') AND valid_until IS NOT NULL AND valid_until < ?`,
            )
            .get(nowIso) as { count?: number };

          return ok({
            month,
            revenueThisMonth: Math.round(revenueThisMonth * 100) / 100,
            outstandingReceivables:
              Math.round(num(recvRow?.total, 0) * 100) / 100,
            openReceivableCount: num(recvRow?.count, 0),
            overdueCount: num(overdueRow?.count, 0),
            note: "Receivables derived from sent/accepted quotes pending the QuickBooks connector.",
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
