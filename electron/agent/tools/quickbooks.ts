/**
 * QuickBooks Online tools — Henry's accounting connector (design §4.4, Sprint 4).
 *
 * Henry already had a CSV export path (see the QuickBooks branch in
 * `syncBridge.ts`). This kit adds the live QuickBooks Online REST API on top:
 * OAuth2 token storage, invoice sync into a local cache, and a draft-invoice
 * push from a Henry quote.
 *
 * Safety tiers (design §5):
 *   - qb_auth_status   silent  — read connection state
 *   - qb_get_balance   silent  — read local invoice cache, no API call
 *   - qb_sync_invoices notify  — writes to Henry's own data (the cache)
 *   - qb_create_invoice confirm — pushes value OUT to QuickBooks
 *   - qb_open_auth      silent  — just opens a URL in the browser
 *
 * Credential model: the OAuth token set is stored in the `settings` table under
 * `qb_oauth`, encrypted at rest via the same safeStorage helper used for API
 * keys (`_keyStorage.ts`). The client id/secret the user pastes from their
 * Intuit developer app live in `qb_client_id` / `qb_client_secret`. If nothing
 * is configured, every tool returns a friendly "not connected — use qb_open_auth"
 * message instead of throwing, so the model can relay it cleanly.
 */

import { shell } from "electron";
import type Database from "better-sqlite3";
import type { ToolDefinition, ToolResult, AgentContext } from "../types";
import { encryptKey, decryptKey } from "../../ipc/_keyStorage";

type Row = Record<string, unknown>;

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

/** Standard "QB isn't set up" payload — returned as a successful read so the
 *  model relays the guidance rather than treating it as a hard error. */
function notConnected(): ToolResult {
  return ok({
    connected: false,
    status: "not_configured",
    message:
      "QuickBooks not connected — use qb_open_auth to connect, then run qb_sync_invoices.",
  });
}

// ── Settings helpers ─────────────────────────────────────────────────────────

function getSetting(db: Database.Database, key: string): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? "";
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

// ── OAuth token storage ──────────────────────────────────────────────────────

interface QBTokenSet {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  /** epoch ms */
  expiresAt: number;
}

function readTokens(db: Database.Database): QBTokenSet | null {
  const stored = getSetting(db, "qb_oauth");
  if (!stored) return null;
  try {
    const json = decryptKey(stored);
    if (!json) return null;
    const t = JSON.parse(json) as Partial<QBTokenSet>;
    if (!t.accessToken || !t.realmId) return null;
    return {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken ?? "",
      realmId: t.realmId,
      expiresAt: Number(t.expiresAt) || 0,
    };
  } catch {
    return null;
  }
}

function writeTokens(db: Database.Database, tokens: QBTokenSet): void {
  setSetting(db, "qb_oauth", encryptKey(JSON.stringify(tokens)));
}

/** Sandbox unless the user has flipped qb_environment to "production". */
function apiBase(db: Database.Database): string {
  const env = getSetting(db, "qb_environment") || "sandbox";
  return env === "production"
    ? "https://quickbooks.api.intuit.com/v3/company/"
    : "https://sandbox-quickbooks.api.intuit.com/v3/company/";
}

const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const AUTHORIZE_ENDPOINT = "https://appcenter.intuit.com/connect/oauth2";
const OAUTH_SCOPE = "com.intuit.quickbooks.accounting";
/** Loopback redirect — pair with a desktop OAuth client, mirrors googleAuth.ts. */
const REDIRECT_URI = "http://127.0.0.1:9006/callback";

// ── Token refresh ────────────────────────────────────────────────────────────

/**
 * Refresh the access token using the stored refresh token. Returns the fresh
 * token set (already persisted) or null if refresh isn't possible/failed.
 */
async function refreshAccessToken(db: Database.Database, tokens: QBTokenSet): Promise<QBTokenSet | null> {
  const clientId = getSetting(db, "qb_client_id");
  const clientSecret = decryptKey(getSetting(db, "qb_client_secret"));
  if (!clientId || !clientSecret || !tokens.refreshToken) return null;

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }).toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) return null;
    const fresh: QBTokenSet = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      realmId: tokens.realmId,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
    writeTokens(db, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/**
 * Return a usable access token, refreshing first if it's within 60s of expiry.
 * Null means "can't authenticate" (no creds, or refresh failed).
 */
async function ensureToken(db: Database.Database): Promise<QBTokenSet | null> {
  let tokens = readTokens(db);
  if (!tokens) return null;
  if (Date.now() >= tokens.expiresAt - 60_000) {
    const refreshed = await refreshAccessToken(db, tokens);
    if (refreshed) tokens = refreshed;
    // If refresh failed but the old token might still be valid, fall through and
    // let the API 401 surface — qbRequest retries the refresh on a 401 too.
  }
  return tokens;
}

// ── Authenticated QB API request (with one 401→refresh→retry) ────────────────

async function qbRequest(
  db: Database.Database,
  pathAndQuery: string,
  init: RequestInit = {},
  _retried = false,
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const tokens = await ensureToken(db);
  if (!tokens) return { ok: false, status: 0, error: "not_connected" };

  const url = apiBase(db) + tokens.realmId + "/" + pathAndQuery;
  // Hard timeout so a stalled QuickBooks API can't hang the agent/tool call.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    // Token expired mid-flight — refresh once and retry.
    if (res.status === 401 && !_retried) {
      const refreshed = await refreshAccessToken(db, tokens);
      if (refreshed) return qbRequest(db, pathAndQuery, init, true);
    }

    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: `QuickBooks API HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    const aborted = e instanceof Error && /abort/i.test(e.message);
    return { ok: false, status: 0, error: aborted ? 'QuickBooks request timed out.' : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── QB shapes (only the fields we read) ──────────────────────────────────────

interface QBInvoice {
  Id?: string;
  DocNumber?: string;
  TotalAmt?: number;
  Balance?: number;
  DueDate?: string;
  TxnDate?: string;
  CustomerRef?: { name?: string; value?: string };
}

function classifyStatus(balance: number, dueDate: string | undefined): string {
  if (balance <= 0) return "paid";
  if (dueDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (dueDate < today) return "overdue";
  }
  return "open";
}

// ── Tools ────────────────────────────────────────────────────────────────────

export function quickbooksTools(): ToolDefinition[] {
  return [
    // ── qb_auth_status ───────────────────────────────────────────────────────
    {
      name: "qb_auth_status",
      description:
        "Check whether QuickBooks Online is connected. Returns connected, " +
        "expired (token present but stale — a sync will auto-refresh), or " +
        "not_configured (no connection yet — use qb_open_auth).",
      category: "finance",
      safetyLevel: "silent",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, { db }: AgentContext) {
        const tokens = readTokens(db);
        if (!tokens) return notConnected();
        const expired = Date.now() >= tokens.expiresAt;
        return ok({
          connected: !expired,
          status: expired ? "expired" : "connected",
          realmId: tokens.realmId,
          environment: getSetting(db, "qb_environment") || "sandbox",
          expiresAt: new Date(tokens.expiresAt).toISOString(),
          message: expired
            ? "QuickBooks token expired — the next sync will try to refresh it automatically."
            : "QuickBooks is connected.",
        });
      },
    },

    // ── qb_sync_invoices ─────────────────────────────────────────────────────
    {
      name: "qb_sync_invoices",
      description:
        "Pull invoices from the last 90 days from QuickBooks Online and update " +
        "Henry's local invoice cache. Run this before asking about balances so " +
        "the numbers are current.",
      category: "finance",
      safetyLevel: "notify",
      confirmPrompt: () => "Sync recent invoices from QuickBooks Online",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, { db }: AgentContext) {
        if (!readTokens(db)) return notConnected();

        const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
        // QBO query language; ORDER BY keeps results stable. Single-quotes per QBO spec.
        const query =
          `SELECT * FROM Invoice WHERE TxnDate >= '${since}' ORDER BY TxnDate DESC MAXRESULTS 1000`;
        const res = await qbRequest(db, "query?query=" + encodeURIComponent(query));

        if (!res.ok) {
          if (res.error === "not_connected") return notConnected();
          return fail(res.error || "QuickBooks sync failed", res.status === 0 || res.status >= 500);
        }

        const payload = res.data as { QueryResponse?: { Invoice?: QBInvoice[] } } | undefined;
        const invoices = payload?.QueryResponse?.Invoice ?? [];

        const upsert = db.prepare(
          `INSERT INTO invoices (id, qbId, clientName, amount, amountPaid, status, dueDate, issueDate, syncedAt)
           VALUES (@id, @qbId, @clientName, @amount, @amountPaid, @status, @dueDate, @issueDate, datetime('now'))
           ON CONFLICT(qbId) DO UPDATE SET
             clientName = excluded.clientName,
             amount     = excluded.amount,
             amountPaid = excluded.amountPaid,
             status     = excluded.status,
             dueDate    = excluded.dueDate,
             issueDate  = excluded.issueDate,
             syncedAt   = datetime('now')`,
        );

        let synced = 0;
        const tx = db.transaction((list: QBInvoice[]) => {
          for (const inv of list) {
            if (!inv.Id) continue;
            const amount = Number(inv.TotalAmt) || 0;
            const balance = Number(inv.Balance) || 0;
            upsert.run({
              id: `qbinv_${inv.Id}`,
              qbId: inv.Id,
              clientName: inv.CustomerRef?.name ?? null,
              amount,
              amountPaid: Math.max(0, amount - balance),
              status: classifyStatus(balance, inv.DueDate),
              dueDate: inv.DueDate ?? null,
              issueDate: inv.TxnDate ?? null,
            });
            synced++;
          }
        });
        tx(invoices);

        return ok({ synced, since, message: `Synced ${synced} invoice(s) from QuickBooks.` });
      },
    },

    // ── qb_get_balance ───────────────────────────────────────────────────────
    {
      name: "qb_get_balance",
      description:
        "Return total outstanding receivables and the overdue amount from " +
        "Henry's local invoice cache (no API call). Run qb_sync_invoices first " +
        "if you need fresh figures. Great for a morning briefing.",
      category: "finance",
      safetyLevel: "silent",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, { db }: AgentContext) {
        const row = db
          .prepare(
            `SELECT
               COALESCE(SUM(amount - amountPaid), 0) AS outstanding,
               COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount - amountPaid ELSE 0 END), 0) AS overdue,
               COUNT(*) AS total,
               SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) AS overdueCount,
               MAX(syncedAt) AS lastSyncedAt
             FROM invoices
             WHERE status != 'paid'`,
          )
          .get() as Row;

        const round = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
        return ok({
          outstandingReceivables: round(row.outstanding),
          overdueAmount: round(row.overdue),
          openInvoiceCount: Number(row.total) || 0,
          overdueCount: Number(row.overdueCount) || 0,
          lastSyncedAt: row.lastSyncedAt ?? null,
          note: row.lastSyncedAt
            ? undefined
            : "No invoices cached yet — run qb_sync_invoices to pull them from QuickBooks.",
        });
      },
    },

    // ── qb_create_invoice ────────────────────────────────────────────────────
    {
      name: "qb_create_invoice",
      description:
        "Push a Henry quote to QuickBooks Online as a new invoice. Provide the " +
        "quoteId. Henry looks up the quote's line items and customer, finds or " +
        "creates the matching QuickBooks customer, and creates the invoice.",
      category: "finance",
      safetyLevel: "confirm",
      confirmPrompt: (p) => `Create a QuickBooks invoice from quote ${String(p.quoteId)}`,
      inputSchema: {
        type: "object",
        properties: {
          quoteId: { type: "string", description: "The Henry quote id to invoice." },
        },
        required: ["quoteId"],
        additionalProperties: false,
      },
      async execute(params, { db }: AgentContext) {
        if (!readTokens(db)) return notConnected();

        const quoteId = String(params.quoteId ?? "").trim();
        if (!quoteId) return fail("quoteId is required");

        const quote = db.prepare(`SELECT * FROM quotes WHERE id = ?`).get(quoteId) as Row | undefined;
        if (!quote) return fail(`No quote found for id "${quoteId}"`);

        const lineItems = db
          .prepare(
            `SELECT description, quantity, unit_cost, line_total
             FROM quote_line_items WHERE quote_id = ? ORDER BY sort_order ASC, rowid ASC`,
          )
          .all(quoteId) as Row[];
        if (lineItems.length === 0) {
          return fail("Quote has no line items to invoice.");
        }

        const customerName = String(quote.customer_name ?? "").trim() || "Henry Customer";

        // 1. Resolve the QuickBooks customer (find by exact DisplayName, else create).
        const customerId = await resolveCustomerId(db, customerName);
        if (!customerId.ok) {
          if (customerId.error === "not_connected") return notConnected();
          return fail(customerId.error || "Could not resolve QuickBooks customer.");
        }

        // 2. Build the invoice payload from the quote's line items.
        const lines = lineItems.map((it) => {
          const qty = Number(it.quantity) || 1;
          const rate = Number(it.unit_cost) || 0;
          const amount =
            it.line_total !== null && it.line_total !== undefined
              ? Number(it.line_total) || 0
              : Math.round(qty * rate * 100) / 100;
          return {
            DetailType: "SalesItemLineDetail",
            Amount: amount,
            Description: String(it.description ?? ""),
            SalesItemLineDetail: {
              Qty: qty,
              UnitPrice: rate,
            },
          };
        });

        const invoicePayload = {
          CustomerRef: { value: customerId.value },
          Line: lines,
          // Carry the Henry quote number through so the two systems reconcile.
          ...(quote.quote_number ? { DocNumber: String(quote.quote_number).slice(0, 21) } : {}),
        };

        const res = await qbRequest(db, "invoice", {
          method: "POST",
          body: JSON.stringify(invoicePayload),
        });
        if (!res.ok) {
          if (res.error === "not_connected") return notConnected();
          return fail(
            `QuickBooks rejected the invoice: ${describeQbError(res.data) || res.error}`,
            res.status === 0 || res.status >= 500,
          );
        }

        const created = (res.data as { Invoice?: QBInvoice } | undefined)?.Invoice;
        return ok({
          created: true,
          quoteId,
          qbInvoiceId: created?.Id,
          docNumber: created?.DocNumber,
          total: created?.TotalAmt,
          customer: customerName,
          message: `Created QuickBooks invoice ${created?.DocNumber ?? created?.Id ?? ""} for ${customerName}.`,
        });
      },
    },

    // ── qb_open_auth ─────────────────────────────────────────────────────────
    {
      name: "qb_open_auth",
      description:
        "Open the QuickBooks Online connection flow in the system browser so " +
        "the user can authorize Henry. Use this when QuickBooks is not " +
        "connected.",
      category: "finance",
      safetyLevel: "silent",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, { db }: AgentContext) {
        const clientId = getSetting(db, "qb_client_id");
        if (!clientId) {
          // No developer app configured yet — send the user where they set one up.
          const setupUrl = "https://developer.intuit.com/app/developer/myapps";
          await shell.openExternal(setupUrl);
          return ok({
            opened: setupUrl,
            message:
              "QuickBooks isn't set up yet. Opened the Intuit developer console — create an app, " +
              "then paste its Client ID/Secret into Henry's Settings → Integrations → QuickBooks.",
          });
        }

        // Build the OAuth2 authorize URL. `state` is a CSRF nonce echoed back on
        // the loopback callback (handled by the integration settings flow).
        const state = `henry_${Date.now().toString(36)}`;
        const authUrl =
          `${AUTHORIZE_ENDPOINT}?` +
          new URLSearchParams({
            client_id: clientId,
            response_type: "code",
            scope: OAUTH_SCOPE,
            redirect_uri: REDIRECT_URI,
            state,
          }).toString();

        await shell.openExternal(authUrl);
        return ok({
          opened: authUrl,
          message: "Opened the QuickBooks authorization page in your browser.",
        });
      },
    },
  ];
}

// ── Helpers used by tools above ──────────────────────────────────────────────

/** Find a QuickBooks customer by exact DisplayName, creating one if absent. */
async function resolveCustomerId(
  db: Database.Database,
  displayName: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  // Escape for the QBO query string: backslashes first, then single quotes,
  // so a name containing a backslash before a quote (e.g. "O\\'Brien") can't
  // break out of the literal. Order matters — escaping quotes first would
  // double-escape the backslash this step then adds.
  const safeName = displayName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = `SELECT * FROM Customer WHERE DisplayName = '${safeName}'`;
  const found = await qbRequest(db, "query?query=" + encodeURIComponent(query));
  if (!found.ok) return { ok: false, error: found.error || "customer lookup failed" };

  const existing = (found.data as { QueryResponse?: { Customer?: Array<{ Id?: string }> } } | undefined)
    ?.QueryResponse?.Customer?.[0];
  if (existing?.Id) return { ok: true, value: existing.Id };

  // Create a minimal customer.
  const created = await qbRequest(db, "customer", {
    method: "POST",
    body: JSON.stringify({ DisplayName: displayName }),
  });
  if (!created.ok) {
    return { ok: false, error: describeQbError(created.data) || created.error || "customer create failed" };
  }
  const newId = (created.data as { Customer?: { Id?: string } } | undefined)?.Customer?.Id;
  if (!newId) return { ok: false, error: "QuickBooks did not return a customer id" };
  return { ok: true, value: newId };
}

/** Pull the human-readable message out of a QBO Fault response, if present. */
function describeQbError(data: unknown): string {
  const fault = (data as { Fault?: { Error?: Array<{ Message?: string; Detail?: string }> } } | undefined)
    ?.Fault?.Error?.[0];
  if (!fault) return "";
  return [fault.Message, fault.Detail].filter(Boolean).join(" — ");
}
