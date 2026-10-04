# Henry Upgrade Plan — Phased Build

**What this is:** a sequenced, solo-dev-realistic plan to grow Henry from a shipping
desktop app into Topher's personal AI operating system, without torching the
momentum of a product that's now signed, notarized, and sellable.

**The one rule that governs everything below:** finish and prove each phase before
starting the next. The vision is ~6–12 months of solo work taken whole; the way it
actually ships is one gated slice at a time.

---

## Governing principles

- **Protect what's shipped.** 2.3.0 is sellable. No new architecture lands on `main`
  until it's behind the smoke gate (typecheck + tests + build) and can't break install,
  licensing, or the build pipeline.
- **Build on what exists; don't clone.** Henry already has a provider fallback chain,
  a CRM/job/quote data model, SQLite, and safety rules in its system prompt. Most
  modules are extensions, not greenfield.
- **Ollama-first cost posture.** Default every new task to local. Reach for Claude/
  OpenAI only on heavy reasoning/coding, and always log the call + cost.
- **Approval-gated by default.** Nothing risky (delete, spend, send, publish, deploy,
  DNS, push, contact leads) runs silently. This is already Henry's stated value —
  the plan formalizes it into a queue.
- **One phase, one gate.** Each phase has a done-test. If it isn't met, you don't move on.

---

## Current baseline (what already exists — Nov 2025 / v2.3.0)

- Electron + React + TS + Vite + Zustand + better-sqlite3 desktop app, signed +
  notarized + stapled, sellable.
- Multi-provider AI with fallback: **Groq → license proxy → Ollama → error** (this is
  the model router skeleton already).
- CRM, quoting, job tracking, financial reporting, USB serial 3D-printer bridge.
- Cloudflare Worker (`henry-proxy`) for AI proxy, licensing (KV), Stripe webhook, pricing.
- Companion phone remote-control + voice assistant features.
- Henry's system prompt has ABSOLUTE RULES against fabricating facts and acting without
  approval — the seed of the safety layer.

**Reading of the 12 modules against this:** the model router (#7), safety rules (#11),
and the data spine for the Project Vault (#2) are largely already present. The expensive,
far-out work is the agent layer (#3 crews, #4 software-company, #5 build mode).

---

## Phase 0 — Protect & prove the shipped product

*No new architecture. This is the gate that earns the right to build the rest.*

**Do:**
- Confirm the Stripe webhook endpoint is registered + delivering (the open item from
  the last session). Run one test event; watch for a `200`.
- Add Windows/Linux auto-update manifests (`latest.yml` / `latest-linux.yml`) to releases
  so in-app updates fire on every platform.
- Extend vitest to cover license validation + provider fallback danger paths (the thin
  harness before any risky refactor).
- Get Henry into **5–10 real beta hands** and collect what actually breaks.

**Gate to Phase 1:** payment→license→activation proven with a real (or test-mode)
purchase, and at least a handful of users running 2.3.0 without install/licensing failures.

---

## Phase 1 — Project Memory Vault + Command Center *(the backbone)*

*This is the first real build slice. Everything else hangs off it.*

**Why first:** it helps you today (10 projects scattered across your head and old chats),
it's the data layer every later module reads/writes, and it touches none of the
payment/build pipeline — so it can't break what's now sellable.

**Build:**
- A `projects` table in the existing SQLite db (build on the CRM schema, don't add a new store).
- A Command Center screen: chat box + project selector + recent tasks + a memory panel.
- Henry can read/write the vault from chat ("summarize MixedMakerShop", "set next action
  on StrainSpotter").

**Vault schema (per project):** name, description, status, repo link, domain, next action,
money angle, last worked date, connected files, notes, decisions made.

**Seed projects:** MixedMakerShop, Henry AI, What Do I Say?, StrainSpotter, GiGi's Print
Shop, Tap Hub / iTap Ring, FreshCut Property Care, Topher's Web Design, Book / Life Story,
Facebook Lead System.

**Cost posture:** vault summaries + sorting run on **Ollama**. No paid calls in this phase.

**Gate to Phase 2:** you're using the Command Center daily to drive real project work, and
the vault is the source of truth (not a second copy you ignore).

---

## Phase 2 — Model Router visibility + Approval Queue

*Cheap, high-value, mostly formalizing patterns Henry already half-has.*

**Build:**
- Surface the existing router: show model used, estimated cost, reason for the choice,
  and fallback — per task. Add a cost log table.
- Approval Queue: a real table + UI with statuses (pending / approved / rejected /
  needs review / completed). Route every risky action through it before execution.

**Risky actions that must enqueue:** delete files, spend money, send email, publish posts,
deploy sites, change DNS, push to prod, contact leads, edit legal/financial docs.

**Gate to Phase 3:** no risky action can run without passing through the queue, and every
model call shows its cost.

---

## Phase 3 — Agent Crew System *(first agent layer — borrow from CrewAI)*

*The first genuinely "new" capability. Ollama-first, tightly scoped.*

**Build:**
- Agent template format: role, goal, tools allowed, memory access level, approval level,
  cost limit, output format.
- A task queue agents pull from; agents write results back to the Vault and through the
  Approval Queue.
- Start with **2 templates**, not 10: a **Research Agent** and a **Local Lead Agent**
  (both directly serve MixedMakerShop revenue). Add others only once those two earn their keep.

**Later templates (don't build until the first two prove out):** Builder, Sales, Website
Audit, Copywriter, Book, Finance/Cut-Cost, QA/Test, Memory Archivist.

**Gate to Phase 4:** at least one crew runs a real end-to-end task (e.g. find + audit a
local lead) start-to-approval without hand-holding.

---

## Phase 4 — Build Mode *(Cline-style: Plan / Act / Review / Fix / Ship)*

*Heavier. This is Henry editing repos. Highest blast radius — most guardrails.*

**Rules (non-negotiable):**
- Inspect repo first → write a plan → get approval before major edits → show diffs →
  run tests → record what changed → create a rollback/checkpoint.

**Build:** the five modes (Plan/Act/Review/Fix/Ship) as states, with diffs surfaced in the
Approval Queue and a checkpoint before any write.

**Cost posture:** planning + reasoning are the one place paid models (Claude/OpenAI) are
worth it. Everything else stays local.

**Gate to Phase 5:** Henry safely makes a real, reviewed, reversible change to one of your
repos and you trust the rollback.

---

## Phase 5 — Software Company Mode + Council Rooms *(far-out, expensive)*

*Borrow from MetaGPT (#4) and AutoGen (#5). Do not start before Phase 4 is solid.*

- **Software Company Mode:** idea → product brief → features → user stories → DB plan →
  UI screens → build tasks → test checklist → launch checklist. Roles: PM, Architect,
  Developer, QA, Launch Manager.
- **Council Rooms:** group-chat / debate style multi-agent decisions with human-in-the-loop.

This is the most model-expensive part of the whole map. Treat it as a research track, not
a deadline.

---

## Cross-cutting tracks (ride alongside the phases — not separate milestones)

These are capture/pipeline layers that sit on the Vault. They grow a little each phase
rather than getting their own stop-the-world build.

- **Tool Connector Layer (#10):** add connectors only when a phase needs one. Likely order:
  GitHub + local files (Phase 1) → Ollama (already) → Gmail/Calendar/Drive (Phase 3, for
  the Lead/Research crews) → Netlify/Vercel/Stripe/Facebook tracker (Phase 4–5).
- **Life / Book Engine (#8):** a lightweight capture path that tags chat moments as book
  material into the Vault (stories, lessons, letters, timeline). Starts as a single "save to
  book" action in Phase 1; outputs (chapters, memoir scenes, outline) come later.
- **MixedMakerShop Money Engine (#9):** the lead pipeline (found → audited → contacted →
  follow-up → proposal → closed) implemented as Vault statuses, powered by the Phase 3 crews.

---

## Module → phase map

| # | Module | Phase | Notes |
|---|--------|-------|-------|
| 1 | Command Center | 1 | backbone |
| 2 | Project Memory Vault | 1 | backbone; extends CRM schema |
| 7 | Local + Paid Model Router | 2 | skeleton already exists |
| 6 | Approval Queue | 2 | formalizes existing safety value |
| 11 | Safety Rules | 2 | already in system prompt; enforce via queue |
| 3 | Agent Crew System | 3 | start with 2 templates |
| 9 | Money Engine | 3 | rides on crews + vault |
| 10 | Tool Connector Layer | 1→5 | incremental |
| 8 | Life/Book Engine | 1→5 | capture first, outputs later |
| 5 | Cline-style Build Mode | 4 | highest blast radius |
| 4 | Software Company Mode | 5 | most expensive |
| 12 | MVP | = Phases 0–2 | the doc's "MVP" is really Phases 0–2 combined |

---

## Cost routing (keep bills low)

- **Ollama (local, free):** vault summaries, file sorting, low-risk drafts, status updates.
- **Cheap OpenRouter / Groq:** bulk tasks, first-pass research.
- **Claude / OpenAI (paid):** hard coding, architecture, planning, final review only.
- Every call logs: model, estimated cost, reason, fallback. No hidden spend — ever.

---

## What NOT to do

- Don't pause selling 2.3.0 to build this.
- Don't build all 10 agent templates, all 5 modes, or all connectors up front.
- Don't reimplement Cline/CrewAI/AutoGen/MetaGPT — Henry **orchestrates** tools; it isn't
  a clone of them.
- Don't let any phase skip its gate because the next one is more exciting.

---

*Living document. Revise gates as real beta data comes in.*
