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
- Two "AI features" are **not provider-routed**: `FinancePanel.tsx:91` and `:206` hardcode
  `fetch('https://henry-proxy.henryai.workers.dev/v1/chat')` from the renderer, bypassing
  `electron/ipc/ai.ts`, the provider classification authority, the cost log and the security
  policy. This is done from 6 panels across 9 call sites
  (`TodayPanel.tsx:172/271/323/400`, `TasksPanel.tsx:64`, `GoalsPanel.tsx:97`,
  `WeeklyReviewPanel.tsx:721`, `CapturesPanel.tsx:279`, `FinancePanel.tsx:91/206`). **Financial
  summaries leave the machine through a path that logs no cost and asks no permission.**
- Budgets are `localStorage` only (`FinancePanel.tsx:116`, `:127`) — never in SQLite, never synced.

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
| Coding/programming | **PARTIAL — bypasses the authority model** | `coder:run` `coder/index.ts:112` → spawns Claude Code / OpenCode / Ollama directly | **No tool-tier gate, no approval queue, no audit row** | No | `electron/coder/index.ts:112,208`; no import of toolRunner in `electron/coder/*` |
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
| G5 | **The coder engine bypasses the authority model entirely** — `coder:run` spawns Claude Code/OpenCode with no `safetyLevel`, no approval queue row, no audit record. Only mitigation is path confinement, which is advisory to the external CLI. | The single largest gap between what Henry claims to gate and what it gates. | `electron/coder/index.ts:112,208` (no toolRunner import in `electron/coder/*`); contrast `electron/coder/claudeCode.ts:62-69` |
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
