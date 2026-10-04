/**
 * Quoting — generate professional quotes for maker / freelance work.
 *
 * A quote is the first half of a job's lifecycle:
 *   Quote (draft) → Quote (sent) → Quote (accepted) → Production Run → Invoice
 *
 * Line items can be of several kinds — material, labor, machine_time, setup,
 * markup, discount, or freeform — so the same panel handles a 3D-print quote,
 * an embroidery batch, a website redesign, or a mixed bundle.
 *
 * Tax: stored as a single rate (percent), applied to the taxable subtotal.
 * Discount line items are negative; markup is positive.
 *
 * AI-friendly aggregations: `quote:summary` returns 30/90-day pipeline value
 * and conversion rate, so Henry can answer "how's my quote pipeline?" with
 * zero AI cost.
 *
 * Persistence: SQLite, two tables joined by quote_id.
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';

let db: Database.Database;

type Row = Record<string, unknown>;

function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function genId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate the next quote number in the form Q-YYYY-NNNN.
 * NNNN auto-increments per calendar year.
 */
function nextQuoteNumber(): string {
  const year = new Date().getFullYear();
  const prefix = `Q-${year}-`;
  const row = db
    .prepare(
      `SELECT quote_number FROM quotes WHERE quote_number LIKE ? ORDER BY quote_number DESC LIMIT 1`,
    )
    .get(`${prefix}%`) as { quote_number?: string } | undefined;
  let next = 1;
  if (row?.quote_number) {
    const tail = row.quote_number.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}

function recomputeTotals(quoteId: string) {
  const items = db
    .prepare(
      `SELECT kind, quantity, unit_cost, line_total, taxable
       FROM quote_line_items WHERE quote_id=?`,
    )
    .all(quoteId) as Array<Row>;

  let taxable = 0;
  let nonTaxable = 0;
  for (const it of items) {
    // line_total takes priority if explicitly stored, otherwise computed
    const total =
      it.line_total !== null && it.line_total !== undefined
        ? num(it.line_total)
        : num(it.quantity, 1) * num(it.unit_cost, 0);
    if (Number(it.taxable) === 1) taxable += total;
    else nonTaxable += total;
  }

  const quote = db
    .prepare(`SELECT tax_rate FROM quotes WHERE id=?`)
    .get(quoteId) as { tax_rate?: number } | undefined;
  const taxRate = num(quote?.tax_rate, 0);
  const subtotal = taxable + nonTaxable;
  const taxAmount = taxable * (taxRate / 100);
  const total = subtotal + taxAmount;

  db.prepare(
    `UPDATE quotes SET subtotal=?, tax_amount=?, total=?, updated_at=datetime('now') WHERE id=?`,
  ).run(
    Math.round(subtotal * 100) / 100,
    Math.round(taxAmount * 100) / 100,
    Math.round(total * 100) / 100,
    quoteId,
  );
}

export function registerQuotingHandlers(database: Database.Database) {
  db = database;

  // ── Schema ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      quote_number TEXT UNIQUE,
      project_title TEXT NOT NULL,
      customer_id TEXT,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      customer_company TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','sent','accepted','declined','expired')),
      subtotal REAL DEFAULT 0,
      tax_rate REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      valid_days INTEGER DEFAULT 30,
      valid_until TEXT,
      terms TEXT,
      notes TEXT,
      sent_at TEXT,
      decided_at TEXT,
      converted_run_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
    CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes(customer_id);

    CREATE TABLE IF NOT EXISTS quote_line_items (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other'
        CHECK(kind IN ('material','labor','machine_time','setup','markup','discount','shipping','other')),
      description TEXT NOT NULL,
      quantity REAL DEFAULT 1,
      unit TEXT DEFAULT 'ea',
      unit_cost REAL DEFAULT 0,
      line_total REAL,
      taxable INTEGER DEFAULT 1,
      machine_id TEXT,
      material_id TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_qli_quote ON quote_line_items(quote_id, sort_order);
  `);

  // ── Quotes CRUD ────────────────────────────────────────────────────────

  ipcMain.handle('quote:list', (_e, opts?: { status?: string; query?: string; limit?: number }) => {
    try {
      const where: string[] = [];
      const args: unknown[] = [];
      if (opts?.status) {
        where.push('status=?');
        args.push(opts.status);
      }
      if (opts?.query?.trim()) {
        where.push(
          '(project_title LIKE ? OR customer_name LIKE ? OR customer_company LIKE ? OR quote_number LIKE ?)',
        );
        const like = `%${opts.query.trim()}%`;
        args.push(like, like, like, like);
      }
      const sql = `
        SELECT id, quote_number, project_title, customer_name, customer_company,
               status, total, currency, valid_until, sent_at, created_at, updated_at
        FROM quotes
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY datetime(updated_at) DESC
        LIMIT ?`;
      args.push(opts?.limit ?? 200);
      return db.prepare(sql).all(...args);
    } catch (e) {
      console.error('quote:list', e);
      return [];
    }
  });

  ipcMain.handle('quote:get', (_e, id: string) => {
    try {
      const q = db.prepare(`SELECT * FROM quotes WHERE id=?`).get(id);
      if (!q) return null;
      const items = db
        .prepare(
          `SELECT * FROM quote_line_items WHERE quote_id=? ORDER BY sort_order ASC, rowid ASC`,
        )
        .all(id);
      return { ...q, line_items: items };
    } catch (e) {
      console.error('quote:get', e);
      return null;
    }
  });

  ipcMain.handle('quote:save', (_e, q: Row) => {
    try {
      const now = new Date().toISOString();
      const id = (q.id as string) || genId('quote');
      const existing = q.id
        ? (db.prepare(`SELECT id FROM quotes WHERE id=?`).get(q.id) as Row | undefined)
        : undefined;

      // Compute valid_until from valid_days if not given
      let validUntil = str(q.valid_until);
      if (!validUntil && q.valid_days) {
        const d = new Date();
        d.setDate(d.getDate() + Number(q.valid_days));
        validUntil = d.toISOString();
      }

      const quoteNumber = (q.quote_number as string) || (existing ? null : nextQuoteNumber());

      if (existing) {
        db.prepare(
          `UPDATE quotes SET
             project_title=?, customer_id=?, customer_name=?, customer_email=?,
             customer_phone=?, customer_company=?, status=?, tax_rate=?,
             currency=?, valid_days=?, valid_until=?, terms=?, notes=?,
             updated_at=?
           WHERE id=?`,
        ).run(
          str(q.project_title) || 'Untitled quote',
          str(q.customer_id),
          str(q.customer_name),
          str(q.customer_email),
          str(q.customer_phone),
          str(q.customer_company),
          str(q.status) || 'draft',
          num(q.tax_rate, 0),
          str(q.currency) || 'USD',
          num(q.valid_days, 30),
          validUntil,
          str(q.terms),
          str(q.notes),
          now,
          id,
        );
      } else {
        db.prepare(
          `INSERT INTO quotes (
             id, quote_number, project_title, customer_id, customer_name,
             customer_email, customer_phone, customer_company, status,
             tax_rate, currency, valid_days, valid_until, terms, notes,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          quoteNumber,
          str(q.project_title) || 'Untitled quote',
          str(q.customer_id),
          str(q.customer_name),
          str(q.customer_email),
          str(q.customer_phone),
          str(q.customer_company),
          str(q.status) || 'draft',
          num(q.tax_rate, 0),
          str(q.currency) || 'USD',
          num(q.valid_days, 30),
          validUntil,
          str(q.terms),
          str(q.notes),
          now,
          now,
        );
      }

      recomputeTotals(id);
      return { ok: true, id };
    } catch (e) {
      console.error('quote:save', e);
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('quote:delete', (_e, id: string) => {
    try {
      db.prepare(`DELETE FROM quote_line_items WHERE quote_id=?`).run(id);
      db.prepare(`DELETE FROM quotes WHERE id=?`).run(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('quote:setStatus', (_e, id: string, status: string) => {
    try {
      const valid = ['draft', 'sent', 'accepted', 'declined', 'expired'];
      if (!valid.includes(status)) return { ok: false, error: 'invalid status' };
      const now = new Date().toISOString();
      const isDecision = status === 'accepted' || status === 'declined';
      const isSend = status === 'sent';
      db.prepare(
        `UPDATE quotes SET
           status=?,
           sent_at=COALESCE(sent_at, CASE WHEN ?=1 THEN ? ELSE NULL END),
           decided_at=CASE WHEN ?=1 THEN ? ELSE decided_at END,
           updated_at=?
         WHERE id=?`,
      ).run(status, isSend ? 1 : 0, now, isDecision ? 1 : 0, now, now, id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('quote:duplicate', (_e, id: string) => {
    try {
      const orig = db.prepare(`SELECT * FROM quotes WHERE id=?`).get(id) as Row | undefined;
      if (!orig) return { ok: false, error: 'not found' };
      const newId = genId('quote');
      const newNum = nextQuoteNumber();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO quotes (
           id, quote_number, project_title, customer_id, customer_name,
           customer_email, customer_phone, customer_company, status,
           tax_rate, currency, valid_days, terms, notes, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        newId,
        newNum,
        `${orig.project_title} (copy)`,
        orig.customer_id || null,
        orig.customer_name || null,
        orig.customer_email || null,
        orig.customer_phone || null,
        orig.customer_company || null,
        'draft',
        orig.tax_rate || 0,
        orig.currency || 'USD',
        orig.valid_days || 30,
        orig.terms || null,
        orig.notes || null,
        now,
        now,
      );
      // Copy line items
      const items = db
        .prepare(`SELECT * FROM quote_line_items WHERE quote_id=? ORDER BY sort_order`)
        .all(id) as Array<Row>;
      const insItem = db.prepare(
        `INSERT INTO quote_line_items (
           id, quote_id, kind, description, quantity, unit, unit_cost,
           line_total, taxable, machine_id, material_id, sort_order
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const it of items) {
        insItem.run(
          genId('qli'),
          newId,
          it.kind,
          it.description,
          it.quantity,
          it.unit,
          it.unit_cost,
          it.line_total ?? null,
          it.taxable ?? 1,
          it.machine_id ?? null,
          it.material_id ?? null,
          it.sort_order ?? 0,
        );
      }
      recomputeTotals(newId);
      return { ok: true, id: newId };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // ── Line items ─────────────────────────────────────────────────────────

  ipcMain.handle('quote:lineItem:save', (_e, item: Row) => {
    try {
      const id = (item.id as string) || genId('qli');
      const quoteId = item.quote_id as string;
      if (!quoteId) return { ok: false, error: 'quote_id required' };

      const exists = db
        .prepare(`SELECT id FROM quote_line_items WHERE id=?`)
        .get(id) as Row | undefined;

      // line_total is derived unless explicitly provided
      const computedTotal =
        item.line_total !== undefined && item.line_total !== null && item.line_total !== ''
          ? num(item.line_total)
          : num(item.quantity, 1) * num(item.unit_cost, 0);

      if (exists) {
        db.prepare(
          `UPDATE quote_line_items SET
             kind=?, description=?, quantity=?, unit=?, unit_cost=?,
             line_total=?, taxable=?, machine_id=?, material_id=?, sort_order=?
           WHERE id=?`,
        ).run(
          str(item.kind) || 'other',
          str(item.description) || '',
          num(item.quantity, 1),
          str(item.unit) || 'ea',
          num(item.unit_cost, 0),
          Math.round(computedTotal * 100) / 100,
          item.taxable === false || item.taxable === 0 ? 0 : 1,
          str(item.machine_id),
          str(item.material_id),
          num(item.sort_order, 0),
          id,
        );
      } else {
        db.prepare(
          `INSERT INTO quote_line_items (
             id, quote_id, kind, description, quantity, unit, unit_cost,
             line_total, taxable, machine_id, material_id, sort_order
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          quoteId,
          str(item.kind) || 'other',
          str(item.description) || '',
          num(item.quantity, 1),
          str(item.unit) || 'ea',
          num(item.unit_cost, 0),
          Math.round(computedTotal * 100) / 100,
          item.taxable === false || item.taxable === 0 ? 0 : 1,
          str(item.machine_id),
          str(item.material_id),
          num(item.sort_order, 0),
        );
      }

      recomputeTotals(quoteId);
      return { ok: true, id };
    } catch (e) {
      console.error('quote:lineItem:save', e);
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('quote:lineItem:delete', (_e, id: string) => {
    try {
      const row = db
        .prepare(`SELECT quote_id FROM quote_line_items WHERE id=?`)
        .get(id) as Row | undefined;
      db.prepare(`DELETE FROM quote_line_items WHERE id=?`).run(id);
      if (row?.quote_id) recomputeTotals(row.quote_id as string);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('quote:lineItems:reorder', (_e, quoteId: string, ids: string[]) => {
    try {
      const upd = db.prepare(`UPDATE quote_line_items SET sort_order=? WHERE id=? AND quote_id=?`);
      const tx = db.transaction((ordered: string[]) => {
        ordered.forEach((id, i) => upd.run(i, id, quoteId));
      });
      tx(ids);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // ── Aggregations (zero-AI-cost) ────────────────────────────────────────

  ipcMain.handle('quote:summary', (_e, opts?: { sinceDays?: number }) => {
    try {
      const days = opts?.sinceDays ?? 90;
      const since = new Date();
      since.setDate(since.getDate() - days);
      const sinceIso = since.toISOString();

      const rows = db
        .prepare(
          `SELECT status, COUNT(*) AS count, COALESCE(SUM(total),0) AS value
           FROM quotes
           WHERE datetime(created_at) >= datetime(?)
           GROUP BY status`,
        )
        .all(sinceIso) as Array<Row>;

      const byStatus: Record<string, { count: number; value: number }> = {
        draft: { count: 0, value: 0 },
        sent: { count: 0, value: 0 },
        accepted: { count: 0, value: 0 },
        declined: { count: 0, value: 0 },
        expired: { count: 0, value: 0 },
      };
      for (const r of rows) {
        byStatus[String(r.status)] = {
          count: Number(r.count) || 0,
          value: Number(r.value) || 0,
        };
      }

      const totalSent =
        byStatus.sent.count + byStatus.accepted.count + byStatus.declined.count +
        byStatus.expired.count;
      const conversionRate =
        totalSent > 0 ? Math.round((byStatus.accepted.count / totalSent) * 100) : 0;

      return {
        sinceDays: days,
        byStatus,
        pipelineValue: byStatus.draft.value + byStatus.sent.value,
        wonValue: byStatus.accepted.value,
        conversionRate,
      };
    } catch (e) {
      console.error('quote:summary', e);
      return null;
    }
  });

  // ── Convert quote → production run ─────────────────────────────────────
  // Light coupling: reads materials_used JSON style used by ProductionRunsPanel.
  ipcMain.handle('quote:convertToRun', (_e, quoteId: string, machineId?: string) => {
    try {
      const q = db.prepare(`SELECT * FROM quotes WHERE id=?`).get(quoteId) as Row | undefined;
      if (!q) return { ok: false, error: 'quote not found' };

      const items = db
        .prepare(`SELECT * FROM quote_line_items WHERE quote_id=? ORDER BY sort_order ASC`)
        .all(quoteId) as Array<Row>;

      // Build a materials_used JSON line-item array from material kind items
      const materialItems = items
        .filter((it) => it.kind === 'material')
        .map((it) => ({
          description: it.description,
          quantity: num(it.quantity, 1),
          unit: it.unit || 'ea',
          unit_cost: num(it.unit_cost, 0),
        }));

      const laborCost = items
        .filter((it) => it.kind === 'labor' || it.kind === 'setup')
        .reduce(
          (s, it) =>
            s +
            (it.line_total !== null && it.line_total !== undefined
              ? num(it.line_total)
              : num(it.quantity, 1) * num(it.unit_cost, 0)),
          0,
        );

      const materialCost = items
        .filter((it) => it.kind === 'material')
        .reduce(
          (s, it) =>
            s +
            (it.line_total !== null && it.line_total !== undefined
              ? num(it.line_total)
              : num(it.quantity, 1) * num(it.unit_cost, 0)),
          0,
        );

      const runId = genId('run');
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO production_runs (
           id, machine_id, project_name, customer_name, status,
           material_cost, labor_cost, revenue, materials_used, notes,
           started_at, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        runId,
        machineId || null,
        q.project_title,
        q.customer_name || null,
        'queued',
        Math.round(materialCost * 100) / 100,
        Math.round(laborCost * 100) / 100,
        Math.round(num(q.total, 0) * 100) / 100,
        JSON.stringify(materialItems),
        q.notes || `Converted from quote ${q.quote_number}`,
        now,
        now,
        now,
      );

      db.prepare(
        `UPDATE quotes SET converted_run_id=?, status='accepted', decided_at=COALESCE(decided_at, ?), updated_at=? WHERE id=?`,
      ).run(runId, now, now, quoteId);

      return { ok: true, runId };
    } catch (e) {
      console.error('quote:convertToRun', e);
      return { ok: false, error: String(e) };
    }
  });

  // ── Markdown export ────────────────────────────────────────────────────
  // Returns plain markdown the renderer can copy or save.
  ipcMain.handle('quote:exportMarkdown', (_e, quoteId: string) => {
    try {
      const q = db.prepare(`SELECT * FROM quotes WHERE id=?`).get(quoteId) as Row | undefined;
      if (!q) return null;
      const items = db
        .prepare(`SELECT * FROM quote_line_items WHERE quote_id=? ORDER BY sort_order ASC, rowid ASC`)
        .all(quoteId) as Array<Row>;

      const cur = (n: number) =>
        new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: (q.currency as string) || 'USD',
        }).format(n);

      const lines: string[] = [];
      lines.push(`# Quote ${q.quote_number || ''}`);
      lines.push('');
      lines.push(`**Project:** ${q.project_title}`);
      if (q.customer_name) lines.push(`**Customer:** ${q.customer_name}${q.customer_company ? ` (${q.customer_company})` : ''}`);
      if (q.customer_email) lines.push(`**Email:** ${q.customer_email}`);
      if (q.valid_until) lines.push(`**Valid until:** ${new Date(q.valid_until as string).toLocaleDateString()}`);
      lines.push('');
      lines.push('| # | Description | Qty | Unit | Unit cost | Line total |');
      lines.push('|---|---|---:|---|---:|---:|');
      items.forEach((it, i) => {
        const lt =
          it.line_total !== null && it.line_total !== undefined
            ? num(it.line_total)
            : num(it.quantity, 1) * num(it.unit_cost, 0);
        lines.push(
          `| ${i + 1} | ${(it.kind as string).toUpperCase()} — ${it.description} | ${num(
            it.quantity,
            1,
          )} | ${it.unit || 'ea'} | ${cur(num(it.unit_cost, 0))} | ${cur(lt)} |`,
        );
      });
      lines.push('');
      lines.push(`**Subtotal:** ${cur(num(q.subtotal, 0))}`);
      if (num(q.tax_rate, 0) > 0) {
        lines.push(`**Tax (${num(q.tax_rate, 0)}%):** ${cur(num(q.tax_amount, 0))}`);
      }
      lines.push(`**Total:** ${cur(num(q.total, 0))}`);
      lines.push('');
      if (q.terms) {
        lines.push('## Terms');
        lines.push(String(q.terms));
        lines.push('');
      }
      if (q.notes) {
        lines.push('## Notes');
        lines.push(String(q.notes));
      }
      return lines.join('\n');
    } catch (e) {
      console.error('quote:exportMarkdown', e);
      return null;
    }
  });
}
