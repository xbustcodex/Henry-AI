/**
 * Book tools — capture and recall material for Topher's life story
 * (build plan, Phase 3). Category `memory` so the Book Crew's memory-access
 * agents (e.g. the Story Miner) can pull from the same well Henry writes to.
 *
 * `book_capture` is `notify` (saves a piece of Topher's own writing, then a
 * toast confirms). `book_list` is `silent`. Nothing here leaves the device.
 */

import type { ToolDefinition, ToolResult } from '../types';

type Row = Record<string, unknown>;

const KINDS = ['story', 'lesson', 'letter', 'faith', 'health', 'fatherhood', 'business', 'money', 'other'];
const VALID = new Set(KINDS);
const FIELDS = `id, kind, title, content, created_at, updated_at`;

function ok(data: unknown): ToolResult { return { ok: true, data }; }
function fail(error: string): ToolResult { return { ok: false, error }; }

export function bookTools(): ToolDefinition[] {
  return [
    {
      name: 'book_capture',
      description:
        "Save a piece of Topher's life material for his book — a story, a lesson, " +
        'a letter to family, a faith reflection, a moment from the MS journey, ' +
        'fatherhood, rebuilding, or money. Use when he shares something worth ' +
        'keeping, or asks you to remember it for the book.',
      category: 'memory',
      safetyLevel: 'notify',
      confirmPrompt: (p) => `Save to the book${p.title ? `: "${String(p.title)}"` : ''}`,
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: "The material, in Topher's words where possible." },
          kind: { type: 'string', enum: KINDS, description: 'What kind of material this is (default: story).' },
          title: { type: 'string', description: 'A short title.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const content = String(params.content ?? '').trim();
          if (!content) return fail('There is nothing to save yet.');
          const kind = params.kind && VALID.has(String(params.kind)) ? String(params.kind) : 'story';
          const id = `book_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
          db.prepare(`INSERT INTO book_entries (id, kind, title, content) VALUES (?, ?, ?, ?)`)
            .run(id, kind, params.title != null ? String(params.title) : null, content);
          const entry = db.prepare(`SELECT ${FIELDS} FROM book_entries WHERE id = ?`).get(id) as Row;
          return ok({ saved: true, entry });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      name: 'book_list',
      description:
        "List captured book material, optionally filtered by kind (story, lesson, " +
        'letter, faith, health, fatherhood, business, money, other). Use to gather ' +
        'material for a chapter or to see what Topher has captured.',
      category: 'memory',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS, description: 'Filter by kind.' },
          limit: { type: 'number', description: 'Max results (default 50).' },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const limit = Math.min(Number(params.limit) || 50, 200);
          const kind = params.kind ? String(params.kind) : '';
          const rows = kind
            ? (db.prepare(`SELECT ${FIELDS} FROM book_entries WHERE kind = ? ORDER BY updated_at DESC LIMIT ?`).all(kind, limit) as Row[])
            : (db.prepare(`SELECT ${FIELDS} FROM book_entries ORDER BY updated_at DESC LIMIT ?`).all(limit) as Row[]);
          return ok({ kind: kind || 'all', entries: rows, count: rows.length });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
