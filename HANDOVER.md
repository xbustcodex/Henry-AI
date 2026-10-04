# Henry AI — Campaign Handover

Written by the retiring Space Bunny session so a different coding agent can continue
without reconstructing the campaign from chat history.

**Repository:** `xbustcodex/Henry-AI` (canonical). `/home/buster/henry-ai-desktop` is an
older read-only reference fork — **do not modify it**.
**`v3.0.7` must not be moved.** It points at `0920bbdc` and is deliberately stale.

---

## 1. Final state

| Item | Value |
|---|---|
| Final commit | `9eb73af` (pushed to `origin/main`) |
| Tests | **2262 passing across 130 files** |
| Typecheck | 0 errors |
| `v3.0.7` | `0920bbdc` — unmoved, must stay unmoved |

Recent commits, newest first:

```
9eb73af Fix compressed onboarding layout across the whole first-launch sequence
e6d2ed5 Neutralise macOS copy in the provider stage
2ba49ef Fix three owner-observed onboarding defects and release-pipeline gaps
efa4fd1 Remove previous owner's Apple signing identity from shipped build config
00b63bd Fresh installs start empty and run the complete first-launch setup
186a139 Remove Groq completely from Henry; fix Zen send-time routing
8bfaead Record Zen live acceptance failure
67ecda7 Fix OpenCode Zen usability, local-model discovery, scheduler auth, integration:list
```

## 2. Installed artifact hashes (built from `2ba49ef`, Windows)

```
installer sha256:     193a043bfbdf04a3f877e9986ebae6cb06fd41383339c56f6f0f18daf52f274f
packaged asar sha256: ccf1a5824dc2ee8a7436275b598eee9900e02cf316191ff62132813fbeffcb54
installed asar sha256: ccf1a5824dc2ee8a7436275b598eee9900e02cf316191ff62132813fbeffcb54   (byte-identical)
```

**These predate `e6d2ed5` and `9eb73af`.** A rebuild + reinstall is required before
accepting the layout and macOS-copy fixes on the installed app.

## 3. What is CLOSED

- **Groq removed completely.** Provider registry, router fallback, picker UI, settings,
  onboarding copy, credential classification, env handling, request/streaming adapters,
  credential storage. Generic security fixtures were *converted*, not deleted.
- **No silent provider substitution.** `ProviderRoutingError` names the unresolved
  provider; nothing is ever dispatched to a substitute.
- **Dynamic local-model discovery.** `/api/tags` + `/api/show`. Verified against the
  live runtime: the catalogue tracks the runtime (it showed 7, then 8 when a
  `Pythia.2 8b` appeared on this machine). No static local catalogue exists or may
  return. Moondream correctly reports 2k ctx where the old hardcoded table claimed
  128000 for everything.
- **Zero credentials in the package.** Scanned the built ASAR directly: zero
  credential-shaped literals, no dev paths, no vault seed data.
- **Onboarding defects (owner-observed), fixed:** memory stage Save (`Skip` +
  `Save & Continue`), contradictory provider state, wizard loop asking for Brain twice.
- **Onboarding layout**, rebuilt across the whole sequence and verified at 3 sizes.
- **Release pipeline:** `release.sh` refuses to publish without updater metadata;
  non-tag runs publish nothing; pre-release classification via `EP_PRE_RELEASE`.
- **Previous owner's Apple identity removed** from shipped build config (`efa4fd1`).

## 4. What remains PARTIAL / UNVERIFIED

- **Zen response-return seam.** `stillThinking:false` + `replyAfterPrompt:null` is a
  **FAIL**. It reached `Thinking… / Responding…` and then rendered no reply text.
  Not yet traced. **Highest-priority remaining bug.**
- **Ordinary OpenCode live inference** — unverified.
- **Scheduler/worker classification, `integration:list`, invalid-provider handling** — unverified live.
- **Upgrade-profile acceptance (Phase 6)** — not performed at all.
- **Piper local TTS** — PARTIAL by design. `piper.exe` is an external binary prerequisite.
- **Signing / notarization / manifest signing** — owner-controlled, deliberately deferred.

## 5. Architecture decisions that must not be undone

1. **Renderer never imports Node built-ins.** Use preload/contextBridge.
   `src/utils/platform.ts` for platform detection — never `window.henryAPI.platform()`
   directly, never Node `os`.
2. **One provider classification authority:** `electron/providers/classification.ts`.
   Four divergent copies of this logic caused a real outage. Do not re-inline it.
3. **One backend-state authority:** `resolveProviderState` backs the banner, both status
   pills, chat preflight and `hasUsableBackend`. A selected available Ollama model is a
   valid **keyless** backend.
4. **First-run detection is `src/firstRun.ts` = absence of every real signal.**
   Never re-gate a profile that has any configuration. Defaults are not decisions.
5. **A brand-new database must contain no settings rows, no provider rows, no
   credentials.** (Note: `syncBridge.ts` still seeds `business_type`/`business_name`/
   `payment_terms` defaults — harmless today because `isFreshProfile` correctly ignores
   them, but they contradict this rule.)
6. **No stage may pick a provider, model or key.** Detection is allowed; authentication
   fabrication or inheritance is not.
7. **Zen is credential-OPTIONAL.** Free Zen models run unauthenticated; a key only
   widens the catalogue. Do not reintroduce a key requirement.
8. **Never commit a real credential.** Credential-shaped fixtures are assembled from
   fragments at runtime (`src/henry/secretScan.ts`) because GitHub push protection
   rejects verbatim literals — the Slack token shape specifically.

## 5a. PRODUCT DECISION — agent/tool routing capability policy (do NOT "fix" this back)

Decided by the owner after the `computer:` accidental-execution incident. This is policy,
not an implementation detail. Encoded in `src/henry/agentRouting.ts`.

- **runtime-confirmed tool-capable** → agent mode MAY default ON
- **runtime-confirmed NOT tool-capable** → agent mode OFF; no user setting overrides it,
  because a model that cannot emit a tool call cannot be given a tool route
- **unknown / unobservable capability** → agent mode OFF (safe default)
- **user explicitly enables Agent mode** → Henry MAY attempt the agent path, with a clear
  failure if the model cannot actually support it
- **never infer capability from a model name**

Intent: normal Chat is the safe default behaviour, and the class of accidental
`computer:` execution observed live (assistant messages containing
`computer:openApp/runShell/osascript`, which the action interceptor then executed) cannot
recur through an unseen default.

Consequences to accept deliberately:
- Providers with no capability channel (OpenAI, Anthropic, Zen) resolve to `unknown`, so a
  fresh install defaults agent mode OFF there. Cloud/Zen agent turns need the toggle or a
  stored `true`.
- **Zen ordinary Chat must work perfectly with agent mode OFF.** Zen agent-mode
  compatibility is a separate capability-verification row and must not block ordinary
  Zen chat acceptance.
- Capability data is runtime-reported only (`/api/show`); a record whose
  `capabilitySource !== 'runtime'` reads as `unknown`, never as capable.

## 6. Onboarding state machine

`src/components/onboarding/stages.ts` = the ordered plan (pure data).
`src/components/wizard/SetupWizard.tsx` = the single machine that walks it.
`src/components/onboarding/OnboardingWizard.tsx` = the overlay frame, **not a gate**.

Stage order: `welcome, howItWorks, accessibility (macOS), screen (macOS), ai ('Your
brain', REQUIRED), companion, panels, memory, done`.

Rules that must hold:
- The AI stage is the **only** required stage and blocks until provider + model exist.
- Unavailable stages carry a **reason**; never advance past one by index.
- Every optional stage has an explicit `Skip — set up later`.
- Each decision is asked **exactly once** unless the user navigates Back.
- Only one gate mounts the machine (`App.tsx`, on `!setupComplete`). The overlay is
  opened solely by the `henry_open_setup_wizard` event.
- Layout primitives live in `src/components/onboarding/layout.tsx`; the wizard frame is
  the single scroll container — no stage may carry a viewport height or `overflow-hidden`.

## 7. Provider routing / transport

`resolveChat` resolves the **companion engine keys only** (`companion_provider` /
`companion_model`). It deliberately no longer reads `worker_*` / `chat_fast_*` /
`tts_provider` — the Worker engine's row was silently overriding a Companion pick.

`opencode-zen` → authoritative provider resolution → **OpenCode transport** → selected
Zen model. The transport boundary lives in `electron/ipc/ai.ts`.

`electron/providers/retiredProviders.ts` runs `migrateRetiredProviders(db)` at boot,
before key decryption. It deletes retired provider rows selecting only the `id` column
(the `api_key` column is never read, so a credential cannot reach a log) and **blanks**
retired provider ids in settings rather than deleting the keys — deleting would resolve
to a default and silently re-pick a provider the user never chose.

## 8. Local model discovery path

`GET /api/tags` (inventory) + `POST /api/show` (capabilities, context length, family).
Never infer capabilities from a model name. Ollama is the only local **chat** runtime —
Whisper and Piper are voice. No static local catalogue.

## 9. Updater / signing findings (owner-controlled, deferred)

Trust model today is **hash-only, manifest-unauthenticated, artifact-unsigned**:

- Windows binaries are **unsigned** (PE certificate table offset=0 size=0), and
  `app-update.yml` has no `publisherName`, so `NsisUpdater.verifySignature()` returns
  `null` and skips Authenticode verification entirely.
- `latest.yml` is a plain HTTPS GET of a mutable asset — no TUF, no pinned key.
  sha512 *is* verified (proved against the published exe) but only catches corruption.
  Push access to the repo equals silent code execution on every install.
- deb has no auto-update; AppImage `.sha256_sig`/`.sig_key` are zero bytes.
- Repo secrets are **empty**. Only `GITHUB_TOKEN` (automatic) is available.

Ownership is clean: no `setFeedURL`, env var or IPC can redirect the feed, so installed
Henry cannot reach the old repository. **Preserve this.**

Needed from the owner: a Windows signing certificate + `publisherName`, an Apple
Developer ID + App Store Connect secrets, and a decision on manifest signing.

## 10. Known external prerequisites

- **Piper** (`piper.exe` / `piper-tts.exe`) for local neural TTS — external binary.
  The voice *model* is auto-downloadable; the binary is not.
- Ollama must be running for local models to be discovered.
- OpenCode CLI must be installed for Zen to be offered.

## 11. Exact reproduction for every remaining bug

**Zen response-return seam (FAIL, highest priority)**
1. Launch the installed app against an isolated empty profile
   (`--user-data-dir=<empty dir> --remote-debugging-port=9600`).
2. Walk onboarding: welcome → skip how-it-works → the required "Your brain" stage.
3. Select **OpenCode Zen** (offered only when `opencodeStatus()` reports it installed),
   pick a real Zen model, complete onboarding.
4. Open Chat, send: `Reply with exactly this token and nothing else: ZENOK-7314`.
5. Observed: the DOM shows `🧠 Advisor | Thinking… | Responding…`, thinking then stops,
   and **no reply text appears** — `replyAfterPrompt:null`. No provider error surfaces.

Drive the app with:
`node scripts/acceptance/drive.mjs eval '<js>'` against `http://127.0.0.1:9600/json`.

**Untested seams (need the same harness):** ordinary OpenCode inference, Ollama
inference after onboarding, invalid-provider explicit error, scheduler/worker
classification, `integration:list` through its correct preload signature.

## 11b. Zen response-return seam — latest boundary finding (NEW, 2026-10-04)

**Last confirmed-good boundary: the prompt is accepted and reaches the app, but no
assistant chat message is ever produced.**

Fresh-profile run on installed build `95795e79…` (HEAD `c3f833d`), provider **Ollama /
`llama3.2:3b`** — i.e. NOT Zen-specific, which is new information. Prompt
`OLLOK-9911` was typed into the Chat textarea and submitted. Observed:

```
stillThinking   : false
replyAfterPrompt: '") | computer:pressEnter() | Done — typed the prompt in ChatGPT.
                  | Summarize | → Tasks | Shorter | Simpler | Copy | 📌 | 08:42 PM | ...'
tokenReturned   : false
```

**The text after the prompt is not a model completion.** It is an **agent/task card**
(`computer:pressEnter()`, "Done — typed the prompt in ChatGPT", with Summarize / Tasks /
Shorter / Simpler / Copy affordances). The send path is being routed into the
**computer-agent / tool-calling route**, which performs an action and renders a task
card, instead of producing a chat completion message.

This reframes the bug. It is **not** Zen-specific and **not** a lost-stream/normalisation
problem: the response is being diverted before a chat message is created. Investigate
which of these selects the agent route on send:

- `ChatView` send deciding agent-vs-chat (tool-capability detection on the selected model)
- `callAIWithTools` being invoked where `callAI` was intended
- `resolveChat` returning an agent/worker tier rather than the companion chat tier
- the task/agent store appending a task card where an assistant message is expected

**Reproduction (installed, isolated profile):**
1. Launch with `--user-data-dir=<empty dir> --remote-debugging-port=9600`.
2. Onboard choosing Local (Ollama) + a runtime-discovered model (e.g. `llama3.2:3b`).
3. Reach Chat, send any short prompt via the textarea.
4. Inspect: an agent/task card appears instead of an assistant reply.

Drive with `node scripts/acceptance/drive.mjs eval '<js>'` against
`http://127.0.0.1:9600/json`.

**Note:** an earlier reproduction on Zen showed `🧠 Advisor | Thinking… | Responding…`
then no text. That is very likely the same diversion surfacing differently — confirm
whether Zen is also being routed to the agent path rather than assuming a Zen-specific
stream defect.

## 11c. Chat routing trace — boundaries PROVEN WORKING (2026-10-04, HEAD 8978726)

Instrumented the live installed app (asar `95795e79…`) on the onboarded Ollama profile.
**Every boundary up to assistant-message creation is proven working.** The defect is
strictly downstream of that.

| Boundary | Method | Result |
|---|---|---|
| Model inference | `sendMessage({provider:'ollama',model:'llama3.2:3b',…})` | **WORKS** — `{content:"IPCOK-8823", usage, cost}` |
| Streaming transport | `streamMessage(…)` + `onChunk`/`onDone` | **WORKS** — chunks `["STR","M","OK","-","773","1"]`, `onDone("STRMOK-7731")` |
| Stream accumulation | `store.appendStreamingContent` (`src/store/index.ts:91`) | **WORKS** — appends to `streamingContent` |
| Agent interceptor | `interceptAndExecute(fullText)` (`ChatView.tsx:2037`) | Not the cause — appends to `fullText` inside a non-blocking `try/catch` |
| Assistant message build | `ChatView.tsx:2087-2101` | Builds `assistantMsg{content: fullText, provider, model}` and calls `addMessage` at `:2101` |

### The bisect
`agentMode` defaults **ON** (`ChatView.tsx:377-382`: `v === null ? true`). With it ON,
every turn carries `tools:[{name:'henry-agent'}]` (`:1979`) and a **task card** renders.
With it OFF (`henry_agent_mode=false` in localStorage + reload), the task card disappears
but the assistant reply **still does not render** — `replyAfterPrompt:null`.

**So the agent/tool route is not the cause.** It is an additional symptom. Ordinary chat
fails identically with tools disabled.

### Where to look next (narrowed, in order)
1. **`fullText` arriving empty at `stream.onDone` in ChatView's own stream instance**
   (`:2002`). My probe used a *separate* `streamMessage` call and got `fullText` correctly;
   ChatView's instance may differ because it registers `onChunk` *and* `onAgentToolStream*`
   handlers, or because `agentMode` changed the request shape between runs.
2. **`addMessage` reaching the store but the conversation view not rendering it.** After a
   send: `tokenInDom:false`, `thinking:false`, and my bubble selector matched **0** elements
   (`[class*=message],[class*=bubble],[data-role]`) — the DOM probe was inconclusive, so
   verify the actual message component's class names before assuming a render filter.
3. **The assistant message being created empty and filtered.** A message whose `content` is
   `''` may be dropped by a truthiness filter between `addMessage` and the list.

### Do NOT "fix" this by disabling agent mode globally
`agentMode` defaulting ON is intentional ("so Henry uses his tool crew out of the box").
The correct fix preserves tool/agent functionality and corrects only the ordinary-chat
routing condition. Acceptance requires BOTH: an ordinary Chat prompt renders a normal
assistant message with no task card, AND an explicit tool/agent operation still works.

### Verified this session (unrelated to the above, keep)
Fresh-profile onboarding on the installed build passes: Brain exactly once, required AI
stage blocks, Ready showed `✅ Running on Ollama · llama3.2:3b`, `noProviderBanner:false`,
`companion_provider`/`companion_model` persisted. Layout + macOS-copy fixes are installed.

## 11d. ROOT CAUSE FOUND — ordinary Chat is unconditionally routed into the agent/tool path

Read the persisted database (db + `-wal` + `-shm` must be copied together; the `.db`
alone is a 4096-byte stub) on the onboarded Ollama profile. Every ordinary Chat prompt
persisted an assistant message whose content was **tool-call syntax, not prose**:

```
computer:openApp(name="Google Chrome")
computer:runShell(command=…)
computer:osascript(script="tell application \"System Events\" to …")
```

Rows present for `OLLOK-9911`, `PLAIN-5529`, `STORK-3391`, `TRACE-5510` — i.e. the
failure is universal for ordinary chat, not intermittent.

**The break is in the REQUEST, not the response handling**, which is why every
downstream boundary probed clean:

- `ChatView.tsx:377-382` — `agentMode` defaults **ON** (`v === null ? true`).
- `ChatView.tsx:1979` — with agentMode on, every turn sends
  `tools: [{ name: 'henry-agent' }]` + `sessionId`.
- The model answers with tool-call syntax instead of prose.
- `src/henry/actionInterceptor.ts` regex-matches that syntax (`computer:runShell`,
  `computer:openApp`, `computer:osascript`, …) and **executes it**, producing the task
  card and leaving no normal assistant reply.

### Ruled out (do not re-investigate)
- `electron/ipc/platformCommands.ts` is correctly platform-gated (`IS_MAC`/`IS_WIN`/
  Linux). The macOS-looking text is the model's emitted *syntax*, not a macOS command
  executing on Windows. This is NOT a platform bug.
- `sendMessage`, `streamMessage`, store accumulation, `interceptAndExecute` blocking,
  and `assistantMsg` construction/`addMessage` are all verified working.

### The fix required
Ordinary Chat must attach tools only when the **selected model actually reports tool
capability** (runtime-reported `capabilities` from `/api/show`, never parsed from a model
name). Intentional agent/tool functionality must keep working. Do not disable tools
globally, do not remove the action interceptor, do not bypass the store, and do not
delete truthiness filters.

### Tooling note for the next agent
Monkey-patching `window.henryAPI.streamMessage` from CDP recorded **zero** calls — the
renderer holds a destructured bridge reference, so patching the bridge object does not
intercept ChatView's calls. To instrument ChatView's real stream you must either add
temporary instrumentation to the source and rebuild, or read the persisted database.
Reading the DB is faster and unambiguous; remember to copy `-wal` and `-shm` as well.

## 11e. ORDINARY CHAT DEFECT — FIXED AND VERIFIED INSTALLED (HEAD 5d0f0f4)

Installed build `e960455b…` on Windows, Ollama / `llama3.2:3b`, real prompt:

```
tokenAfterPrompt : "🧠 Advisor\n\nI didn't see any issue to fix. What's the problem
                    you're trying to resolve?\n\nSummarize → Tasks Shorter Simpler Copy …"
hasToolSyntax    : false      <-- was true on every prior run
tokenReturned    : false      (llama3.2:3b is small and did not echo the exact token)
```

**A normal assistant message now renders.** `hasToolSyntax:false` is the key signal: the
`computer:openApp/runShell/osascript` transcripts are gone. `Summarize/Tasks/Shorter/
Simpler` are standard per-message affordances shown on every assistant message, not the
agent task card.

Fix: `5d0f0f4` — one per-turn decision in `src/henry/agentRouting.ts` gates the request
payload, the computer-action block of the lean system prompt, and the action interceptor
together, using runtime-reported capability only.

### Corrected root cause (the first hypothesis was wrong)
`ChatView:1979` does attach `tools` when agentMode is on, but that spread is
**unreachable for Ollama** — `useLeanPrompt` returns early for every
`companionProvider === 'ollama'` turn except computer mode. That is why setting
`henry_agent_mode=false` changed nothing. The actual producers were:

1. `buildLeanSystemPrompt` (`src/henry/charter.ts`) teaching `computer:` syntax to every
   local-model chat regardless of agent mode, and
2. `interceptAndExecute(fullText)` being called unconditionally on every non-lean turn.

### Still to verify
- Restart persistence of ordinary Ollama chat.
- **Zen** through the normal UI: select → prompt → visible non-empty response → restart →
  persists → second visible response. Zen is still UNVERIFIED end to end.
- Explicit agent/tool execution still works (must not have been collateral damage).
- Note the behaviour change in `5d0f0f4`: providers with no capability channel
  (OpenAI/Anthropic/Zen) resolve to `unknown`, so a fresh install now defaults agent mode
  OFF there. Cloud agent turns need the toggle or a stored `true`. Worth confirming this
  is acceptable product behaviour before release.

## 12. Next recommended task, in priority order

1. **Rebuild, package, install** from `9eb73af`; re-run the fresh-profile acceptance end
   to end (onboarding stages → Brain once → real backend → memory Save & Continue →
   ready → Meet Henry → Chat → **real inference** → quit → restart → no onboarding →
   config and memory persist → **real inference again**). The layout and macOS-copy
   fixes are not yet verified installed.
2. **Trace and fix the Zen response-return seam** (repro in §11). Fix that exact seam;
   do not start a broad audit.
3. **Zen via the normal UI path, before and after restart**, with no SQLite/localStorage
   injection.
4. Remaining Phase 5 seams, then the Phase 6 upgrade-profile acceptance against a
   **copy** of existing user state.
5. Only then: reconcile `PARITY_LEDGER.md` (its Zen section is stale — it still records a
   failure that has since been partially superseded) and revisit the owner-controlled
   signing work.

## 13. Test hygiene note

`src/App.firstRunGate.test.ts` passed (29 tests) while a fresh installed profile was
misread as skipping onboarding. It was **not** a real regression — the wizard was on its
welcome stage, whose only button reads `Set up AI →`. The lesson: probe the real UI by
its actual control labels, and do not infer a missing screen from the absence of later-stage
copy.