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