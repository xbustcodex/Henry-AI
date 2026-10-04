/**
 * Memory tools — Henry's recall layer over the existing SQLite schema in
 * `electron/ipc/database.ts` and `electron/ipc/memory.ts`.
 *
 * Reads are `silent` (logged, never interrupt the user). Writes are `notify`
 * (executed immediately, then a toast confirms what changed), per design §5.
 *
 * Note on terminology: the design doc says "client"; the live schema models
 * people in the `contacts` table, so `memory_read_client` reads from there.
 * Projects/commitments are not foreign-keyed to a contact, so client filtering
 * is best-effort name matching.
 */

import type { ToolDefinition, ToolResult } from "../types";

type Row = Record<string, unknown>;

function like(s: string): string {
  return `%${s.trim()}%`;
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

export function memoryTools(): ToolDefinition[] {
  return [
    // ── memory_search ────────────────────────────────────────────────────
    {
      name: "memory_search",
      description:
        "Search Henry's long-term memory by keyword across personal facts and " +
        "life/work narrative arcs. Use this first to recall anything the user " +
        "has told Henry before — preferences, facts, history.",
      category: "memory",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword(s) to search for." },
          limit: { type: "number", description: "Max results (default 20)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const query = String(params.query ?? "").trim();
          if (!query) return fail("query is required");
          const limit = Math.min(Number(params.limit) || 20, 100);
          const l = like(query);

          const personal = db
            .prepare(
              `SELECT id, memory_key, memory_value, memory_type, summary, tags_json, updated_at
               FROM personal_memory
               WHERE active_status = 1
                 AND (memory_key LIKE ? OR memory_value LIKE ? OR summary LIKE ?)
               ORDER BY relevance_score DESC, updated_at DESC
               LIMIT ?`,
            )
            .all(l, l, l, limit) as Row[];

          const narrative = db
            .prepare(
              `SELECT id, arc_name, summary, start_date, end_date, updated_at
               FROM narrative_memory
               WHERE active_status = 1
                 AND (arc_name LIKE ? OR summary LIKE ?)
               ORDER BY importance_score DESC, updated_at DESC
               LIMIT ?`,
            )
            .all(l, l, limit) as Row[];

          return ok({
            query,
            personal_memory: personal,
            narrative_memory: narrative,
            count: personal.length + narrative.length,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── memory_read_client ───────────────────────────────────────────────
    {
      name: "memory_read_client",
      description:
        "Fetch a client's full record by name or id: contact info, notes, " +
        "related quotes, and open commitments. Use before drafting anything " +
        "for a specific person.",
      category: "memory",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Contact id, if known." },
          name: {
            type: "string",
            description: "Client name (partial match ok).",
          },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const id = params.id ? String(params.id) : "";
          const name = params.name ? String(params.name).trim() : "";
          if (!id && !name) return fail("provide an id or a name");

          const contact = (
            id
              ? db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id)
              : db
                  .prepare(
                    `SELECT * FROM contacts WHERE name LIKE ? ORDER BY name ASC LIMIT 1`,
                  )
                  .get(like(name))
          ) as Row | undefined;

          if (!contact) return fail(`No client found for "${id || name}"`);

          const clientName = String(contact.name ?? "");
          const nameLike = like(clientName);

          const quotes = db
            .prepare(
              `SELECT id, quote_number, project_title, status, total, currency, updated_at
               FROM quotes
               WHERE customer_id = ? OR customer_name LIKE ?
               ORDER BY datetime(updated_at) DESC
               LIMIT 25`,
            )
            .all(contact.id, nameLike) as Row[];

          const commitments = db
            .prepare(
              `SELECT id, description, status, due_date, importance_score
               FROM commitments
               WHERE status IN ('open','in_progress') AND description LIKE ?
               ORDER BY importance_score DESC, created_at ASC
               LIMIT 25`,
            )
            .all(nameLike) as Row[];

          return ok({ contact, quotes, commitments });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── memory_write_note ────────────────────────────────────────────────
    {
      name: "memory_write_note",
      description:
        "Attach a note to a client or a project. For a client the note is " +
        "appended to their contact notes; for a project it is stored as " +
        "project memory. Identify the target by id or name.",
      category: "memory",
      safetyLevel: "notify",
      confirmPrompt: (p) =>
        `Add a note to ${String(p.target)} "${String(p.name ?? p.id)}": "${String(p.note)}"`,
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["client", "project"],
            description: "Whether the note attaches to a client or a project.",
          },
          id: { type: "string", description: "Target id, if known." },
          name: {
            type: "string",
            description: "Target name (partial match ok).",
          },
          note: { type: "string", description: "The note text to store." },
        },
        required: ["target", "note"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const target = String(params.target ?? "");
          const note = String(params.note ?? "").trim();
          const id = params.id ? String(params.id) : "";
          const name = params.name ? String(params.name).trim() : "";
          if (!note) return fail("note is required");
          if (target !== "client" && target !== "project") {
            return fail("target must be 'client' or 'project'");
          }
          if (!id && !name) return fail("provide an id or a name");

          const now = new Date().toISOString();

          if (target === "client") {
            const contact = (
              id
                ? db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id)
                : db
                    .prepare(`SELECT * FROM contacts WHERE name LIKE ? LIMIT 1`)
                    .get(like(name))
            ) as Row | undefined;
            if (!contact) return fail(`No client found for "${id || name}"`);
            const existing = String(contact.notes ?? "").trim();
            const stamped = `[${now.slice(0, 10)}] ${note}`;
            const merged = existing ? `${existing}\n${stamped}` : stamped;
            db.prepare(
              `UPDATE contacts SET notes = ?, updated_at = ? WHERE id = ?`,
            ).run(merged, now, contact.id);
            return ok({
              target: "client",
              id: contact.id,
              name: contact.name,
              note,
            });
          }

          // target === 'project'
          const project = (
            id
              ? db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id)
              : db
                  .prepare(`SELECT * FROM projects WHERE name LIKE ? LIMIT 1`)
                  .get(like(name))
          ) as Row | undefined;
          if (!project) return fail(`No project found for "${id || name}"`);

          const { randomUUID } = await import("crypto");
          const memId = randomUUID();
          db.prepare(
            `INSERT INTO project_memory (id, project_id, memory_key, memory_value, created_at, updated_at)
             VALUES (?, ?, 'note', ?, ?, ?)`,
          ).run(memId, project.id, note, now, now);
          db.prepare(
            `UPDATE projects SET last_active_at = ?, updated_at = ? WHERE id = ?`,
          ).run(now, now, project.id);
          return ok({
            target: "project",
            id: project.id,
            name: project.name,
            note,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── memory_list_projects ─────────────────────────────────────────────
    {
      name: "memory_list_projects",
      description:
        "List projects with their status. Defaults to active projects; pass a " +
        "status to filter (active, paused, completed, archived).",
      category: "memory",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "paused", "completed", "archived"],
            description: "Filter by status (default: active).",
          },
          limit: { type: "number", description: "Max results (default 20)." },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const limit = Math.min(Number(params.limit) || 20, 100);
          const status = params.status ? String(params.status) : "active";
          const projects = db
            .prepare(
              `SELECT id, name, type, status, description, summary, next_action, money_angle,
                      domain, repo_url, last_worked_at, last_active_at, updated_at
               FROM projects
               WHERE status = ?
               ORDER BY strategic_importance_score DESC, last_active_at DESC
               LIMIT ?`,
            )
            .all(status, limit) as Row[];
          return ok({ status, projects, count: projects.length });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── memory_list_commitments ──────────────────────────────────────────
    {
      name: "memory_list_commitments",
      description:
        "List open commitments (promises Henry is tracking). Optionally filter " +
        "to those mentioning a given client by name.",
      category: "memory",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          client: {
            type: "string",
            description: "Filter to commitments mentioning this client.",
          },
          limit: { type: "number", description: "Max results (default 30)." },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const limit = Math.min(Number(params.limit) || 30, 100);
          const client = params.client ? String(params.client).trim() : "";
          const where: string[] = ["status IN ('open','in_progress')"];
          const args: unknown[] = [];
          if (client) {
            where.push("description LIKE ?");
            args.push(like(client));
          }
          args.push(limit);
          const commitments = db
            .prepare(
              `SELECT id, description, status, due_date, importance_score, project_id, created_at
               FROM commitments
               WHERE ${where.join(" AND ")}
               ORDER BY importance_score DESC, created_at ASC
               LIMIT ?`,
            )
            .all(...args) as Row[];
          return ok({
            client: client || null,
            commitments,
            count: commitments.length,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── project_get ──────────────────────────────────────────────────────
    {
      name: "project_get",
      description:
        "Get one project from the Project Vault by name (fuzzy match): its status, " +
        "description, next action, money angle, repo, domain, and notes. Use when " +
        "the user asks about a specific project (e.g. 'where's StrainSpotter at?').",
      category: "memory",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Project name (fuzzy)." } },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const name = String(params.name ?? "").trim();
          if (!name) return fail("name is required");
          const project = db
            .prepare(
              `SELECT id, name, type, status, description, summary, repo_url, domain,
                      next_action, money_angle, notes, last_worked_at, last_active_at, updated_at
               FROM projects
               WHERE name = ? COLLATE NOCASE OR name LIKE ?
               ORDER BY (name = ? COLLATE NOCASE) DESC, last_active_at DESC
               LIMIT 1`,
            )
            .get(name, like(name), name) as Row | undefined;
          if (!project) return ok({ found: false, name });
          return ok({ found: true, project });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── project_update ───────────────────────────────────────────────────
    {
      name: "project_update",
      description:
        "Update a project in the Project Vault by name. Use to change status, set " +
        "the next action, record the money angle, repo URL, domain, description, or " +
        "append a note. Only the fields you pass are changed.",
      category: "memory",
      safetyLevel: "notify",
      confirmPrompt: (p) => `Update project "${String(p.name)}"`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name (fuzzy match)." },
          status: { type: "string", enum: ["active", "paused", "completed", "archived"], description: "New status." },
          next_action: { type: "string", description: "The single next action." },
          money_angle: { type: "string", description: "How this project makes money." },
          repo_url: { type: "string", description: "Code repository URL." },
          domain: { type: "string", description: "Live domain." },
          description: { type: "string", description: "Human description." },
          note: { type: "string", description: "A note to append to the project's notes." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const name = String(params.name ?? "").trim();
          if (!name) return fail("name is required");
          const project = db
            .prepare(
              `SELECT id, notes FROM projects
               WHERE name = ? COLLATE NOCASE OR name LIKE ?
               ORDER BY (name = ? COLLATE NOCASE) DESC LIMIT 1`,
            )
            .get(name, like(name), name) as { id: string; notes: string | null } | undefined;
          if (!project) return fail(`No project found matching "${name}".`);

          const sets: string[] = [];
          const args: unknown[] = [];
          const setCol = (col: string, val: unknown) => { sets.push(`${col} = ?`); args.push(val); };

          if (typeof params.status === "string") setCol("status", params.status);
          if (typeof params.next_action === "string") setCol("next_action", params.next_action);
          if (typeof params.money_angle === "string") setCol("money_angle", params.money_angle);
          if (typeof params.repo_url === "string") setCol("repo_url", params.repo_url);
          if (typeof params.domain === "string") setCol("domain", params.domain);
          if (typeof params.description === "string") setCol("description", params.description);
          if (typeof params.note === "string" && params.note.trim()) {
            const stamp = new Date().toISOString().slice(0, 10);
            const appended = `${project.notes ? project.notes + "\n" : ""}[${stamp}] ${params.note.trim()}`;
            setCol("notes", appended);
          }

          if (sets.length === 0) return fail("Nothing to update — pass at least one field.");
          setCol("last_worked_at", new Date().toISOString());
          sets.push("updated_at = datetime('now')");
          sets.push("last_active_at = datetime('now')");

          db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...args, project.id);
          const updated = db
            .prepare(`SELECT id, name, status, next_action, money_angle, repo_url, domain FROM projects WHERE id = ?`)
            .get(project.id) as Row;
          return ok({ updated: true, project: updated });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
