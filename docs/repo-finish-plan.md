# Henry AI Desktop — Finish Plan

_Last reviewed: 2026-06-07 (v2.3.0). This replaces the April plan, whose
"critical blockers" were all resolved — keeping that list around was sending
people to fix already-fixed things._

## ✅ Resolved since the April plan (verified in code)

| Old item | Status | Where |
|---|---|---|
| Sandbox disabled (`sandbox:false`) | **Done** — `sandbox: true` | `electron/main.ts:64` |
| Terminal accepts any command | **Hardened** — shared classifier blocks catastrophic commands (rm -rf of roots, fork bomb, mkfs, dd, shutdown), inspecting chained segments | `electron/ipc/terminal.ts`, `electron/ipc/_commandSafety.ts` |
| Task file ops lack path safety | **Done** — shared `safeResolve` | `electron/ipc/taskBroker.ts`, `electron/ipc/_pathSafety.ts` |
| Filesystem sibling-dir traversal | **Fixed** — correct prefix check + symlink hardening | `electron/ipc/filesystem.ts`, `_pathSafety.ts` |
| `computer:notify` shell injection | **Fixed** — `execFileSync`, no shell | `electron/ipc/computer.ts` |
| AI stream cancellation never wired | **Done** — `activeStreams` set + cancel path | `electron/ipc/ai.ts:899,998` |
| Queue default priority mismatch | **Already consistent** — `task.priority ?? 5` == DB default 5 | `taskBroker.ts:161`, `database.ts:65` |
| Event-listener leak in App.tsx | **Largely addressed** — major effects return cleanups | `src/App.tsx` |
| No tests at all | **Started** — vitest + first suites (security + content blocks) | `electron/ipc/*.test.ts` |

---

## 🔴 Real remaining priorities

### 1. Expand test coverage outward from the security core — _in progress_
Done so far (93 tests): path/command-safety helpers, content blocks, the **agent
tool runner approval gate** (`toolRunner.test.ts`), the **tool safety policy**
guard (`tools/safetyPolicy.test.ts`), and the **session store** end-to-end
(`session_store.test.ts`: CRUD, FTS search over flattened block text, token/cost
accounting, resume, branch, and the v1→v2 migration). Remaining targets:
- **AI streaming** (`electron/ipc/ai.ts`) — cancellation, error propagation.
  Coupled to providers/ipcMain; extract the stream lifecycle to a testable unit
  first.
- **Task queue** (`electron/ipc/taskBroker.ts`) — priority ordering, abort.

### 2. Security review of the agent action surface — _mostly done_
Audited every agent tool's `safetyLevel` against what it does (2026-06-07). The
confirm-tier gate is sound (blocks before execute, fails safe) and the dangerous
tools are correctly `confirm`; `calendar_create_event` was raised notify→confirm.
A regression guard (`tools/safetyPolicy.test.ts`) keeps senders/money/real-world
writes gated. Remaining:
- Per-tool **input validation/escaping** (same discipline as the `computer:notify`
  fix) as new tools land.
- Decide whether private-data **reads** (`email_read_recent`,
  `messages_read_recent`), currently `silent`, should `notify`.

### 3. Python dependency fallback for the session store — _done at the bridge_
`electron/ipc/sessionStore.ts` degrades gracefully: every `session:*` handler
catches and returns `{ ok: false, error }`, and `session:checkDeps` returns
`{ available: false }` when Python is missing — nothing throws. The renderer just
needs to check `ok`/`available` when session-history UI is built.

### 4. Finish or hide the half-built panels
Several panels are partial (CRM, finance, secretary, meeting recorder, deeper
companion features). Decide per-panel: finish, or gate behind a "beta" flag so
the shipped surface is all things that work. Prefer depth over new breadth.

---

## 🟡 Nice-to-haves
- Retry/backoff on API calls.
- Per-task cost tracking surfaced in the UI (the session store already tracks
  per-session tokens/cost).
- Coverage reporting (`@vitest/coverage-v8`) once the suite grows.

---

## 🧹 Housekeeping
- Duplicated CI workflows (`typecheck 2.yml`, `desktop-release 2.yml`, etc.) —
  consolidate to one each.
- Stray release folders (`release/`, `release2/`) — keep one, gitignore build
  output.

---

## 🚀 Definition of "shippable to general availability"
- All shell/file/agent actions gated or validated (✅ shell/file; agent layer in
  review — item 2).
- `npm test` green and covering the risky modules (in progress — item 1).
- No half-built panel reachable without a beta flag (item 4).
- Graceful degradation when optional deps (Python, API keys) are absent.
