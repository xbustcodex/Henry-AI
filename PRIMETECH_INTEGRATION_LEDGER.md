# PRIMETECH INTEGRATION LEDGER — capability inventory of Henry

**Purpose.** A source-backed answer to one question: *what does Henry genuinely have end to end,
and what is local-only, placeholder, or somebody else's product?* This is the input to the
Owner-Henry / PrimeTech integration programme. It is an **inventory**, not a plan — no design
proposals live here.

**Baseline.** HEAD `9598c53`. Every claim carries a `file:line` citation to the code as of that
commit. Claims that could not be established are marked **not established** rather than guessed.

**Status vocabulary.**
`EXISTS` — full UI → IPC → service → persistence → result path, verified.
`PARTIAL` — the path exists but a link is missing, stubbed, or local-only where it looks server-backed.
`MISSING` — searched across the named trees, nothing found.
`OWNER-SPECIFIC` — belongs to the owner's other product, not a Henry capability.
`COMMON` — generic plumbing, not a differentiator.

**Headline for the programme.** Henry's finance surface is **a local SQLite ledger with one
half-wired accounting connector.** It is not a financial system, and the programme must not build
one. See §1.

---

## 1. Finance / revenue / payment — READ THIS FIRST

### 1.1 What is REAL

| What | Reality | Evidence |
|---|---|---|
| Transaction ledger | Real and local. A `transactions` table + 5 CRUD handlers. Money is never sent anywhere. | `electron/ipc/memory.ts:1305` (DDL), `:1311` `finance:create`, `:1325` `finance:list`, `:1331` `finance:add`, `:1339` `finance:delete`, `:1343` `finance:summary` |
| Recurring entries | Real and local. `recurring_transactions` table, autopost dedupes on `[Auto] …` + date. | `electron/ipc/memory.ts:1643` (DDL), `:1654` list, `:1657` save, `:1663` soft-delete, `:1668` autopost, `:1676` dedupe query |
| Quotes → estimate-to-cash | Real and local. 13 `quote:*` handlers over `quotes` + `quote_line_items`. | `electron/ipc/quoting.ts:111` (DDL), `:162` list, `:208` save, `:478` summary, `:529` convertToRun, `:607` exportMarkdown |
| Jobs with money attached | Real and local. `jobs` carries `bid_amount` / `invoice_amount` / `paid_amount` with a status CHECK spanning `bid…paid`. | `electron/ipc/syncBridge.ts:461` |
| Accounting CSV export | Real, local, writes two CSVs to the Desktop and asks the user to import them elsewhere. **Not** a connection. | `electron/ipc/syncBridge.ts:7160` (trigger), `:7167-7171` (SQL), `:7195-7198` (file writes), `:7210` ("Import both into QuickBooks, Wave, FreshBooks, or Excel") |
| Provider cost accounting | Real. `cost_log` records token spend per provider/model. This is Henry's **own** AI spend, not the user's business revenue. | `electron/ipc/database.ts:102` (DDL), `electron/ipc/settings.ts:253` (insert), `:271` (query); UI `src/components/costs/CostDashboard.tsx:48` |
| Agent finance tools | Real, read-mostly, over the same local tables. | `electron/agent/tools/finance.ts:98` `quote_list`, `:157` `quote_get`, `:190` `quote_create`, `:319` `invoice_list`, `:364` `finance_summary` |

**`finance_summary` is the honest one.** It states its own limitation in its own output:
`"Receivables derived from sent/accepted quotes pending the QuickBooks connector."`
(`electron/agent/tools/finance.ts:422`). "Receivables" here is a `SUM(total)` over quotes whose
status is `sent`/`accepted` (`:398-403`) — it is a quote pipeline, not an accounts-receivable ledger.

### 1.2 What is PLACEHOLDER / BROKEN

**DEFECT 1 — `finance:create` can never succeed. The CSV import path is dead.**

The handler inserts into a column the table does not have:

- `electron/ipc/memory.ts:1314` — `INSERT INTO transactions (id,date,description,category,amount,type,created_at,**updated_at**) VALUES (?,?,?,?,?,?,?,?)`
- `electron/ipc/memory.ts:1305-1309` — the DDL declares **no `updated_at`**. There is no
  `ALTER TABLE` migration anywhere (grep for `transactions` across `electron/` returns only the
  DDL at `:1305`, this insert at `:1314`, the autopost insert at `:1678`, and an update at `:1664`).

Reproduced against real SQLite:

```
finance:create FAILS -> OperationalError table transactions has no column named updated_at
finance:add OK, rows = 1
```

The UI path that depends on it is `importCSV` → `api2.financeCreate(...)` at
`src/components/finance/FinancePanel.tsx:182`. The throw is swallowed by `catch { }` at `:190`,
which increments `imported` **before** the result is ever checked — so the panel reports
`✓ Imported N transactions` (`FinancePanel.tsx:192`) for rows that were never written. **A user
importing their bank CSV is told it worked.** The working alternative is `financeAdd`
(`FinancePanel.tsx:59`), which is what the manual "+ Add" form uses.

**DEFECT 2 — the QuickBooks connector cannot be connected.**

`qb_open_auth` opens a real Intuit authorize URL (`electron/agent/tools/quickbooks.ts:506-516`),
but the two preconditions are unreachable:

1. `REDIRECT_URI = "http://127.0.0.1:9006/callback"` (`quickbooks.ts:111`). **Nothing in the repo
   listens on 9006.** Every listener was enumerated: `henryLocalBrainGateway.ts:108`,
   `syncBridge.ts:9521`, `proxyServer.ts:64`, `opencodeBridge.ts:403`, and the OAuth loopback
   listener `flow.ts:341`. QuickBooks is **not** in the OAuth provider registry — that registry
   holds only Google (`:21`) and Discord (`:77`, `PROVIDERS` at `:114-117`), so it never gets a
   PKCE listener.
2. `qb_client_id` has no writer. `getSetting(db, "qb_client_id")` (`quickbooks.ts:490`) is read
   at `quickbooks.ts:52-57`; grep for `qb_client_id` across `src/` and `electron/ipc/` returns
   **nothing** — no settings panel writes it, despite the tool's own message telling the user to
   "paste its Client ID/Secret into Henry's Settings → Integrations → QuickBooks"
   (`quickbooks.ts:499`). That settings surface does not exist.

Consequently every QB tool returns the `notConnected()` payload (`quickbooks.ts:41-48`). The
client id/secret/environment the header describes (`quickbooks.ts:16-21`) cannot be supplied.
**`qb_sync_invoices`, `qb_create_invoice` and `qb_get_balance` are unreachable in a shipped build.**

What *is* real in this connector: the QBO REST client and its token refresh
(`quickbooks.ts:176-224` `qbRequest`, `:156` `refreshAccessToken`, `:172` `ensureToken`), the
401→refresh→retry (`:176-224`), the sandbox/production switch (`:100-105`), encrypted token
storage via the same `safeStorage` helper as provider keys (`:95-97`), and the local invoice cache
upsert (`:306-338`) against a real `invoices` table (`electron/ipc/database.ts:446-455`). The
code is sound; it is unreachable.

### 1.3 Payments — genuinely absent

**MISSING.** No payment processing of any kind. Grep for `stripe|Stripe|payment_intent|checkout.session|Paddle|charge`
across `electron/` and `src/` returns no processor, no SDK, no checkout, no webhook receiver.

"Payments" in Henry means *a row the user typed into the local ledger*:

- `electron/ipc/syncBridge.ts:6175-6178` — "payments from a client" is
  `SELECT … FROM transactions WHERE type='income' AND LOWER(category) LIKE '%acme%'`. It
  pattern-matches a client name against a free-text category field. Its own no-data reply at `:6179`
  says so: *"No payments recorded … Log one: `charged acme $X`"*.
- `syncBridge.ts:7734` — the "charged/billed/collected $X" parser that writes such a row.

There is no merchant, no charge, no settlement, no reconciliation, no dunning. **A payment rail
would be new work, and it would be new work in a domain the owner already owns elsewhere.**

### 1.4 Finance conclusions for the programme

- The **accounting of record** is QuickBooks, which Henry cannot currently reach. Henry is a
  *bookkeeping scratchpad* next to it.
- Henry's own AI spend (`cost_log`) is the one number it measures accurately and automatically.
  It now measures **panel** AI too — see 1.5.
- Panel AI is **provider-routed**. The ten renderer-side proxy call sites that bypassed
  `electron/ipc/ai.ts` have been brought under the governed path — see 1.5.
- Budgets are `localStorage` only (`FinancePanel.tsx:116`, `:127`) — never in SQLite, never synced.

### 1.5 Renderer proxy bypasses — FIXED, with one owner decision outstanding

**Was.** Six panels built a `fetch` to the hosted Cloudflare worker from the renderer by hand,
with a hardcoded model, at ten call sites:

| Panel | Feature | Model it declared | Where the answer went |
|---|---|---|---|
| `FinancePanel.tsx:91` | Monthly P&L summary | `llama-3.3-70b-versatile` | `setPlResult` |
| `FinancePanel.tsx:215` | Monthly financial insight | same | `setInsight` |
| `TodayPanel.tsx:172` | "Henry's word", cached all day | same | `setHenryWord` + `henry-word` cache |
| `TodayPanel.tsx:271` | Morning briefing, no-key branch | same | `saveBriefing` |
| `TodayPanel.tsx:323` | "Focus now" | same | `setHenryFocusQ` |
| `TodayPanel.tsx:400` | Daily plan (proxy fallback) | same | `setPlannerResult` + `daily-plan` cache |
| `TasksPanel.tsx:64` | Task triage | same | `setTriageResult` |
| `GoalsPanel.tsx:97` | Goal coaching | same | `setCoaching` |
| `WeeklyReviewPanel.tsx:721` | Weekly review | same | `setWeekSummary` |
| `CapturesPanel.tsx:279` | Capture review | same | `setReviewResult` |

Every one bypassed provider classification, the credential policy, the security/validation
layer, retry/failure handling and the cost log. A financial summary was the clearest case, but
the rule was not specific to finance.

**Now.** All ten dispatch through `src/henry/panelAI.ts` — `ai:send` / `ai:stream`
(`electron/ipc/ai.ts`). Each call names a stable `logPurpose` (`finance.pl-summary`,
`finance.insight`, `tasks.triage`, `goals.coach`, `weekly.review`, `captures.review`,
`today.henrys-word`, `today.focus-now`, `today.daily-plan`, `today.briefing`), and
`ai:send`/`ai:stream` write one `cost_log` row per call under `task_id` — including
0-cost Ollama turns, so a local install's panel AI is visible too. `PanelAIRequest` has no
`provider` or `model` field: the engine comes from `resolveConfiguredEngine`
(`src/henry/henryAI.ts`), which is the same `resolveChat` decision `callHenryAI` and Chat make,
so a panel cannot name a provider. The `proxyShim.ts` global `fetch` monkey-patch existed only
to intercept these calls and has been deleted; nothing patches `window.fetch` any more.

**Provider/model selection: unchanged, and that is provable.** Before the change the declared
model was already inert twice over — `henry-proxy/README.md` documents the worker's chat
endpoint as returning `503 provider_not_configured`, and `proxyShim` ignored the request's
`model` and answered from the user's configured engine anyway. So the runtime behaviour of all
ten features was *already* the configured Companion engine. It is now that engine by
construction rather than by interception. `src/henry/panelAI.test.ts` asserts the dispatched
provider/model per feature, and asserts that nothing is dispatched when no engine is selected,
when the selected provider has no key, when the provider is retired (`groq`), or when the model
is not offered by the selected provider.

**OWNER DECISION — the declared model.** `llama-3.3-70b-versatile` is a Groq model id, and
Groq is retired (`electron/providers/retiredProviders.ts`, `RETIRED_PROVIDER_IDS = ['groq']`).
No Henry provider offers it as a selectable model; `src/providers/cerebras.ts:27` maps it to
`llama3.3:70b` as an alias, so a Cerebras selection can reach an equivalent model. Options:

1. **Accept the configured engine (current behaviour, recommended).** Nothing to decide — the
   ten features already ran on the configured engine. Cost: a user who selected Ollama gets a
   local model for their P&L summary, where the source literal said 70B.
2. **Hard-pin 70B for these features.** Requires a governed way to express it — a per-feature
   model override resolved through classification, not a literal in a panel. It would also mean a
   paid provider for a feature the user never chose to run there, which is the exact substitution
   the rest of Henry refuses to make.
3. **Keep a hosted tier.** Would require Henry to host and price a model. Out of scope for a
   desktop app whose only cost-free path is Ollama, and `PROVIDERS.relay` already exists for a
   user who wants to point at a gateway they pay for themselves.

Recommendation: **option 1**, recorded here rather than changed in code. The alternative reading
— "these features must be 70B" — is not supported by the evidence, because the runtime
never delivered 70B either.

**Not changed, deliberately.** `TodayPanel`'s daily-plan still prefers Henry's own loopback sync
service (`127.0.0.1:4242/sync/prompt`) and only falls through to the governed path when it is
not running; that is a local companion feature, not provider egress. Image/video/speech/
geocoding panels post to their own APIs with their own credentials and are outside the chat
path.

---

## 2. Full capability ledger

| Capability | Status | UI→backend trace | Backend/authority | Owner-specific? | Evidence (file:line) |
|---|---|---|---|---|---|
| Finance ledger (transactions) | EXISTS | `FinancePanel.tsx:59` `financeAdd` → preload `:368` → `memory.ts:1331` → `transactions` | SQLite `henry.db`, entirely local | No — generic bookkeeping | `src/components/finance/FinancePanel.tsx:59`; `electron/preload.ts:368`; `electron/ipc/memory.ts:1331` |
| Finance CSV import | **PARTIAL (broken)** | `FinancePanel.tsx:182` `financeCreate` → `memory.ts:1311` → **INSERT fails, no `updated_at` column** | Rejects its own rows and still reports success | No | `src/components/finance/FinancePanel.tsx:182,190,192`; `electron/ipc/memory.ts:1314` vs `:1305-1309` |
| Recurring transactions | EXISTS | `FinancePanel.tsx:51-52` autopost on mount → `memory.ts:1668` → `recurring_transactions` + `transactions` | SQLite, local, idempotent by `[Auto]` prefix | No | `src/components/finance/FinancePanel.tsx:51`; `electron/ipc/memory.ts:1668,1676` |
| QuickBooks accounting connector | **PARTIAL (unreachable)** | agent tools only (no UI) → `quickbooks.ts` → QBO REST | Intuit sandbox/production; OAuth unfinishable, no UI to set client id | Boundary — external SaaS | `electron/agent/tools/quickbooks.ts:111,490,499,506`; no 9006 listener; `electron/integrations/oauth/registry.ts:114-117` |
| Payment processing | **MISSING** | none | none | No — owner-specific | grep: no `stripe`/`payment_intent`/`checkout.session` in `electron/`,`src/` |
| Revenue reporting | PARTIAL | `finance_summary` tool → `transactions` + `quotes` | Local; self-declared as quote-derived, not AR | No | `electron/agent/tools/finance.ts:364,391,401,422` |
| Accounting CSV export | EXISTS (local) | chat regex `syncBridge.ts:7160` → SQL → Desktop CSVs | Local files; user imports manually | No | `electron/ipc/syncBridge.ts:7160,7195,7210` |
| Provider cost accounting | EXISTS | `CostDashboard.tsx:48` → `settings.ts:271` → `cost_log` | SQLite, local | No — Henry's own AI spend | `src/components/costs/CostDashboard.tsx:48`; `electron/ipc/settings.ts:253,271`; `electron/ipc/database.ts:102` |
| Quoting / estimate-to-cash | EXISTS | `QuotingPanel.tsx` → preload `:269-287` → `quoting.ts` 13 handlers | SQLite `quotes` + `quote_line_items` | No — trade-business generic | `electron/ipc/quoting.ts:111,162,208,478,529` |
| Jobs w/ money | EXISTS | business panels → `syncBridge.ts:461` | SQLite `jobs` | No | `electron/ipc/syncBridge.ts:461` |
| Business/control (maker: machines, production, materials, waste, maintenance) | EXISTS | `src/components/maker/*` → `makerStudio.ts`, `machines` | SQLite, local, no network | No | `electron/ipc/makerStudio.ts:96,269-274` |
| Agent discovery (runtime detection) | EXISTS | `AgentRuntimePanel` → `agentRuntimes` → probe | Read-only discovery; never mutates selection | No | `electron/ipc/agentRuntimes.ts`; `electron/runtimes/discovery` |
| Agent/runtime selection | EXISTS | Settings → `coder_engine`, `<engine>_provider/_model` settings rows | Settings table | No | `electron/coder/index.ts:65`; `electron/agent/tools/index.ts:39` |
| Agent execution | EXISTS | `ChatView.tsx:2195` sentinel → `ai:stream` `ai.ts:1497` → `toolRunner.ts:366` `runToolConversation` | ToolRunner + confirm gate | No | `electron/ipc/ai.ts:1497`; `electron/agent/toolRunner.ts:366` |
| Coding/programming | EXISTS | `coder:run` `coder/index.ts:201` → gated by `approveCoderRun` `coder/index.ts:89` → spawns Claude Code / OpenCode / Ollama | **Confirm gate: `requestConfirmation` (`electron/agent/toolRunner.ts:185`), approval-queue row, `app_logs` audit line. Fails closed — refused, timed out or no renderer spawns nothing** | No — one approval covers one run; no setting turns it off | `electron/coder/index.ts:256-271`; `electron/coder/approvalGate.test.ts`; gap G5 below is closed |
| Coder sandbox | EXISTS | `isInsideCoderWorkspace` gates `acceptEdits` | Path confinement outside the gate | No | `electron/coder/claudeCode.ts:34,47-51,62-69` |
| Agent tools (registry) | EXISTS | `agent:list-tools` → `registry.describe()` | 22 kits, one registration point | No — **this is the extension seam** | `electron/agent/tools/index.ts:39-63`; `electron/ipc/agent.ts:31` |
| Computer control | EXISTS | `ComputerPanel` → `computer:*` → `src/platform/inputAutomation.ts` | IPC-gated; shell channels double-gated | No | `electron/ipc/computer.ts`; `electron/ipc/validation.ts:916-921` |
| Multi-computer/device control | EXISTS | companion/phone client → `syncBridge.ts` HTTP+SSE+WS | JWT pairing; LAN needs valid pair token | No | `electron/ipc/syncBridge.ts:9502,9521`; `electron/ipc/companionAuth.ts` |
| Automation (routines) | EXISTS | `RoutinesPanel.tsx:399` `addRoutine` → preload `:296-305` → `scheduler.ts` IPC → `HenryScheduler` | `scheduled_tasks` + `automation_runs` | No | `src/components/routines/RoutinesPanel.tsx:399`; `electron/preload.ts:296`; `electron/ipc/scheduler.ts:42`; `electron/agent/scheduler.ts:280` |
| Scheduler | EXISTS, **in-process only** | same as above; cron/interval/at/event triggers | `HenryScheduler` in main; **no login item, no service, no tray** | No | `electron/agent/scheduler.ts:41,177,300`; `electron/main.ts:1257` (empty `window-all-closed`) |
| Notifications | PARTIAL — local only | `automationNotifications.ts:136`, `main.ts:707,765` | OS-native only; **no push/FCM/APNs path** | No | `electron/ipc/automationNotifications.ts:136`; `electron/main.ts:707` |
| Memory | EXISTS, gated | `memory.ts` handlers → `persistMemory` gate → ~50 tables + vector index | Local SQLite; recall text becomes LLM prompt | No | `electron/ipc/memory.ts:73-80,114`; `electron/ipc/securityPolicy.ts:90` |
| System Map | EXISTS — strong | `useSystemMapScan` → `systemMap:scan/start` → `scanner.ts` | **Metadata-only by type construction**; consent + incremental | No | `electron/systemmap/fsMetadata.ts:1-21`; `electron/ipc/systemMap.ts:186`; `electron/systemmap/scanner.ts:1-43` |
| Monitoring/health | EXISTS | `runtimeDiagnostics` + `selfRepair` + `appLog` + `consoleCapture` | Auto-fix only when `!ok && !indeterminate` | No | `electron/ipc/selfRepair.ts:963`; `electron/ipc/runtimeDiagnostics.ts:113`; `electron/ipc/appLog.ts:221` |
| Project/workspace handling | **PARTIAL — exactly one workspace** | `WorkspaceView` → `henry-workspace` constant | Hardcoded `<userData>/henry-workspace`; no create/switch/list | No | `electron/main.ts:324`; `workspace_root` only in `electron/agent/producerEmitters.test.ts:141` |
| Permissions/authority | EXISTS — **two independent gates** | see §3 | ToolRunner tier gate + IPC channel grant gate | No — **reuse this** | `electron/agent/toolRunner.ts:309-311`; `electron/ipc/validation.ts:916-921,1001-1006` |
| Audit/logging | EXISTS — three stores | approvals → `app_logs` → `sessions.db` | `approvals` `henry.db`; app log 20k rows; tool calls in Python-owned DB | No | `electron/ipc/database.ts:419`; `electron/ipc/approvals.ts:50,80`; `electron/ipc/appLog.ts:170` |
| Secrets/credentials | EXISTS | `safeStorage` `enc:v1:` in `settings` | OAuth tokens provably never reach renderer | No | `electron/ipc/_keyStorage.ts:36-51`; `electron/integrations/ipc.ts:17-23`; `electron/ipc/database.ts:31` |
| API/network surfaces | EXISTS | 5 loopback/LAN listeners | Google, Discord, GitHub, QuickBooks, DDG, LAN printers. **No Henry-hosted backend** | No | `electron/ipc/syncBridge.ts:9521`; `electron/ipc/proxyServer.ts:64`; `electron/ipc/opencodeBridge.ts:403` |
| Provider/runtime adapters | EXISTS | Settings → `classification.ts` (single authority) | Ollama only free path | No | `electron/providers/classification.ts` |
| Integration framework | EXISTS — **the seam** | see §4 | OAuth provider registry + tool kit registration | No — **reuse this** | `electron/integrations/oauth/registry.ts:114-117`; `electron/agent/tools/index.ts:36,60` |
| Settings/persistence | EXISTS | Settings panels → `settings.ts` → `settings` table | SQLite; `secure_delete = ON` | No | `electron/ipc/database.ts:31,40` |
| Failure/recovery | EXISTS | `isRetryableError` → `withRetry` → selfRepair → startup-failure file | Boot failures written **outside** the DB so they survive | No | `electron/ipc/ai.ts:126-151`; `electron/ipc/runtimeDiagnostics.ts:113-127` |

---

## 3. The existing authority / approval model — REUSE, DO NOT REINVENT

**There are TWO independent gates. They do not cover each other. An integration must respect both.**

### Gate 1 — the tool-tier gate (agent-initiated actions)

Every tool declares a `safetyLevel` of `silent` | `notify` | `confirm`
(`electron/agent/types.ts:62`, surfaced by `electron/agent/toolRegistry.ts:59`). The entire gate is
one expression, evaluated centrally in the runner — not per tool:

```ts
const needsApproval =
  tool.safetyLevel === 'confirm' ||
  (tool.safetyLevel === 'silent' && policyFlag('confirmSilentTools'));
```
`electron/agent/toolRunner.ts:309-311`

The comment immediately above is the design guarantee: the confirm tier "is unconditional and
unaffected by the policy … still fails closed when no renderer is present"
(`toolRunner.ts:305-308`). `requestConfirmation` (`toolRunner.ts:155`) emits
`agent:confirm-required`; the renderer answers via `agent:confirm-response`
(`electron/ipc/agent.ts:35`) → `resolveConfirmation` (`toolRunner.ts:138`) → modal
`src/components/agent/ConfirmToolModal.tsx`. Timeout and absent-renderer both **reject**.

Distribution today: 32 `silent`, 7 `notify`, 8 `confirm` (agent kits) and 23/4/14
(integration kits). `electron/agent/tools/safetyPolicy.test.ts` is a **contract test** pinning
tiers — `messages_send`/`email_send`/`calendar_create_event` must always be `confirm`
(`:37-43`), read-only tools must not be (`:71-74`), and `qb_create_invoice` must be confirm
when present (`:51-58`).

### Gate 2 — the IPC channel-grant gate (renderer-initiated privileged actions)

`SHELL_GATED_CHANNELS` — `computer:runShell`, `computer:osascript`, `terminal:exec`,
`printer:sendGcode`, `printer:printGcode` (`electron/ipc/validation.ts:916-921`). A one-shot
grant fingerprinted to the payload, **destroyed on mismatch**, cross-channel grants refused
(`validation.ts:1001-1006`; tests `electron/ipc/ipcBoundary.test.ts:259-320`). Renderer mirror at
`src/components/computer/gatedChannel.ts:66-72`.

### Unconditional hard controls no policy switch may relax

- Shell blocklist (fork bomb, `mkfs`, `dd` to device, `rm -rf` of a sensitive root, Windows
  `format`/`cipher /w`/`bcdedit`/firewall-disable): `electron/ipc/_commandSafety.ts:47-115`.
  `run_shell` is `confirm`-tier and `$HOME`-confined with `.ssh`/`.aws`/`.gnupg` refused
  (`electron/agent/tools/shell.ts:32,53-64,83`).
- Path confinement: `electron/ipc/_pathSafety.ts:25-30,40-56`. Delete is trash-not-unlink after
  `confineToHome` + `evaluateDeleteRequest` (`electron/ipc/computer.ts:1277-1311`), proven to
  leave the file on disk by `electron/ipc/destructiveFileConfinement.test.ts`.
- No agent-facing `file_delete` tool exists at all — the file kit ends at `file_publish`
  (`electron/agent/tools/files.ts:485`).
- A global `ipcMain.handle` wrapper installed at module scope validates ~355 channels before any
  handler body runs (`electron/ipc/validation.ts:1063-1117`).

### Audit — three stores

| Store | Holds | Evidence |
|---|---|---|
| `approvals` (henry.db) | Every approval ask + decision, `args_json` + `decided_args_json`, status CHECK incl. `expired`/`completed` | `electron/ipc/database.ts:419`; `electron/ipc/approvals.ts:50,80,100,114,119` |
| `app_logs` (henry.db) | Operational log, **secrets redacted at write time**, 20 000-row cap, retention-trimmed | `electron/ipc/appLog.ts:100-125,170,221,277` |
| `sessions.db` (Python-owned) | Full `{tool_use, tool_result}` transcript, FTS5-indexed | `electron/ipc/sessionStore.ts:219,248`; `electron/python/session_store.py:351,1199` |

Failure policy, stated plainly: **fail-open on the audit path, fail-closed on the authority path.**
Every approval write is wrapped in try/catch so logging can never block *or* permit an action
(`electron/ipc/approvals.ts:10-13`), while a missing renderer or a 5-minute timeout rejects
(`toolRunner.ts:155-190`).

### Secrets

`safeStorage` encryption with an `enc:v1:` wire format, in three namespaces —
`providers.api_key`, `oauth:<id>`, `agent_cred:<scope>`
(`electron/ipc/_keyStorage.ts:36-51`; `electron/integrations/oauth/credentialStore.ts:28-30`).
OAuth tokens are contractually **never** returned to the renderer
(`electron/integrations/ipc.ts:17-23`), enforced by `electron/integrations/credentialBoundary.test.ts`
which scans whole serialised replies including provoked error paths.
`PRAGMA secure_delete = ON` (`electron/ipc/database.ts:31`) zeroes freed pages — added after a
verified incident where a retired provider key stayed readable in the DB file
(`database.ts:24-30`). Note the one exception: `providers:getAll` deliberately returns
**decrypted** keys to the renderer (`electron/ipc/settings.ts:81-84`, `:120-133`).

---

## 4. The existing integration seam — REUSE THIS

Adding a PrimeTech integration is a **two-entry change**, and the codebase says so itself:

> "Adding a provider is therefore: append an entry here, and (if it has its own API surface) add a
> tool module under `electron/integrations/<id>/`. No new OAuth machinery, no new token store, no
> new IPC wiring."
> `electron/integrations/oauth/registry.ts:9-11`

**The seam, in order:**

1. **Provider identity** — one entry in `PROVIDERS` (`electron/integrations/oauth/registry.ts:114-117`).
   This is the *only* place a provider's identity lives; the PKCE flow, loopback listener, refresh,
   revocation, credential store and IPC surface are all written against `OAuthProviderConfig` with
   **no `if (provider === …)` anywhere**. Existing entries: Google `:21-74` (port 9005), Discord
   `:77-112`. **Adding a provider here is what would have given QuickBooks a callback listener.**
2. **Tools** — a kit returning `ToolDefinition[]`, spread into `registerAllTools`
   (`electron/agent/tools/index.ts:39-63`). `integrationTools()` at
   `electron/agent/tools/index.ts:60` is where
   `googleTools()` + `discordTools()` enter. Each tool **must** declare its `safetyLevel`; the
   contract test will fail the build otherwise.
3. **Channels** — `registerIntegrationHandlers(getDb, getMainWindow)` is already called from main
   (`electron/main.ts:57`, `:612`), so `integration:*` channels are live. Renderer bridge at
   `electron/preload.ts:447-451`. **Gap:** `src/global.d.ts` has **no `integration*` member** on
   `HenryAPI`, so the seam is untyped on the renderer side.

**Dead code at the seam:** `registerIntegrationTools(registry)` (`electron/integrations/index.ts:41`)
is exported but never called — only `integrationTools()` is consumed. Harmless, but do not follow
it as the pattern.

**Do not build a second framework.** There is already: a provider registry, PKCE OAuth with a
loopback listener and DNS-rebinding defence (`electron/integrations/oauth/flow.ts:180,222-245`),
an encrypted credential store, a redacting HTTP client with one forced-refresh retry
(`electron/integrations/httpClient.ts:70-152`), a tool registry with a central approval gate, a
durable approval queue, and a three-store audit trail.

---

## 5. Explicit gaps — each with evidence

| # | Gap | Consequence for the programme | Evidence |
|---|---|---|---|
| G1 | **Payment rail absent.** No processor, no checkout, no webhook. | Never build one in Henry — it belongs to the owner's stack. | grep across `electron/`,`src/`: no `stripe`/`payment_intent`/`checkout.session` |
| G2 | **`finance:create` inserts a non-existent column.** CSV import silently no-ops while reporting success. | Any ingestion integration must not trust `finance:create` until fixed; user-visible false success. | `electron/ipc/memory.ts:1314` vs DDL `:1305-1309`; `src/components/finance/FinancePanel.tsx:182,190,192` |
| G3 | **QuickBooks cannot be connected** — no 9006 listener, no client-id UI, not in the OAuth registry. | Henry's accounting connector is unreachable; do not plan around `qb_*`. | `electron/agent/tools/quickbooks.ts:111,490,499`; `electron/integrations/oauth/registry.ts:114-117` |
| G4 | **Financial summaries bypass the provider authority.** 9 panels hardcode the Henry proxy from the renderer. | Financial data leaves the machine unrouted, unlogged to `cost_log`, ungoverned by security policy. | `src/components/finance/FinancePanel.tsx:91,206`; `src/components/today/TodayPanel.tsx:172`; `src/components/tasks/TasksPanel.tsx:64`; `src/components/goals/GoalsPanel.tsx:97` |
| G5 | **CLOSED — the coder engine no longer bypasses the authority model.** `coder:run` was spawning Claude Code/OpenCode with no `safetyLevel`, no approval queue row and no audit record. It now routes through the agent's own `requestConfirmation` before any process starts: one approval-queue row, one `app_logs` audit line, and no spawn when the answer is refused, expires, or has no renderer to come from. Path confinement is unchanged and still only advisory to the external CLI. | The largest gap between what Henry claims to gate and what it gates is closed. Residual: the spawned CLI's own `acceptEdits` scope is still the CLI's decision, not Henry's. | `electron/coder/index.ts:89,256-271`; `electron/agent/toolRunner.ts:185`; `electron/coder/approvalGate.test.ts` (updated at HEAD `1d9b846`; PARTIAL at baseline `9598c53`) |
| G6 | **Exactly one workspace, hardcoded.** No create/switch/list; `workspace_root` is written only by a test. | Multi-project work needs a new concept, or an external convention. | `electron/main.ts:324`; `electron/agent/producerEmitters.test.ts:141` |
| G7 | **Nothing executes when the app is not running.** No login item, no service, no tray. The `window-all-closed` handler is empty and its comment ("quit on all-windows-closed") does not match — Electron keeps the process alive, but nothing relaunches it after quit or reboot. | All automation is in-process only. Unattended scheduling is a real new capability, not an existing one. | `electron/main.ts:1257-1259` (empty body); no `setLoginItemSettings`, no `new Tray` anywhere |
| G8 | **No push notifications.** OS-native only; no FCM/APNs path. | Remote/mobile alerting is new work. | `electron/ipc/automationNotifications.ts:136`; `electron/main.ts:707,765` — the only three sites |
| G9 | **`HenryAPI` is untyped for integrations.** `integration:*` channels are absent from `src/global.d.ts`. | Renderer work for a new integration starts with hand-written types. | `src/global.d.ts:650` (`HenryAPI`); `electron/preload.ts:447-451` |
| G10 | **Agent credential store is unreachable.** `electron/agent/credentials.ts` is fully tested (`:104-181`) but `setCredential`/`getCredential` have **no caller** outside its own test — no IPC handler, no tool. `credential_status` is the only tool and returns booleans. | Do not plan on this store; it is a tested island. | `electron/agent/credentials.ts:43,138,185`; grep finds callers only in that file and `electron/agent/credentials.test.ts` |
| G11 | **Budgets are `localStorage` only** — outside SQLite, unsynced, unbacked-up. | Finance is not one store; a migration would be needed before Henry can be the system of record for anything. | `src/components/finance/FinancePanel.tsx:116,127` |

---

## 6. Findings summary

**What Henry genuinely has end to end.** A local-first Electron assistant with a real tool
architecture: 22 registered tool kits behind one central approval gate, a durable approval queue,
a three-store audit trail, encrypted credentials with a proven renderer boundary, an OAuth
integration framework with two working providers, a metadata-only System Map that is
*structurally incapable* of reading file content (`fsMetadata.ts:1-21` — the read capability is
removed from the type, not merely forbidden by comment), in-process automation with cron/interval/
event triggers and run history, and a strong monitoring/self-repair layer that fails closed.

**What is local-only or placeholder.** All of Henry's finance. It is a good local bookkeeping
ledger — `transactions`, `quotes`, `jobs`, recurring autopost, CSV export — and it is **not** a
financial system: no payments, no bank feed that works (the import is broken), no accounting
connection that can be made, and no authority over money. The one Henry-facing number it measures
automatically is its own AI token spend (`cost_log`). The business panels (machines, production,
materials, waste, maintenance) are equally real-and-local: genuine SQLite-backed operations with
no backend.

**The two reuse targets.** The authority model (§3) is genuinely good — two independent gates,
unconditional hard controls that policy may only tighten, a contract test pinning tool tiers, and
a deliberate fail-open-on-audit / fail-closed-on-authority split. The integration seam (§4) is
equally good — one registry entry plus one tool kit, with no `if (provider === …)` anywhere.
**Both must be reused. Neither needs replacing, and the QuickBooks failure is precisely the cost
of not using the seam.**

**The programme's financial boundary, stated plainly.** Henry should be a *surface* over the
owner's financial system — reading and explaining numbers the owner already owns, with the owner
remaining the system of record — not a second ledger competing with it. Building payments,
revenue recognition or an accounting system inside Henry would duplicate a system that already
exists and is already the authority, and Henry's own connectors to it are presently broken (G3).

**Corrections to prior agent findings.** Three claims from delegated research were checked against
source and are **false**, recorded here so they are not repeated:
1. "`PRAGMA secure_delete` appears nowhere" — **false**; it is set at `electron/ipc/database.ts:31`.
2. "System Map is MISSING" — **false**; `electron/systemmap/` (15 files), `electron/ipc/systemMap.ts`
   and `src/components/systemMap/` (5 components) all exist and are wired.
3. "`main.ts` never imports `./integrations`" — **false**; `electron/main.ts:57` imports
   `registerIntegrationHandlers` and `:612` calls it.

---

## 7. WORKSTREAM A — the REAL PrimeRoute API, mapped

**Added after §1–§6. Nothing above is replaced.** This section answers a different question:
*what does PrimeRoute actually expose, and where does that meet Henry?*

**PrimeRoute baseline.** Repo `/mnt/e/PrimeRoute`, HEAD `be62040`, package `primeroute`
`0.1.0.dev0` (`src/primeroute/__init__.py:3`), proprietary (`LicenseRef-Proprietary`,
"Prime Tech" authors, own git repo). Every endpoint below is cited to `file:line` in that
tree. Henry baseline is HEAD `1d9b846`.

**Citation convention.** PrimeRoute citations are exact `file:line`. Henry citations are exact
`file:line` too, **except** inside `electron/ipc/ai.ts`, which another workstream is editing
concurrently; there the citation is symbol-anchored (`ai.ts:resolveRelayBaseUrl`) because the
line numbers move under a concurrent writer. This is stated rather than hidden.

**Status vocabulary, extended for this section.**
`EXISTS` — the PrimeRoute endpoint is real, callable today, and Henry has a working counterpart.
`EXISTS / NO HENRY SURFACE` — real and callable; Henry has no surface for it at all.
`INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` — the endpoint is real, but the surface
that would drive it belongs to the owner's separate admin panel, which is being built
independently and is **not** this programme's job. Its absence must not block honest completion.
`NEVER IN HENRY` — real, but shipping it in a desktop app would be a security or authority
violation. Recorded so it is never proposed.

**The one-sentence answer.** PrimeRoute is an **Australian-first multi-provider AI inference
routing gateway** (`src/primeroute/app.py:183`) with two disjoint halves: a **customer** half
(`/v1/*`, a `pr_` bearer key) and an **operator** half (`/api/admin/*` and `/api/security/*`,
different transports entirely). **Henry may only ever touch the customer half.**

### 7.1 What PrimeRoute actually is

| Fact | Value | Evidence |
|---|---|---|
| Transport | FastAPI, single ASGI app | `src/primeroute/app.py:181-186` (`app = FastAPI(...)`) |
| Self-description | "Australian-first multi-provider AI inference routing gateway" | `src/primeroute/app.py:183` |
| Routers mounted | `health`, `models`, `chat`, `commercial`, `deployment`, `admin`, `security` | `src/primeroute/app.py:228-234` |
| Inference dialect | OpenAI-compatible `chat.completions`; optional `X-PrimeRoute-*` routing headers | `src/primeroute/api/chat.py:66`; `src/primeroute/routing/options.py:26-32` |
| Router prefixes | `/health*` (no prefix), `/v1` (models + chat + commercial), `/api/admin` (admin **and** deployment), `/api/security` (operator) | `health.py:26`, `models.py:13`, `chat.py:38`, `commercial.py:49`, `admin.py:56`, `deployment.py:29`, `security.py:54` |
| SPA console | React console mounted as a catch-all at `/` | `src/primeroute/app.py:230-249`; reserved prefixes `/v1`, `/api/admin`, `/health`, `/assets` at `:73-84` |
| API introspection | `/docs`, `/redoc`, `/openapi.json` are **disabled in production** | `src/primeroute/app.py:186-188` (`docs_url=None if production else "/docs"`) |
| Hardening present | trusted-host rejection added first so it runs outermost (`app.py:204-210`), body-size cap measured on the real ASGI body not `Content-Length` (`app.py:202-203`, middleware class `:283`), optional forced HTTPS (`app.py:211-212`), CORS from environment-specific origins only (`app.py:216-226`) | as cited |

**Consequence for Henry.** PrimeRoute publishes **no OpenAPI document in production**, so a Henry
client cannot discover this surface at runtime. Any integration must be written against a
pinned contract, which is exactly what §7.3 is.

### 7.2 Authentication, established from source — three disjoint credential domains

PrimeRoute's own module docstring names three domains and the rule that keeps them apart
(`src/primeroute/security/capabilities.py:8-18`): *customer* (`pr_` keys), *supplier* (future
third-party model owners), *operator* (`pra_` Admin keys). **A capability belongs to exactly one
domain and a credential never carries capabilities across domains** (`capabilities.py:15-18`).

| | **Customer** | **Operator (Admin)** | **Supplier** |
|---|---|---|---|
| Credential | API key, prefix `pr_` (`security/secrets.py:15`) | Admin key, prefix `pra_` (`security/operator_credentials.py:37`), **plus** a password **plus** a TOTP code or recovery code | not implemented |
| Storage | SHA-256 digest only, constant-time compare (`security/secrets.py:65-75`; `auth/service.py:83-100`) | digest only; plaintext returned exactly once at creation (`api/security.py:565-613`, `:118-122`) | — |
| Header | `Authorization: Bearer pr_…` (`api/deps.py:42-48`) | `Authorization: Session <token>` (`api/security.py:166-173`) | — |
| Gate | `require_api_key` — `api/deps.py:38` | `current_operator` — `api/security.py:176`, plus `require_capability` `:205` / `require_step_up` `:220` | — |
| Authority | the owning `User` row only; role is irrelevant | 40+ `Capability` values (`capabilities.py:26-97`), server-enforced, fail-closed on unknown values (`capabilities.py:148-166`) | — |
| Minted by | `POST /api/admin/api-keys` (`api/admin.py:426`) or the server operator's CLI (`cli/main.py:281-304`) | `POST /api/security/keys` (`api/security.py:565`) or `primeroute keys create` (`cli/security.py:345`) | — |
| Session lifetime | none — long-lived bearer | idle 15 min / absolute 60 min (`security/operator_auth.py:54-55`); step-up grant 5 min (`:59`) | — |
| Failure message | specific OpenAI-shaped codes: `authentication_required`, `invalid_api_key`, `inactive_user` (`deps.py:47`, `:55`, `:61`) | deliberately identical for every failure — `401 authentication required` / `401 authentication failed` (`security.py:166-173`, `:251-253`, `:266-269`) | — |

**The admin API is *not* on the operator transport.** This is the single most important fact in
this section. `require_admin` (`src/primeroute/api/deps.py:73`) calls `require_api_key` first
(`:76`) and then checks only `user.role in {"owner", "admin"}` (`:80`) — so **all 40
`/api/admin/*` endpoints (31 in `admin.py`, 9 in `deployment.py`) are authorised by an ordinary
`pr_` bearer key belonging to a user whose role happens to be `owner` or `admin`.** It is a
*customer-shaped credential carrying a role flag*, not a `pra_` key and not an operator session.
Confirmed exhaustively: every route in `admin.py` and `deployment.py` declares
`Depends(require_admin)`, and no route in either file declares any other dependency.

**What a desktop client may legitimately hold: exactly one thing — a `pr_` customer API key.**
Everything else is off-limits, and the reasons are not stylistic:

1. **No `pra_` Admin key.** It is the first of three mandatory factors for a privileged control
   plane (`api/security.py:69-76`, `operator_auth.py:199-216`) and the key itself can carry any
   capability in `ALL_CAPABILITIES` (`capabilities.py:119-120`) — including `SYSTEM_MANAGE`,
   `KEYS_CREATE`, `KEYS_REVOKE`, `EMERGENCY_EXECUTE`. A laptop holding one can suspend the
   owner's entire commercial operation. Henry must never ship, prompt for, store, or transmit one.
2. **No operator session token.** Even a valid one is bounded to 15 min idle / 60 min absolute
   (`operator_auth.py:54-55`) and every privileged action additionally demands a fresh password
   **and** a fresh TOTP (`api/security.py:302-327`, `security.py:220-232`). A desktop app cannot
   produce a TOTP it does not own.
3. **No owner/admin `pr_` key.** A key whose user has `role = owner|admin` unlocks all 40
   `/api/admin/*` endpoints (`deps.py:80`). The only difference between that key and a normal
   customer key is which user row it belongs to — so the credential is indistinguishable in
   shape and catastrophic in scope. **Rule for Henry: accept and store a `pr_` key only in a
   context that is explicitly, and verifiably, a customer context, and never let a user paste an
   owner key into a "PrimeRoute API key" field.**
4. **No provider credentials.** PrimeRoute returns credential *presence* only, never material —
   `credential_configured: bool(...)` (`admin.py:322`, `:942`, `:1350`), and the credential
   reference is never exposed (`admin.py:1348-1351` comment). Nothing to hold even if one wanted to.

**A desktop client cannot mint its own key.** Customer keys are created only by an admin endpoint
(`admin.py:426`) or by the server operator's CLI (`cli/main.py:278`). There is **no customer-facing
signup or key-issuance endpoint** — confirmed by reading the whole `/v1` surface. Provisioning is
therefore an out-of-band operator action, and Henry's UI must be written to *receive* a key, never
to obtain one.

### 7.3 CUSTOMER-FACING SURFACE — the only surface Henry may touch

Everything below is gated by `require_api_key` (`api/deps.py:38`) and reachable with a `pr_` key
that does **not** belong to an owner/admin user.

#### 7.3.1 Inference

| PrimeRoute capability | Authoritative service / domain | Interface | Auth / authority | Data or action | Existing Henry capability | Genuine gap |
|---|---|---|---|---|---|---|
| Routed chat completion (buffered) | Routing coordinator → provider adapters — `routing/coordinator.py` via `ChatCoordinator.execute` | `POST /v1/chat/completions` — `api/chat.py:66`; body `ChatCompletionRequest` `api/schemas.py:67-93` | `require_api_key` — `api/chat.py:69` | **Action.** Runs an inference, decrements managed balance if `funding_mode=managed`, writes a `Request` + `RouteAttempt` + `UsageEvent` | `callRelay` (`ai.ts:callRelay`) → `resolveRelayBaseUrl` (`ai.ts:resolveRelayBaseUrl`) already performs `POST {relay_base_url}/chat/completions` with `Bearer` auth | **Small.** Henry's `relay` provider is the correct transport and needs no new code — only a `pr_` key plumbed to `params.apiKey` and a base URL of `https://<host>/v1` |
| Routed chat completion (streaming SSE) | Same coordinator, `prepare_stream` — `api/chat.py:103` | `POST /v1/chat/completions` with `stream: true` — response built at `api/chat.py:128-155` | same | **Action.** OpenAI-shaped SSE terminated by `data: [DONE]` (`:148`); headers `X-PrimeRoute-Request-ID`, `X-PrimeRoute-Route` (`api/chat.py:130-139`) | `streamRelay` (`ai.ts:streamRelay`) → shared `streamOpenAIShaped` (`ai.ts:streamOpenAIShaped`), SSE delta parser `consumeOpenAISse` | **Small.** Dialect already matches; the `x_primeroute` additive object (`api/chat.py:194-200`) is simply ignored by Henry's parser, which is safe |
| Model catalogue | `models/registry.py` + `registry/repository.py` — **PrimeRoute's** catalogue, not raw provider models | `GET /v1/models` — `api/models.py:16`; `ModelListResponse` `api/schemas.py:367-369` | `require_api_key` — `api/models.py:20` | **Data.** `[id, created, owned_by]`, filtered by internal-context setting (`api/models.py:24-25`) | None. Henry's model lists are a hardcoded renderer constant (`src/providers/models.ts:212-311`) plus runtime discovery (`electron/runtimes/adapters/`) | **Real.** No remote catalogue fetch, no cache, no refresh. Henry cannot currently see what PrimeRoute will actually route to |
| Health / liveness / readiness | `health/` trackers | `GET /health` `api/health.py:29`; `GET /health/live` `:39`; `GET /health/ready` `:45` | **None — public** | **Data.** `{status, service, version}`; readiness adds `role` and a `database: ok/unavailable` **name only** (`api/health.py:65-77`) | `runtimeDiagnostics` (`electron/ipc/runtimeDiagnostics.ts`), `selfRepair` (`electron/ipc/selfRepair.ts`) — but for **Henry's own process**, never a remote peer | **Real.** A remote-service reachability probe would be new. Note the surface is deliberately information-free (`api/health.py:11-17`) and must not be read as a capability probe |
| Per-request routing policy (auto / preferred / cheapest / fastest / au-only / privacy, region, residency, max fallbacks, funding mode, use mode) | `routing/options.py` — merged from headers and body | `POST /v1/chat/completions` request headers `X-PrimeRoute-Policy`, `-Region`, `-Fallback-Outside-Region`, `-Residency`, `-Max-Fallbacks`, `-Funding-Mode`, `-Use-Mode` — constants at `routing/options.py:26-32`, merged at `:75-131` | same as the call that carries them | **Data (per call).** Body values take precedence over headers (`routing/options.py:96-131`) | **None.** `AiRequest` (`ai.ts:AiRequest`) declares no header field, and every header object in the AI path is a hardcoded literal (`ai.ts:streamOpenAIShaped`) | **Real, and blocking the headline feature.** Henry's streaming path forwards **no arbitrary custom headers**, so "cheapest" / "au-only" / "privacy" cannot be selected from Henry at all. This is the one gap that makes a PrimeRoute *routing* client impossible today even though the *transport* works |
| Routing product ids (`primeroute/auto`, `/fast`, `/economy`, `/code`, `/reasoning`, `/australia`) | `routing/products.py` — a policy over potentially different models, not an alias | Model string `primeroute/…` on `POST /v1/chat/completions`; recognised at `api/chat.py:85-86`; defined at `providers/catalog.py:228-238` | same | **Data → Action.** Selects the policy, then routes | None | **Real.** Same header/body gap; the product ids would arrive as plain model strings and would work today, but the *policy* behind them would be unreachable by user choice |

#### 7.3.2 Commercial self-service (read-only for Henry; one action that only opens a URL)

All of `/v1/account`, `/v1/balance`, `/v1/transactions`, `/v1/products`, `/v1/checkout`,
`/v1/pricing`, `/v1/usage` are gated by `require_api_key` via `get_current_customer`
(`api/commercial.py:196-208`), which **auto-creates the `Customer` row on first authenticated
call** (`commercial.py:204-207`).

| PrimeRoute capability | Authoritative service / domain | Interface | Auth / authority | Data or action | Existing Henry capability | Genuine gap |
|---|---|---|---|---|---|---|
| Customer account profile | `commercial/customer.py` — `CustomerService` | `GET /v1/account` — `api/commercial.py:212`; `AccountResponse` `:126-135` | `get_current_customer` → `require_api_key` | **Data.** `customer_id`, `user_id`, `billing_email`, `currency`, `status`, `payment_processor`, `created_at` | None | **Real.** No remote-account surface exists anywhere in Henry |
| Credit balance | `commercial/credit.py` — `CreditService.get_balance / get_total_balance / get_reserved_balance` | `GET /v1/balance` — `api/commercial.py:228-245`; `BalanceResponse` `:68-74` | same | **Data.** `available` / `total` / `reserved` / `currency`, all as **strings**, `Decimal` serialised exactly (`:37-45`) | None. Henry's finance area is a **local SQLite ledger** (§1) and is not a balance; `src/components/finance/FinancePanel.tsx:263` computes `Net:` from local rows only | **Real, and must stay read-through.** A remote balance display is greenfield — and it is a *display of PrimeRoute's number*, never a second store of it |
| Funding / adjustment / refund / debit history | `db/models.py` tables `FundingTransaction`, `CreditAdjustment`, `Refund`, `LedgerEntry`; `usage/ledger.py:units_to_money` | `GET /v1/transactions` — `api/commercial.py:247-371`; `TransactionsResponse` `:91-95` | same | **Data.** Four sources merged, sorted `created_at` desc, truncated to `limit` (`:362-363`) | None | **Real.** Also note a real pagination quirk to design around: `limit`/`offset` are applied **per source query** — four separate pairs at `:258-262`, `:268-272`, `:278-282`, `:288-292` — and then again after the merge, so `pagination.total` (`:370`) is the page length, not the account's transaction count |
| Credit products for purchase | `commercial/credit.py:list_credit_products(visible_only, active_only)` | `GET /v1/products` — `api/commercial.py:375-394`; `ProductsResponse` `:110-113` | `require_api_key` — via `get_credit_service` (`:171-172`, `:377`) with **no** customer dependency; this is a global catalogue | **Data.** `product_id`, `name`, `purchase_amount`, `credited_amount`, `currency`, `active` | None | **Real** |
| Checkout | `commercial/payment.py:PaymentService` behind `CustomerService.create_checkout_session` | `POST /v1/checkout` — `api/commercial.py:397-459`; `CheckoutRequest` `:53-58`, `CheckoutResponse` `:61-65` | `get_current_customer` + `require_api_key`; 403 `customer_suspended` if status ≠ active (`:408-412`); 503 `commercial_suspended` from the kill switch (`:416-424`); 404 unknown product (`:426-428`); 400 URLs unconfigured (`:434-435`) | **Action — but the action is "open a browser at a URL".** Returns `session_id` + `checkout_url` (`:437-459`). Money moves in the processor; PrimeRoute receives a signed webhook | None | **Real.** Note the `success_url`/`cancel_url` fall back to server settings `checkout_success_url` / `checkout_cancel_url` (`:431-432`), so a desktop flow is possible but depends on server config Henry cannot verify |
| Pricing / plan | `commercial/pricing.py:PricingService.get_customer_pricing_info` | `GET /v1/pricing` — `api/commercial.py:462-477`; `PricingInfoResponse` `:116-123` | same | **Data.** `plan_id`, `name`, `currency`, `type`, `description`; falls back to a literal `default` / `pass_through` object when no plan exists (`:467-473`) | None | **Real** |
| Usage history | `db/models.py` `Request` + `UsageEvent`, filtered by `customer.user_uuid` | `GET /v1/usage` — `api/commercial.py:480-556`; `UsageResponse` `:151-157` | same | **Data.** `request_id`, `model`, token counts, `cost`, **`cost_source`**, `created_at`. `cost_source` is honest: `"unavailable"` rather than a fabricated zero when no event exists (`:537-546`) | **Partial.** `cost_log` (`electron/ipc/database.ts:101-112`), written at `electron/ipc/settings.ts:252-262` and read at `:270-281`; dashboard `src/components/costs/CostDashboard.tsx:48` | **Real, and it is an *addition*, not a migration.** `cost_log` is Henry's own local estimate from a hardcoded `MODEL_PRICING` table (`ai.ts:calculateCost`, `ai.ts:MODEL_PRICING`) with `tokens_input` hardcoded to `0` (`settings.ts:254`) and `task_id` never written. PrimeRoute's usage is **truth about what the gateway was actually billed**, including the route chosen. It must be surfaced as a second, clearly-labelled source — never merged into `cost_log` |
| Payment webhook intake | `commercial/payment.py:process_webhook` | `POST /v1/webhooks/payments` — `api/commercial.py:560-620` | **NONE — public.** Authenticated by the `stripe-signature` header computed over the raw byte stream (`:567-581`) | **Action.** Credits the account. 404 if `payments_enabled` false (`:573-574`); 503 if payment intake is blocked (`:586-597`) | None | **`NEVER IN HENRY`.** A desktop app must not receive, verify, or replay payment webhooks. Recorded so it is never proposed |

### 7.4 ADMIN / OPERATOR SURFACE — not Henry's, and why

**This is the section the programme most needs and most must not act on.** 65 endpoints exist
across all seven routers; 52 of them sit behind an operator credential. They are listed in full so
the boundary is auditable, not so it can be built.

#### 7.4.1 `/api/admin/*` — the management API (31 endpoints, `admin.py:56`)

Every one is gated by `require_admin` (`deps.py:73`), i.e. **an `pr_` key on an owner/admin user**.
Within it the 18 read-only endpoints are the ones an operator panel would surface and are marked
`INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE`; the 13 that mutate state are marked
`NEVER IN HENRY`.

| Capability | Interface | Auth | Data or action | Henry status |
|---|---|---|---|---|
| Dashboard overview | `GET /api/admin/overview` `admin.py:127` | `require_admin` `:130` | Data: counts, 24 h usage, recent requests, migration status | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Provider list | `GET /api/admin/providers` `admin.py:301` | `:304` | Data: metadata + `credential_configured` bool only `:322` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` — **a provider registry, owned by PrimeRoute** |
| Models + routes | `GET /api/admin/models-routes` `admin.py:347` | `:350` | Data: per-route upstream model, price/token, health `:379-392` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Customer API key list | `GET /api/admin/api-keys` `admin.py:402` | `:405` | Data: key metadata only, never material `:411-422` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Customer API key issue / revoke | `POST /api/admin/api-keys` `admin.py:426`; `POST /api/admin/api-keys/{key_id}/revoke` `:459` | `:430`,`:463` | **Action.** Mints and revokes `pr_` keys; plaintext returned once `:448-456`; both audited `:440-446`, `:485-492` | `NEVER IN HENRY` — this is the authority that would issue Henry's own credential |
| Usage aggregates | `GET /api/admin/usage` `admin.py:502` (`period` 1h/24h/7d/30d `:504`) | `:506` | Data: totals, by provider, by model; money summed as `Decimal`, never as a SQL float `:514-516` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` — operator-wide, not account-scoped |
| Request log | `GET /api/admin/requests` `admin.py:610`; `GET /api/admin/requests/{request_id}` `:682` | `:616`,`:686` | Data: per-request attempts, usage, **audit timeline** `:768-777` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` — cross-account observability |
| System settings | `GET /api/admin/settings` `admin.py:800` | `:803` | Data: routing policy, limits, provider credential **status**, and the **resolved operator identity** — built from the database at `:834-842`, emitted at `:884` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Provider detail | `GET /api/admin/providers/{provider_id}` `admin.py:912` | `:916` | Data + `adapter_support` `:947` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Supply catalogue | `GET /api/admin/supply/catalogue` `admin.py:1047` | `:1050` | Data: the static `PROVIDER_CATALOGUE` `:1052` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` — **the provider registry PrimeRoute owns** |
| Redundancy | `GET /api/admin/redundancy` `admin.py:1165` | `:1168` | Data | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Managed-economics suspension state | `GET /api/admin/managed-suspension` `admin.py:1188` | `:1191` | Data: active / reason / state | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Set managed-economics suspension | `POST /api/admin/managed-suspension` `admin.py:1215` | `:1219` | **Action.** Global kill switch for managed routing, audited with full before/after state `:1240-1249` | `NEVER IN HENRY` |
| Commercial suspension state | `GET /api/admin/commercial-suspension` `admin.py:1259` | `:1262` | Data: `SuspensionService.snapshot` (`commercial/suspension.py:121`) | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Set commercial suspension | `POST /api/admin/commercial-suspension` `admin.py:1269` | `:1273` | **Action.** Global kill switch for checkouts | `NEVER IN HENRY` |
| Route list | `GET /api/admin/routes` `admin.py:1282` | `:1285` | Data: capacity, circuit state, credential **source**, region — `_route_summary` `:1327-1362` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| External catalogue history | `GET /api/admin/external-catalog/imports` `admin.py:1532`; `GET …/{import_id}` `:1576`; `GET …/provider-mappings` `:1638` | `:1537`,`:1582`,`:1644` | Data: import history, digests, mapping status | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Provider enable / disable | `PATCH /api/admin/providers/{provider_id}` `admin.py:888` | `:893` | **Action.** `row.enabled = body.enabled` `:901`, audited `:902-908` | `NEVER IN HENRY` |
| Live provider health probe | `POST /api/admin/providers/{provider_id}/test-health` `admin.py:958` | `:962` | **Action.** Resolves the credential and calls the upstream provider `:982-986` | `NEVER IN HENRY` |
| Provider model discovery | `POST /api/admin/providers/{provider_id}/refresh-models` `admin.py:996` | `:1000` | **Action.** Lists upstream models; explicitly `"activated": False` — evidence, never authorisation `:1037-1042` | `NEVER IN HENRY` |
| Route technical readiness | `POST /api/admin/routes/{route_id}/readiness` `admin.py:1406` | `:1410` | **Action.** Writes `technical_status` | `NEVER IN HENRY` |
| Route mutation | `PATCH /api/admin/routes/{route_id}` `admin.py:1453` | `:1458` | **Action.** enabled / technical_status / region_verified / full rights record; every write sets `external_operator_override = True` `:1471-1474` | `NEVER IN HENRY` |
| External catalogue preview / apply / bind | `POST /api/admin/external-catalog/imports/{import_id}/preview` `admin.py:1594`; `…/apply` `:1618`; `POST /api/admin/external-catalog/routes/{route_id}/bind` `:1666` | `:1601`,`:1623`,`:1671` | **Action.** Stage / preview (digest-bound `preview_token`, `api/schemas.py:309`) / apply — the only **advisory** writer of model-route records | `NEVER IN HENRY` |

#### 7.4.2 `/api/admin/*` — deployment / activation / emergency (`deployment.py:29`, 9 endpoints)

Also `require_admin`, but semantically the *control plane* that can stop the business. Five are
read-only; four mutate state and can halt routing or billing.

| Capability | Interface | Auth | Data or action | Henry status |
|---|---|---|---|---|
| Launch readiness report | `GET /api/admin/readiness` `deployment.py:92` | `:95` | Data: the single authoritative launch evaluation with every blocker named `:101-103` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Deployment profile | `GET /api/admin/deployment` `deployment.py:107` | `:110` | Data: role, dialect, payments mode, **credential presence only** `:144-146` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Activation summary | `GET /api/admin/activation` `deployment.py:169` | `:172` | Data: how many routes sit at each of the 7 activation levels (`activation/levels.py:26-42`), plus per-route rows `:176-190` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Per-route activation gates | `GET /api/admin/activation/{route_id}` `deployment.py:193` | `:196` | Data: every gate for one route, production and test-only, with the blocking ones named `:212-218` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Emergency stop state | `GET /api/admin/emergency` `deployment.py:264` | `:267` | Data: every independent stop in one place `:269-272` | `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` |
| Route activation transition | `POST /api/admin/activation/{route_id}` `deployment.py:222` | `:226` | **Action.** Explicit operator transition only; a refusal is a 409 naming the blocked gates `:251-256` | `NEVER IN HENRY` |
| Set global emergency stops | `POST /api/admin/emergency` `deployment.py:275` | `:278` | **Action.** Independent `new_checkouts_blocked` / `new_managed_inference_blocked` / `payment_events_blocked` stops (`deployment.py:65-70`) | `NEVER IN HENRY` |
| Provider suspension | `POST /api/admin/emergency/provider/{provider_id}` `deployment.py:296` | `:301` | **Action.** Stops every route on one provider `:306-312` | `NEVER IN HENRY` |
| Route suspension | `POST /api/admin/emergency/route/{route_id}` `deployment.py:319` | `:324` | **Action.** Stops one route, whatever its activation level `:329-332` | `NEVER IN HENRY` |

#### 7.4.3 `/api/security/*` — operator control plane (`security.py:54`, 12 endpoints)

On a **different transport**: `Authorization: Session <token>` (`security.py:166-173`), a scheme
`Bearer` keys can never satisfy. This is the surface the owner's separate desktop Admin app
(`/mnt/e/PrimeRoute/apps/admin/README.md:1-8`, a Tauri shell around the React console) drives.

| Capability | Interface | Auth | Data or action | Henry status |
|---|---|---|---|---|
| Three-factor operator login | `POST /api/security/authenticate` `security.py:242` | none inbound | **Action.** `admin_key` + `password` + (`totp_code` **or** `recovery_code`) — all three mandatory `:247-253`; returns the session token once `:271-279` | `NEVER IN HENRY` |
| Session introspection | `GET /api/security/session` `security.py:281` | `current_operator` `:284` | Data: identity, capabilities, deadlines, client label `:289-299` | `NEVER IN HENRY` |
| Step-up grant | `POST /api/security/step-up` `security.py:302` | `current_operator` `:306` | **Action.** A fresh password **and** a fresh TOTP (`:308-317`); the grant is 5 minutes (`security/operator_auth.py:59`) | `NEVER IN HENRY` |
| Logout | `POST /api/security/logout` `security.py:329` | `current_operator` `:332` | **Action.** Server-side revoke | `NEVER IN HENRY` |
| MFA enrol / confirm / remove | `POST /api/security/mfa/enroll` `security.py:346`; `POST …/confirm` `:382`; `DELETE /api/security/mfa` `:437` | `SECURITY_MANAGE` `:349`,`:386`; step-up `:440` | **Action.** The secret is held in **process memory only** until the first code verifies (`:362-366`, `:377-379`), so an unconfirmed enrolment leaves nothing usable behind | `NEVER IN HENRY` |
| Operator password | `POST /api/security/password` `security.py:470` | `current_operator` `:474` | **Action.** Weak-password policy (`security/operator_credentials.py`); the current password is required to change an existing one `:498-500` | `NEVER IN HENRY` |
| Admin keys | `GET /api/security/keys` `security.py:543`; `POST …/keys` `:565`; `POST …/keys/{key_id}/revoke` `:615` | `KEYS_READ` `:547`; step-up `KEYS_CREATE` `:570`; step-up `KEYS_REVOKE` `:619` | **Action.** Issues `pra_` keys with a capability list; an empty list defaults to a read-only set `:580-581` | `NEVER IN HENRY` |
| Recovery codes | `POST /api/security/recovery-codes` `security.py:646` | step-up `SECURITY_MANAGE` `:650` | **Action.** Regenerates the set, deleting every prior code first `:660`, `:665` | `NEVER IN HENRY` |

**Standing rule, recorded once.** The PrimeRoute standalone admin panel is being built
separately by the owner (`apps/admin/README.md:1-8`) and **is not this programme's job**. Henry
must not build, ship, embed, or proxy any of §7.4. Where a row above is marked
`INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE`, the endpoint is real, the contract is
recorded here, and the **surface** belongs to that separate product — its absence is a fact about
*a different workstream*, not a gap for Henry to close. The programme's honest completion is to
record the contract and stop.

### 7.5 What genuinely exists today vs what is admin-panel-dependent

| | Count | Composition |
|---|---|---|
| **Genuinely exists and is callable by a customer key** | 12 | 3 health (public), `/v1/models`, `/v1/chat/completions`, and 7 `/v1` commercial endpoints (`account`, `balance`, `transactions`, `products`, `checkout`, `pricing`, `usage`) |
| **Public but not for a client** | 1 | `POST /v1/webhooks/payments` — processor-to-server only |
| **Real and read-only, but the surface belongs to the owner's separate admin panel** | 23 | 18 read-only `/api/admin/*` management endpoints + 5 read-only deployment endpoints (`readiness`, `deployment`, `activation`, `activation/{route_id}`, `emergency`). Marked `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE` in §7.4.1–7.4.2 |
| **Real, mutating, and Henry must never call it** | 29 | 13 `/api/admin/*` writes + 4 deployment writes (activation transitions, both kill switches, provider and route suspension) + all 12 `/api/security/*` operator-control-plane endpoints. Marked `NEVER IN HENRY` |

**Arithmetic check.** 12 + 1 + 23 + 29 = **65**, which equals the total route decorators across
the seven routers (`health.py` 3, `models.py` 1, `chat.py` 1, `commercial.py` 8, `admin.py` 31,
`deployment.py` 9, `security.py` 12). Every PrimeRoute endpoint is accounted for exactly once.

### 7.6 Henry-side seam reality — what is already there, precisely

**A PrimeRoute *transport* already exists and does not need to be written.** Henry's `relay`
provider is an arbitrary user-supplied OpenAI-compatible endpoint:

- Base URL in the `settings` table under the single key `relay_base_url`
  (`ai.ts:resolveRelayBaseUrl`), validated `http(s)` and with `/chat/completions` appended by
  Henry (`ai.ts:resolveRelayBaseUrl`).
- Buffered call `ai.ts:callRelay`; streaming call `ai.ts:streamRelay`; tool-call URL
  `ai.ts:openAIShapedUrl`.
- Renderer UI already exists: `RelayRow`, `src/components/settings/SettingsView.tsx:571-623`
  (http(s) validation `:580-583`, save at `:586`).
- Provider keys are stored in the `providers` table (`electron/ipc/database.ts:47-55`), encrypted
  at rest with `safeStorage` under `enc:v1:` (`electron/ipc/_keyStorage.ts:20`, `:35-51`), and set
  through `providers:save` (`electron/ipc/settings.ts:98-155`, encrypt at `:110`).
- The `providers` table `id` is a free-form `TEXT PRIMARY KEY` (`database.ts:48`) and
  `providers:save` accepts any non-empty id under 64 chars (`electron/ipc/validation.ts:296`), so
  a `primeroute` row **can already be persisted today**.

**What blocks it, in order of severity:**

1. **No custom request headers anywhere in the AI path** — `AiRequest` (`ai.ts:AiRequest`) declares
   no header field, and `ai.ts:streamOpenAIShaped` builds a hardcoded header literal. Every
   `X-PrimeRoute-*` routing control (§7.3.1) is therefore unreachable from Henry. **This is the
   headline gap.**
2. **No transport case for a new provider id.** The dispatch switch
   (`ai.ts:callAI`, mirrored in the `ai:stream` handler) covers `openai`, `anthropic`, `google`,
   `ollama`, `relay`, `opencode`, `opencode-zen` and throws `Unknown provider` otherwise — so
   persisting a `primeroute` provider row produces a provider that cannot be called.
3. **No key-entry UI for `relay`.** `CLOUD_PROVIDER_IDS` is a hardcoded four-element tuple
   (`src/components/settings/SettingsView.tsx:95`) rendered at `:271`, and `relay` is not in it.
4. **The reusable REST helper is OAuth-coupled.** `electron/integrations/httpClient.ts` supports an
   arbitrary `baseUrl` (`:36`) and arbitrary `headers` (`:35`, merged last at `:94-98`) — but
   `provider` is mandatory and typed `OAuthProviderConfig` (`:31`, `oauth/types.ts:36-96`), it
   calls `ensureAccessToken` first (`:79-87`), and it buffers the whole response (`:122`), so it
   cannot stream. It is the right shape for the `/v1` commercial calls with a signature change,
   and the wrong shape for `/v1/chat/completions`.
5. **No remote-usage or remote-balance display exists anywhere.** Searched `src/` and `electron/`
   for `balance|subscription|credits?|quota|plan`: every hit is local receivables
   (`electron/ipc/syncBridge.ts:2114`, `src/components/finance/FinancePanel.tsx:263`), error-string
   classification (`src/henry/errorMessages.ts:57-59`), free-tier editorial copy
   (`src/providers/models.ts:245`), or an unrelated homonym. **Greenfield.**

### 7.7 Gaps G12–G18, extending §5

| # | Gap | Consequence for the programme | Evidence (PrimeRoute) | Evidence (Henry) |
|---|---|---|---|---|
| G12 | **Henry cannot set a single `X-PrimeRoute-*` header.** The routing controls — cheapest, au-only, privacy, region, residency, funding mode — are unreachable, so Henry can be a *PrimeRoute transport* but not a *PrimeRoute routing client*. | Any design promising "cheapest route" or "Australian-only" in Henry is undeliverable until this is fixed. Fix belongs in the AI transport, and is a Henry-internal change. | `routing/options.py:26-32`, `:75-131`; `api/chat.py:79-86` | `ai.ts:AiRequest`; `ai.ts:streamOpenAIShaped` |
| G13 | **A `pr_` key belonging to an owner/admin user is indistinguishable from a customer key and unlocks all 40 `/api/admin/*` endpoints.** | Henry's key-entry UI and its stored-credential contract must state the customer-only scope, and the field must never be framed as "an admin key". | `api/deps.py:73-83`; `api/admin.py` (31 × `Depends(require_admin)`) + `api/deployment.py` (9 ×) | `src/components/settings/SettingsView.tsx:95`, `:194` |
| G14 | **Henry cannot mint or discover a PrimeRoute key, and PrimeRoute has no self-service signup.** | Provisioning is an operator action outside both products. Henry's UI must be written to *receive* a key, and must say so rather than implying a connect flow. | `api/admin.py:426`; `cli/main.py:281-304`; absence across all of `/v1` | no key-entry row for `relay` (`SettingsView.tsx:95`) |
| G15 | **No remote catalogue.** `GET /v1/models` is the only authority on what PrimeRoute will actually route to, and Henry never calls it. | A Henry model picker would otherwise show PrimeRoute models it cannot actually reach. | `api/models.py:16-36` | `src/providers/models.ts:212-311` |
| G16 | **No remote-account surface of any kind** (balance, plan, usage, transactions). | Genuine new UI. Must be a **read-through display** of PrimeRoute's numbers, clearly labelled by source — never merged into `cost_log` and never a second ledger. | `api/commercial.py:212`, `:228`, `:247`, `:462`, `:480` | none; `cost_log` is a local estimate (`electron/ipc/database.ts:101-112`; `settings.ts:252-262`) |
| G17 | **Checkout depends on server-configured `success_url` / `cancel_url`.** | A desktop checkout flow is possible only if those are configured server-side; Henry cannot verify them, only override both per request (`api/commercial.py:431-432`). | `api/commercial.py:397-459` | n/a |
| G18 | **PrimeRoute publishes no OpenAPI schema in production.** | The contract in §7.3 must be pinned in code, not discovered at runtime; a breaking change is invisible to a Henry client until it fails a request. | `src/primeroute/app.py:186-188` | n/a |

### 7.8 Not established / out of scope, recorded honestly

- **Not established:** how `primeroute/*` product ids appear in `GET /v1/models`. The catalogue
  is documented as dynamic ("appears dynamically only when its current route selector has
  eligible routes", `docs/api.md:18-21`), but the exact emission condition was not traced to a
  line. **Not established, not guessed.**
- **Not established:** whether `/v1/transactions`'s per-source `limit`/`offset` behaviour
  (`api/commercial.py:258-262`, `:268-272`, `:278-282`, `:288-292`) is deliberate. The observable
  consequence — `pagination.total` is a page length, not an account total (`api/commercial.py:370`)
  — **is** established and is recorded as a design constraint for any client.
- **Deliberately not investigated:** PrimeRoute's internal domain services (`routing/`,
  `providers/`, `registry/`) beyond the request/response contracts each endpoint actually
  exposes. Henry must not reimplement any of them.
- **Out of scope by instruction:** the contents and behaviour of the owner's standalone admin
  panel. §7.4 records its *API contract* and marks it `NEVER IN HENRY` or
  `INTERFACE READY / AWAITING PRIMEROUTE ADMIN SURFACE`; it does not describe, extend, or
  substitute for that product.

**Workstream A is documentation only. No PrimeRoute client is implemented here, and none should
be until §7.6 blocker 1 and §7.7 G12–G14 have been decided.**
