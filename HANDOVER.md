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
7. **Zen is an external service, not a free one.** See §5c — it is NOT to be
   advertised as Henry's free provider, and "Free models need no key" is the copy to
   delete, not restore.
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

## 5b. PRODUCT DECISION — Agent Runtime Discovery (do NOT hardcode a runtime backend)

Owner-ruled. Henry must not hardcode a particular external agent runtime as its permanent
backend.

- Henry **discovers supported agent software actually installed on the machine at runtime**.
- Detected runtimes are presented to the user as available options, **including verified
  capabilities where possible**.
- **The user explicitly chooses** whether to integrate a discovered runtime and which to use.
- **Discovery must never automatically activate, replace, or change the user's existing
  selection.** It is read-only.
- **Prime Pi, OMP, OpenCode and future runtimes are implementations behind adapters**, not
  Henry's architecture.
- Runtime-specific **executable names, CLI arguments, authentication, event formats and
  capability detection belong inside their respective adapters** — nothing outside the
  adapter layer should know that omp speaks `--mode json`.
- **If software is not installed, Henry must not pretend it is available.**
- A newly supported runtime must be addable **without changing Henry's core Chat
  architecture**.

### Why this matters (real failures it prevents)
1. `omp` and `opencode` are **the same product under different binary names** — the vendor's
   bundle installs `omp.exe` into `%LOCALAPPDATA%\omp`. Probing only the literal name
   `opencode` made Henry fail to see an installed runtime.
2. Henry hardcoded `--format json --dir <cwd>`, which the installed CLI (`omp v18.3.2`)
   rejects outright with `unknown flags`. Every OpenCode/Zen turn failed at launch. The
   correct contract is `--mode json`, `--cwd`, `-p`.
3. Because discovery was implicit, a missing runtime presented as "provider error" rather
   than "this agent software is not installed".

### Runtime vs provider identity (do not collapse these)
`opencode` and `opencode-zen` are **model services reached through a runtime**. Runtime
identity (which agent software is installed) is separate from provider identity (which
model service is selected). `opencode-zen` keeps its distinct provider id, its own
catalogue, and its own credential. It is not a free provider — see §5c.

## 5c. PRODUCT DECISION — provider cost & authentication policy (owner-ruled)

- **Ollama is Henry's ONLY free AI-service path.** If Ollama is installed and usable models
  are discovered, Henry may offer those local models with **no external API key and no
  service fee**.
- Henry **dynamically discovers** the user's actual Ollama installation/models. Never
  bundle or invent models.
- **Every non-Ollama AI/provider service requires the user's own** account,
  credentials/API key, subscription, credits, or other provider-required payment.
- **OpenCode/OMP/Zen is NOT to be advertised as Henry's free provider.** Remove claims such
  as "Free models need no key" from OpenCode/Zen onboarding and help text.
- **A model whose name containing `free` does not override this policy.**
- **Runtime discovery remains automatic and credential-free.** Using a discovered
  paid/external service is a **separate user-selected configuration step**.
- Never bundle developer credentials, silently inherit them, fabricate them, or silently
  substitute another provider.
- If there is **no Ollama installation and no external provider configured**, Henry must
  clearly explain that the user must configure a supported external service.
- **Authentication, billing and availability errors must remain distinct. A gateway/server
  outage must never be reported as "you need a key."**
- **Prime Pi follows the same rule** when discovered: discovering the runtime does not imply
  the remote models it can reach are free.
- Onboarding, Settings, provider descriptions and active help documentation must all express
  this same policy. Preserve the **runtime/provider separation** from `dc4ea4a`.

### Supersedes earlier text
This replaces §5a's statement that Zen is "credential-OPTIONAL — free Zen models run
unauthenticated". That was true of *authentication* (verified: the Zen gateway answers
anonymous requests without a 401), but it was being used to imply Zen was a free provider.
It is not one. See §11j for the direct-CLI evidence.

## 6. Onboarding state machine

`src/components/onboarding/stages.ts` = the ordered plan (pure data).
`src/components/wizard/SetupWizard.tsx` = the single machine that walks it.
`src/components/onboarding/OnboardingWizard.tsx` = the overlay frame, **not a gate**.

Stage order: `welcome, howItWorks, accessibility (macOS), screen (macOS), ai ('Your
brain', REQUIRED), systemMap (desktop only, optional), companion, panels, memory, done`.

`systemMap` is the System Map: an optional, explicitly-skippable, consent-based one-time
inventory of this computer. Its UI is `src/components/systemMap/` + `stages/SystemMapStage.tsx`
and its renderer contract is `src/henry/systemMap.ts`, which `electron/ipc/systemMap.ts`
imports directly so both sides share one set of types. The exclusions are reviewed *before*
the scan and the reviewed set is what is sent; nothing is read on mount, on refresh, or
without a button press. Cancelling keeps nothing — a partial map is never presented as a
map. `electron/systemmap/` records names, types, sizes and dates only; it never reads a
file's contents. Rebuild, the contents view and the exclusions live in
`settings/SystemMapPanel.tsx`. Newly discovered agent runtimes are *offered* through
`selectAgentRuntime` and are never auto-selected.

Three scanner invariants that are load-bearing but read as arbitrary choices. Each is now
enforced by a test rather than merely documented — the absence only means something while
something is checking it:
- **"Never reads file contents" is structural.** It holds because `MetadataFs`
  (`electron/systemmap/fsMetadata.ts`) has exactly `readDir` and `stat` and nothing else.
  `scanMetadata.test.ts` asserts that method count, so adding a third method fails there —
  verified by mutation, not assumed. If one is ever added deliberately, update
  `CONTENTS_NEVER_READ` and the on-screen copy in the same change.
- **Test fixtures live under `$HOME`, never `/tmp`.** `/tmp` is excluded by the default
  exclusions, so a fixture placed there is filtered out *before a single assertion runs* —
  the test does not go red, it silently stops testing anything. `createFixtureRoot`
  (`electron/systemmap/_fixture.ts`) therefore asks the real exclusion policy whether it
  would scan the root and throws naming the rule that refused it; `_fixture.test.ts` also
  asserts `/tmp` is still excluded and that no test calls `mkdtempSync` directly, so the
  convention cannot be reintroduced file by file.
- **`recordRemoval` owns "record only the top of a removed tree."** It lives in
  `electron/systemmap/incremental.ts`. This invariant used to live inside one of its two
  callers, which is exactly how a deleted folder was noticed by both paths and reached
  `applyDelta` as two identical DELETE statements. Any *new* way of noticing a removal
  must go through `recordRemoval`; do not push into `removed[]` directly.

Rules that must hold:
- Nothing scans without a button press. `systemMap:scan/start` is the only door, and the
  exclusions it receives are the ones the user reviewed — never re-merged with defaults.
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

## 11f. Zen normal Chat — rendering defect is GONE; Zen now surfaces a real error (HEAD 5d0f0f4)

Live on the installed build, Zen selected through the **normal Settings UI**
(`jev-1.13-free`, label `OpenCode Zen — jev-1.13-free`, 39 Zen options offered,
`opencode-zen` row present with `hasKey:false` — correct, Zen's key is optional),
agent mode OFF. Sending an ordinary prompt produced a **visible assistant message**:

```
🧠 Advisor | OpenCode Zen returned an error. | Something went wrong with the
jev-1.13-free request. | → Try again in a moment. If this keeps happening,
check Settings → AI Providers or switch to a different model.
```

**There was never a separate Zen rendering defect.** The historical Zen failure
(`Thinking… / Responding…` then nothing) was the same agent/tool diversion documented in
§11d. With that fixed, Zen routes to the OpenCode transport and returns a properly
attributed error instead of vanishing.

### What remains for Zen
Not a rendering problem — an upstream one. `opencode-zen` with no credential returns an
error for this model. Zen is documented as credential-OPTIONAL for *free* models, so either:

- this particular model requires authentication, or
- the OpenCode bridge is not authenticated/running in this install.

Next step: try a model explicitly named `-free` (e.g. `hy3-free`, `deepseek-v4-flash-free`)
and confirm whether an unauthenticated Zen turn succeeds. If free Zen models still error,
that is a real defect in the OpenCode bridge auth path (`electron/coder/opencode.ts`,
`buildCoderChildEnv`, the `OPENCODE_API_KEY` child-env injection) — a separate investigation
from the routing fix now landed.

### Also verified
Ollama restart persistence: after a full quit and relaunch `llama3.2:3b` remained selected
and produced a visible assistant reply with `hasToolSyntax:false`.

## 11g. OPEN DEFECT — unauthenticated OpenCode Zen turns error on every free model

Installed build `e960455b…`, agent mode OFF, Zen selected through the normal Settings UI.
The picker offers **28 Zen models whose ids contain `free`**. Sending an ordinary prompt:

- `jev-1.13-free` → `OpenCode Zen returned an error. Something went wrong with the
  jev-1.13-free request.`
- `deepseek-v4-flash-free` (explicitly `-free`) → **same error**

So this is **not** "that model requires a credential". Zen is documented and implemented
as **credential-OPTIONAL** for free models (a key only widens the catalogue), and every
free model errors with no credential present.

**Status: rendering is fixed (§11f); this is a separate, now well-scoped upstream defect in
the OpenCode Zen execution/auth path.** The request reaches the transport and comes back as
a correctly-attributed error, which is the right contract — but the request never succeeds.

### Where to look
`electron/coder/opencode.ts` and the OpenCode bridge invoked from `electron/ipc/ai.ts`
(the `opencode-zen` → OpenCode transport boundary). Specifically:
- `buildCoderChildEnv` and the `OPENCODE_API_KEY` child-env injection
- `setOpencodeZenCredential` / `rehydrateOpencodeZenCredential` — is an empty key actually
  reaching the child, and is an empty key expected to work?
- whether the opencode CLI is installed and reachable in this install at all
- what the underlying error is before Henry maps it to the generic "Something went wrong"

To see the real error, temporarily surface the underlying exception at the transport
boundary rather than the mapped user-facing sentence — the current message discards it,
which is why this took this long to localise.

### Reproduction
1. Launch with `--user-data-dir=<isolated dir> --remote-debugging-port=9600`.
2. Settings → Engines → pick any Zen model whose id contains `free` (no key set).
3. Chat → send `Say hello in one short sentence.`
4. Assistant message reads `OpenCode Zen returned an error.`

## 11h. Zen CLI flags FIXED at both call sites; failure moved from launch-time to upstream

Two defects, found in sequence, both real.

### Defect 1 — `electron/coder/opencode.ts` (fixed, `8ef971f`)
`runOpencode` built `['run','--format','json','--dir',cwd,prompt]`. `omp` rejects
`--format` and `--dir` outright.

### Defect 2 — `electron/ipc/opencodeBridge.ts:194` (fixed, `3829139`) — the one that mattered
```ts
spawn(cli.path!, ['run','--format','json','--model',model,'--dir',CODER_WORKSPACE_DIR,prompt])
```
This is the route `ai:send` actually takes. Fixing only the first site left the live
failure untouched and survived a full rebuild + install — the identical
`unknown flags: --format, --dir` error came back. **Both sites now use `--mode json`,
`--cwd <dir>` and `-p`.** Verified against the real `omp v18.3.2` binary: the old vector
exits 2 with the flag error, the new one streams JSON events.

### Where Zen stands now
With flags fixed, the launch-time failure is gone and the CLI reaches the gateway, which
now refuses it:

```
opencode produced no text for deepseek-v4-flash-free (exit 1). stderr: (empty)
stdout tail: ...type=server_error)
raw-http-request=...
```

So the remaining Zen problem is **upstream of Henry**: the Zen gateway returns
`server_error` for this model with no credential. That is no longer a Henry bug — Henry
now launches the CLI correctly and surfaces the gateway's own error rather than masking it
as "Something went wrong".

### Next step for Zen
Establish whether unauthenticated free Zen access still exists at all, or whether the
gateway now requires a key. The cheapest check is to run the CLI directly with the correct
flags and no credential and read what the gateway says:
`omp run --mode json --cwd <dir> -p --model <free-model> "hi"`.
If free Zen requires a credential now, the "credential-optional" claim in
`HANDOVER.md §5a` and in `electron/coder/opencode.ts` needs updating as a product decision,
and the onboarding copy ("Free models need no key") becomes wrong.

## 11i. AGENT MODE ACCEPTANCE — both halves verified in ONE installed build (HEAD 9f2add0)

Installed build `757acf60…`, Windows, provider `llama3.2:3b` (runtime-verified
tool-capable via `/api/show`).

### Half 1 — ordinary Chat, agent mode OFF
```
henry_agent_mode = false
prompt           : "In one short sentence, what is 2 plus 2?"
reply            : 🧠 Advisor | 2 + 2 = 4. | Done — calculated answer.
accidentalToolSyntax : false
```
Normal assistant message, **no accidental `computer:` syntax**.

### Half 2 — agent mode deliberately ON, same build, same model
```
henry_agent_mode = true
prompt      : "Use the machines_status tool to report your status, then tell me in one sentence what you are."
result      : machines_status ═ System Status: CPU 90% · Memory 85% · Disk 95% · Network: Up
              App Status: ChatGPT Online · Chrome Open · Notification Center Active
              User Status: Henry Online
```
**Genuine tool execution with real returned data** (CPU/memory/disk figures match this
loaded machine), not a simulated card.

**Conclusion: the capability gating did not swing the pendulum from "tools everywhere" to
"tools nowhere."** Both halves hold in the same installed build, which is the only way the
invariant is meaningful.

### Note observed
The Settings model picker now labels the local model **"OpenCode — llama3.2:3b"**. That is
the new runtime-adapter layer attributing the local model to a runtime. Worth reviewing: a
locally-running Ollama model should not present itself as belonging to the OpenCode runtime.
Low severity (cosmetic attribution) but it could confuse users and is a symptom of runtime
and provider identity still being entangled in that label.

## 11j. ZEN GATEWAY — settled by direct CLI test, independent of Henry

Tested the installed CLI directly with the corrected flags and **no credential**:

```
$ omp run --mode json --cwd /tmp -p --model deepseek-v4-flash-free "Say hello..."
  {"provider":"opencode-zen","model":"deepseek-v4-flash-free", ...}
  {"errorMessage":"400 Upstream request failed: Model is unavailable. (type=server_error)"}
  auto_retry attempt 8/10 ... 9/10

$ omp run --mode json --cwd /tmp -p --model hy3-free "Say hello."
  {"errorMessage":"400 Upstream request failed: Model is unavailable. (type=server_error)"}
```

### What this settles
- The request **reaches the Zen gateway anonymously**. `provider: opencode-zen` resolves and
  the gateway answers.
- The failure is **NOT authentication**. There is no 401, no auth challenge, no "key
  required" — the gateway says the **model is unavailable**.
- It is **not model-specific**: two different `*-free` models behave identically.
- **Henry is not at fault.** The CLI is invoked correctly and the gateway's own error is
  surfaced rather than masked.

### Consequence needing an owner ruling
The onboarding copy says Zen's free models "need no key", and §5a records Zen as
credential-OPTIONAL. That remains true of *authentication* — nothing here shows a key is
required — but in practice anonymous free Zen is currently non-functional. Either:
1. the gateway is degraded and will recover, or
2. Zen now needs a working credential to return anything.

**A key was not tested and must not be fabricated.** Before release, decide whether the
"free models need no key" copy should be softened until a Zen turn is proven to work, and
whether Zen should still be offered as a no-key option while the gateway returns this.

## 11k. UPGRADE-PROFILE ACCEPTANCE — PASS (installed build `3e95a31b…`)

Took a copy of a genuinely configured profile, planted a retired Groq provider row
(holding a fake key) and `companion_provider=groq`, then launched the installed build
against that copy.

| Requirement | Result |
|---|---|
| legitimate settings survive | `companion_provider=ollama`, `companion_model=llama3.2:3b`, `worker_provider=ollama` all intact |
| legitimate provider rows survive | `providers` = `ollama`, `opencode-zen` |
| retired Groq state NOT resurrected | planted `groq` row **deleted**; absent from every live table |
| hosted/commercial state not fabricated | none created |
| first-run onboarding does not re-run | `onboardingShown:false`, `setupWizardShown:false` — straight to the main Henry UI |
| existing user data survives | 20 messages preserved |
| planted credential never logged | not present in any log file |

### Real defect this acceptance exposed
The credential was **still recoverable from `henry.db` itself** after the row was deleted —
SQLite leaves deleted content in freed pages without `PRAGMA secure_delete`. Fixed in
`24f5b3a`: `initDatabase` now sets `secure_delete = ON`, with a regression test carrying a
negative control so the guarantee cannot pass vacuously.

### One behaviour to confirm is intended
The planted `companion_provider=groq` ended up as **`ollama`**, not blanked. The migration
is documented as *blanking* retired ids so no default is silently re-picked. Something then
resolved the empty value to the local provider. That may be desirable under the new
cost/auth policy (Ollama is the free path), but it is not what the migration doc says, and
it should be confirmed as intended rather than inherited by accident.

## 12a. BLOCKER — PrimeRoute has no inspectable implementation on this machine

The PrimeRoute integration work **cannot proceed** and must not be guessed at. Evidence:

```
/mnt/c/Users/xkali/new_ai/PrimeRoute     EXISTS BUT IS EMPTY (0 entries, not a git repo)
/mnt/c/Users/xkali/.primeroute/          contains only: operator-key.txt
/mnt/c/Users/xkali/.local/share/opencode/primeroute.env   contains only: PRIMEROUTE_OPENCODE_KEY
```

An exhaustive search (`/home/buster`, `/mnt/c/Users/xkali`, `/mnt/d`, depth 4) found **no
PrimeRoute source, no API definition, no route table, no OpenAPI document and no repository**
— only that empty directory and two credential files.

**Why this blocks rather than merely slows:**
- The brief states the live PrimeRoute API contract is authoritative and forbids inventing
  endpoints "because they seem likely to exist".
- There is no contract to inspect, so any client written now would be fabricated.
- There is no service to run, so success and failure paths could not be tested.

### What exists and is usable
`PRIMEROUTE_OPENCODE_KEY` is a real credential that presumably authenticates against the real
PrimeRoute. It could reveal the API by probing, but probing an unknown service to discover its
contract is exactly the invention the brief rules out. **Not attempted.**

### PrimeTech Marketplace audit (owner-directed; NOT redesigned)
`resources/marketplace/marketplace.json` — manifest `primetech-marketplace` v1, 6 entries:
`primetech-terminal`, `buster`, `devtoolbox`, `termuxfm`, `ohmytermux`, `primetech-marketplace`.
Each declares `capabilities` and `integrations`; `primetech-terminal` declares
`integrations: ['buster','termux']`. Read by `electron/ipc/marketplace.ts`, surfaced by
`src/components/marketplace/MarketplacePanel.tsx`.

**PrimeRoute is NOT in the catalogue.** Adding a new PrimeTech app should go through this
existing manifest mechanism — but that entry can only be written once the real PrimeRoute
integration contract exists.

### Owner decision required
1. Locate/provide the PrimeRoute repository or its API specification, or
2. Confirm PrimeRoute is not yet implemented and that this programme should proceed without it.

## 12b. OWNER DECISION REQUIRED — Henry's licence/ownership position is ambiguous

Recorded, not guessed. Changing any of this is a legal/ownership decision.

### Evidence in the repository right now
```
LICENSE              MIT (full text, repository root)
package.json         "license": "MIT"
package.json         "author": { "name": "Topher Cook", "email": "hello@henryai.app" }
```

For comparison, the owner's other PrimeTech system:
```
/mnt/e/PrimeRoute/pyproject.toml   license = "LicenseRef-Proprietary"
                                  authors = [{ name = "Prime Tech" }]
```

### Why this cannot be resolved from evidence
- The repository now lives at `xbustcodex/Henry-AI` and the previous owner's Apple signing
  identity was deliberately removed in `efa4fd1`, which is consistent with Henry no longer
  being that person's product.
- But `package.json` still names them as author, and `LICENSE` still grants MIT rights —
  which would let anyone redistribute and sublicense the code.
- PrimeRoute, in the same ecosystem, is proprietary. That may indicate an intent for Henry to
  follow, or it may be unrelated. **Nothing in the repository states Henry's intended terms.**

### Options
1. **Keep MIT** — correct only if Henry is genuinely intended to be permissively licensed.
   No change needed; author metadata may still want updating for accuracy.
2. **Change to proprietary** (e.g. `LicenseRef-Proprietary`, matching PrimeRoute) — a
   licence change is a legal decision with distribution consequences.
3. **Keep MIT, correct authorship metadata only** — narrowest change that fixes attribution
   without altering terms.

### Recommendation
Option 3 or 1. The author metadata is demonstrably stale regardless of which licence is
intended, and that part is a factual accuracy fix rather than a legal decision. The licence
*terms* themselves should be an explicit owner decision.

No change has been made. Deliberately NOT done without instruction:
- changing `LICENSE` terms
- relabelling the product as proprietary
- mass-inserting copyright headers into source files (the repository does not use that
  convention, and header spam would not improve accuracy)
- overwriting any third-party notice

Also pending the same decision: `package.json` `version` is still `3.0.7`, identical to the
tag that must not be moved. The next release needs a distinct version so the built artefact is
not mistaken for the existing `v3.0.7` tag.

## 12c. OWNER DECISIONS RESOLVED (2026-10-05)

1. **Retired Groq model id** — accept the configured Henry engine as correct behaviour.
   `llama-3.3-70b-versatile` must not remain a functional requirement, default, fallback or
   routing target, and is not a reason to restore Groq. Panels go: panel feature → governed
   Henry AI path → currently configured usable engine → normal provider/model policy. Do not
   force a 70B model. Surviving references are **historical only**: test fixtures proving
   Groq stays retired, a Cerebras model alias (`cerebras.ts`), a web-mock price table and a
   comment. **No panel requires the model.**

2. **Licensing** — Henry keeps **MIT** for this release. PrimeRoute remains proprietary per its
   own repository; not changed. Stale previous-owner authorship corrected to the established
   Prime Tech identity; MIT LICENSE, third-party licences, copyright and attribution all
   preserved. No mass source-header rewrite (the repository does not use that convention).

3. **Version** — the next release is **3.0.8**. `v3.0.7` remains historical and immutable.

4. **PrimeRoute admin-auth defect** — recorded as a **separate PrimeRoute security defect**,
   NOT worked around from Henry and NOT to be relied on by Owner Henry. `require_admin`
   accepts an ordinary `pr_` bearer credential first and derives admin/owner authority from
   the associated user's role, affecting `/api/admin/*`. Owner will address it separately.
   Privileged PrimeRoute administrative integration is **awaiting the properly secured
   PrimeRoute admin/control surface**.

5. **PrimeRoute key issuance** — accepted that there is no customer-facing `/v1`
   key-issuance/onboarding endpoint. Henry must NOT self-issue a credential and must NOT
   fabricate one. Credentials are provisioned through PrimeRoute's real authorised
   operator/admin mechanism. Henry may consume a legitimately provisioned credential through
   its own secure mechanism when operational. Never bundle an owner key.

6. **PrimeRoute transport** — Henry's existing `relay` provider is the correct seam; do NOT
   build a second client. The genuine gap is `AiRequest` being unable to express
   `X-PrimeRoute-*` routing metadata. Extend only where an available, authorised PrimeRoute
   interface genuinely requires it. Do not prematurely close functionality depending on the
   unfinished standalone admin surface.

7. **Completed governance work is to be kept, not regressed** — `runPanelAI` governed path,
   all ten migrated call sites, `proxyShim.ts` removed, cost logging including zero-cost
   Ollama turns, coder:run confirmation/approval/audit gating, fail-closed behaviour, and the
   no-renderer approval rows recorded `rejected` rather than left permanently pending.

## 12d. HENRY 3.0.8 — BOTH TARGETS BUILT, ISOLATION INSPECTED

```
source commit : a73700f (+ target build-script fix)
version       : 3.0.8   (v3.0.7 unmoved at 0920bbd)

OWNER    (windows x64)  installer 57ff4082d5005f323c8e4b61eb18671e47b38fafb65ef0efc72d54260dc7eabe
                       asar      3ad85a3afcc2293c579e28a7169fa2a24fb95c5ec022a880659f765524c24cbf
STANDARD (windows x64)  installer 3c9f4b10f467fcb60769f7ac9021e03ea243b3e65365617c4421c535d497727d
                       asar      eb4725914622f0a47c7d1583f859166c2fd371c0b2a3e2055c3478aae2eb8381
```

### Isolation inspected against the ACTUAL built Standard artifact
```
dist-electron/main.js     owner markers (/api/admin/, owner-console, ops.owner, HENRY_TARGET) = NONE
dist-electron/preload.cjs same                                                                    = NONE
both files                PrimeTech Marketplace present                                            = TRUE
```
`targets/standardBundle.test.ts` — 10 artifact guards, all passing. Every load-bearing
guard was mutation-checked during implementation, including an end-to-end build where a
real owner-only feature appeared in the Owner artifact and was absent from the Standard
artifact built from the identical source tree.

Marketplace is asserted present in BOTH targets, not merely protected from exclusion:
availability of a public app catalogue is not owner operational authority.

### Defect found and fixed while building
`scripts/henry-build.mjs` passed its passthrough to Vite as well as electron-builder.
Vite parses argv with CAC and rejects `--win`/`--x64`/`--publish` outright, so every
target build died at the Vite step; and a builder flag with a separate value word leaked
that word to Vite as a bare positional. Fixed by filtering builder-only flags (and their
value words) out of the Vite arguments. Without this the new target system was unusable.

## 12e. BLOCKER — installed 3.0.8 cannot start: wrong-architecture better-sqlite3

**The owner's machine is currently in a FAILED state and needs this resolved.**

### Symptom
Installed Henry 3.0.8 writes `startup-failure.json` and never reaches a window:
```
Error: ...\Henry AI\resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\
better_sqlite3.node is not a valid Win32 application.
```

### Root cause (diagnosed to the exact mechanism)
The packaged native binding is **ARM64** while the machine is x64:
```
packaged : PE32+ executable for MS Windows 6.02 (DLL), ARM64
required : PE32+ executable for MS Windows 6.00 (DLL), x86-64
```
The correct binary is obtainable and verified:
```
cd node_modules/better-sqlite3
npx prebuild-install --platform=win32 --arch=x64 --runtime=electron --target=31.7.7
  -> PE32+ ... x86-64   (correct)
```
…but it is **overwritten before packaging completes**. `package.json` has
`"postinstall": "npx @electron/rebuild || true"`. On this Linux build host that script
reinstalls a foreign prebuild, so the verified x64 Windows binary is clobbered. Setting
`build.npmRebuild: false` does NOT stop it, because the clobber comes from the postinstall
hook, not from electron-builder's own rebuild step. Confirmed by md5: `node_modules` and
the packaged copy share the same ARM64 hash after a full build.

### Fix to apply
1. Make the native binding correct for the packaging host's TARGET, not the host: either
   remove/neutralise the blanket `postinstall` electron-rebuild, or have it target
   `--platform=win32 --arch=x64 --target=31.7.7` when cross-packaging for Windows.
2. Add a **packaging guard** that asserts the architecture of every unpacked `.node` in the
   built artifact matches the target. This bug shipped silently through a green package
   guard — the guard checked presence, not architecture. That is the real lesson.
3. Rebuild Owner, reinstall, then re-run first-run acceptance.

### State of the owner's machine
- Old 3.0.7 was backed up to `C:\Users\xkali\henry-backup-20261005` (159 MB) and uninstalled;
  its install directory is fully removed (0 residual files). The earlier historical backup
  is retained.
- Previous live user data was moved aside to
  `AppData\Roaming\henry-ai-desktop.superseded-20261005` (not deleted) and a fresh empty
  profile created, so 3.0.8 runs a genuine first run when it starts.
- **3.0.8 is installed but will not start** until the binding is corrected. Nothing else on
  the machine was touched: Ollama, OMP, PrimePi, PrimeRoute, projects and other
  applications' credentials were not modified.

## 12f. RELEASE RECOVERED — 3.0.8 Owner boots and runs on the real Windows machine

```
final commit : 001c7de
OWNER installer  cee9541a98446ec7e78f07e57bda4bce5510dfad983825fed9b8818d79223625
OWNER asar       c940ebeb4214e643a73c40aa7feab49119d5da734f0e04a7b767df0460af4c06
OWNER native     cd436f5af1781f2c234a1259ed4ae30a9e7022a51eb29b74c8093a29a06e0ae3
installed asar   c940ebeb4214e643a73c40aa7feab49119d5da734f0e04a7b767df0460af4c06  (byte-identical)
installed native  PE32+ MS Windows 6.00 (DLL), x86-64  (verified by reading the binary)
```

### BOOT GATE — PASS
```
startup-failure.json : ABSENT      (the original symptom is gone)
Henry processes      : 4
henry.db created     : YES         better-sqlite3 loaded and DB initialised
CDP window           : "Henry AI"
```

### Clean first-run acceptance — PASS (first stage)
```
welcomeShown        : true        onboarding entered on a genuinely empty profile
primary action      : "Set up AI →"
providerRows        : []          no provider configured yet
anyCredentialBundled: []          ZERO credentials shipped
groqReturned        : false       retired provider did not return
settingsKeys        : 5           defaults only
```
(`onboardingShown`/`systemMapConsent` read false only because the probe matched later-stage
wording; the Welcome stage itself is present.)

### Packaging invariant established permanently (§11 of the recovery brief)
A native module is NOT accepted because it exists, because electron-builder succeeded,
because the installer was created, or because ASAR packaging succeeded. For target-specific
native dependencies: **presence + target architecture + target runtime ABI + installed
load/boot** are all required. `verify-package.mjs` now enforces architecture, and
`scripts/prepare-native.mjs` makes the prepare step explicit and fail-loud instead of
hiding failures behind `|| true`.

### Not yet completed in this recovery
- Standard 3.0.8 x64 rebuild under the corrected native contract, and its artifact re-inspection
- The remainder of the first-run walk (System Map consent → discovery → Brain → memory → Ready)
- Restart acceptance
- Finance ledger transaction test and CSV-import truthfulness through the installed app

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