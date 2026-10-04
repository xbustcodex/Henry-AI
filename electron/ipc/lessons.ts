/**
 * Lessons / Curriculum IPC — Henry as teacher ("teach me anything" + Bible courses).
 *
 * Pure data layer over the `courses` / `lessons` / `lesson_reviews` tables
 * (schema in electron/ipc/database.ts → migrateLessonsSchema). All AI
 * generation — outlines, lesson content, quizzes, short-answer grading —
 * happens renderer-side through callHenryAI; the renderer only sends parsed,
 * validated data here. A course row is only created AFTER its outline parsed
 * cleanly, so there are never orphan/empty courses.
 *
 * Channels (match preload.ts):
 *   - `lessons:courses:list`        → all courses + per-course progress counts
 *   - `lessons:courses:create`      → course + its lesson rows (lesson 1 available, rest locked)
 *   - `lessons:courses:get`         → one course with its ordered lessons
 *   - `lessons:courses:delete`      → remove course (lessons + reviews cascade)
 *   - `lessons:lessons:get`         → one lesson by id
 *   - `lessons:lessons:updateStatus`→ move a lesson through the progression; completing unlocks the next
 *   - `lessons:lessons:saveContent` → cache generated lesson markdown (also promotes available → in_progress)
 *   - `lessons:reviews:save`        → log a quiz attempt; score ≥ 60 completes the lesson + unlocks the next
 *   - `lessons:reviews:listForCourse` → all review attempts across a course's lessons
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';

type Row = Record<string, unknown>;

const COURSE_FIELDS = `id, title, topic, kind, outline_json, created_at, updated_at`;
const LESSON_FIELDS = `id, course_id, idx, title, content_md, status, score, completed_at`;
const REVIEW_FIELDS = `id, lesson_id, quiz_json, answers_json, score, created_at`;

const VALID_KINDS = new Set(['bible', 'general']);
const VALID_STATUS = new Set(['locked', 'available', 'in_progress', 'completed']);

/** Passing threshold for a quiz to complete a lesson (percent). */
export const LESSON_PASS_SCORE = 60;

function safe<T>(fn: () => T) {
  try {
    return { ok: true as const, result: fn() };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function registerLessonsHandlers(db: Database.Database): void {
  const getLesson = (id: string) =>
    db.prepare(`SELECT ${LESSON_FIELDS} FROM lessons WHERE id = ?`).get(id) as Row | undefined;

  /** Unlock the next locked lesson after `idx` in a course. Returns it, or null. */
  function unlockNext(courseId: string, idx: number): Row | null {
    const next = db
      .prepare(
        `SELECT ${LESSON_FIELDS} FROM lessons
         WHERE course_id = ? AND idx > ? AND status = 'locked'
         ORDER BY idx ASC LIMIT 1`,
      )
      .get(courseId, idx) as Row | undefined;
    if (!next) return null;
    db.prepare(`UPDATE lessons SET status = 'available' WHERE id = ?`).run(next.id);
    return getLesson(String(next.id)) ?? null;
  }

  function touchCourse(courseId: string) {
    db.prepare(`UPDATE courses SET updated_at = datetime('now') WHERE id = ?`).run(courseId);
  }

  // ── Courses ───────────────────────────────────────────────────────────────

  ipcMain.handle('lessons:courses:list', () =>
    safe(() => {
      return db
        .prepare(
          `SELECT c.*,
                  COUNT(l.id) AS lesson_count,
                  SUM(CASE WHEN l.status = 'completed' THEN 1 ELSE 0 END) AS completed_count
           FROM courses c
           LEFT JOIN lessons l ON l.course_id = c.id
           GROUP BY c.id
           ORDER BY datetime(c.updated_at) DESC`,
        )
        .all() as Row[];
    }),
  );

  ipcMain.handle(
    'lessons:courses:create',
    (_e, payload: {
      title: string;
      topic: string;
      kind?: string;
      outline_json?: string;
      lessons: Array<{ title: string }>;
    }) =>
      safe(() => {
        const title = String(payload?.title ?? '').trim();
        const topic = String(payload?.topic ?? '').trim();
        if (!title) throw new Error('Course title is required');
        if (!topic) throw new Error('Course topic is required');
        const kind = VALID_KINDS.has(String(payload?.kind)) ? String(payload.kind) : 'general';
        const lessonTitles = (Array.isArray(payload?.lessons) ? payload.lessons : [])
          .map((l) => String(l?.title ?? '').trim())
          .filter(Boolean);
        if (lessonTitles.length === 0) throw new Error('A course needs at least one lesson');

        const courseId = genId('crs');
        const insertLesson = db.prepare(
          `INSERT INTO lessons (id, course_id, idx, title, status) VALUES (?, ?, ?, ?, ?)`,
        );
        const create = db.transaction(() => {
          db.prepare(
            `INSERT INTO courses (id, title, topic, kind, outline_json) VALUES (?, ?, ?, ?, ?)`,
          ).run(courseId, title, topic, kind, String(payload?.outline_json ?? '{}'));
          lessonTitles.forEach((t, i) => {
            insertLesson.run(genId('lsn'), courseId, i, t, i === 0 ? 'available' : 'locked');
          });
        });
        create();

        const course = db.prepare(`SELECT ${COURSE_FIELDS} FROM courses WHERE id = ?`).get(courseId) as Row;
        const lessons = db
          .prepare(`SELECT ${LESSON_FIELDS} FROM lessons WHERE course_id = ? ORDER BY idx ASC`)
          .all(courseId) as Row[];
        return { course, lessons };
      }),
  );

  ipcMain.handle('lessons:courses:get', (_e, id: string) =>
    safe(() => {
      const course = db
        .prepare(`SELECT ${COURSE_FIELDS} FROM courses WHERE id = ?`)
        .get(String(id ?? '')) as Row | undefined;
      if (!course) return null;
      const lessons = db
        .prepare(`SELECT ${LESSON_FIELDS} FROM lessons WHERE course_id = ? ORDER BY idx ASC`)
        .all(course.id) as Row[];
      return { course, lessons };
    }),
  );

  ipcMain.handle('lessons:courses:delete', (_e, id: string) =>
    safe(() => {
      const info = db.prepare(`DELETE FROM courses WHERE id = ?`).run(String(id ?? ''));
      return { deleted: info.changes > 0 };
    }),
  );

  // ── Lessons ───────────────────────────────────────────────────────────────

  ipcMain.handle('lessons:lessons:get', (_e, id: string) =>
    safe(() => getLesson(String(id ?? '')) ?? null),
  );

  ipcMain.handle(
    'lessons:lessons:updateStatus',
    (_e, payload: { id: string; status: string; score?: number }) =>
      safe(() => {
        const id = String(payload?.id ?? '').trim();
        if (!id) throw new Error('Lesson id is required');
        const status = String(payload?.status ?? '');
        if (!VALID_STATUS.has(status)) throw new Error(`Invalid lesson status: ${status}`);
        const existing = getLesson(id);
        if (!existing) throw new Error(`No lesson found for id ${id}`);

        let unlocked: Row | null = null;
        const run = db.transaction(() => {
          if (status === 'completed') {
            db.prepare(
              `UPDATE lessons SET status = 'completed', score = COALESCE(?, score),
               completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ?`,
            ).run(payload?.score ?? null, id);
            unlocked = unlockNext(String(existing.course_id), Number(existing.idx));
          } else {
            db.prepare(
              `UPDATE lessons SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN completed_at ELSE NULL END WHERE id = ?`,
            ).run(status, status, id);
          }
          touchCourse(String(existing.course_id));
        });
        run();
        return { lesson: getLesson(id) as Row, unlocked };
      }),
  );

  ipcMain.handle(
    'lessons:lessons:saveContent',
    (_e, payload: { id: string; content_md: string }) =>
      safe(() => {
        const id = String(payload?.id ?? '').trim();
        if (!id) throw new Error('Lesson id is required');
        const content = String(payload?.content_md ?? '').trim();
        if (!content) throw new Error('Lesson content is empty');
        const existing = getLesson(id);
        if (!existing) throw new Error(`No lesson found for id ${id}`);
        // First generated content means the learner has started this lesson.
        const promote = existing.status === 'available';
        db.prepare(
          `UPDATE lessons SET content_md = ?, status = CASE WHEN ? THEN 'in_progress' ELSE status END WHERE id = ?`,
        ).run(content, promote ? 1 : 0, id);
        touchCourse(String(existing.course_id));
        return getLesson(id) as Row;
      }),
  );

  // ── Reviews (quiz attempts) ───────────────────────────────────────────────

  ipcMain.handle(
    'lessons:reviews:save',
    (_e, payload: { lesson_id: string; quiz_json: string; answers_json: string; score: number }) =>
      safe(() => {
        const lessonId = String(payload?.lesson_id ?? '').trim();
        if (!lessonId) throw new Error('lesson_id is required');
        const lesson = getLesson(lessonId);
        if (!lesson) throw new Error(`No lesson found for id ${lessonId}`);
        const score = Math.max(0, Math.min(100, Number(payload?.score ?? 0)));
        const passed = score >= LESSON_PASS_SCORE;

        const reviewId = genId('rev');
        let unlocked: Row | null = null;
        const run = db.transaction(() => {
          db.prepare(
            `INSERT INTO lesson_reviews (id, lesson_id, quiz_json, answers_json, score)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(reviewId, lessonId, String(payload?.quiz_json ?? '{}'), String(payload?.answers_json ?? '[]'), score);
          if (passed) {
            db.prepare(
              `UPDATE lessons SET status = 'completed', score = ?,
               completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ?`,
            ).run(score, lessonId);
            unlocked = unlockNext(String(lesson.course_id), Number(lesson.idx));
          } else {
            // Keep the best score on the lesson even on a failed attempt.
            db.prepare(`UPDATE lessons SET score = MAX(COALESCE(score, 0), ?) WHERE id = ?`).run(score, lessonId);
          }
          touchCourse(String(lesson.course_id));
        });
        run();

        const review = db.prepare(`SELECT ${REVIEW_FIELDS} FROM lesson_reviews WHERE id = ?`).get(reviewId) as Row;
        return { review, lesson: getLesson(lessonId) as Row, passed, unlocked };
      }),
  );

  ipcMain.handle('lessons:reviews:listForCourse', (_e, courseId: string) =>
    safe(() => {
      return db
        .prepare(
          `SELECT r.id, r.lesson_id, r.quiz_json, r.answers_json, r.score, r.created_at,
                  l.title AS lesson_title, l.idx AS lesson_idx
           FROM lesson_reviews r
           JOIN lessons l ON l.id = r.lesson_id
           WHERE l.course_id = ?
           ORDER BY datetime(r.created_at) DESC`,
        )
        .all(String(courseId ?? '')) as Row[];
    }),
  );
}
