# Session Handoff: On-Device LLM Design

**Created:** 2026-08-24<br/>
**Last Updated:** 2026-08-28<br/>
**Workspace:** `/usr/local/google/home/zezhang/working/project-voice`<br/>
**Primary artifact:** [`docs/on-device-llm-design.md`](./on-device-llm-design.md)<br/>
**System Architecture:** [`docs/architecture.md`](./architecture.md)<br/>
**Implementation Status Summary:**

| Milestone | Code / Focus | Status | Progress | Target / Output Artifacts |
|---|---|:---:|:---:|---|
| **Pre-M1** | Race-Condition Elimination (Monotonic Sequence Tagging) | **Proposed** | Ready (0/4) | [`docs/sequence-tagging-feature-brief.md`](./sequence-tagging-feature-brief.md) |
| **M0** | Feasibility & Benchmark Harness (`@litert-lm/core@0.15.0` + `gemma-4-E2B-it-web`) | **COMPLETE (GO)** | 100% (9/9) | [`docs/m0/`](./m0/) (Audited on macOS M1 Pro, Chrome 151) |
| **M1** | Provider & Prompt Foundation (Router, bundled Jinja, parity tests) | **COMPLETE** | 100% (11/11) | [`docs/m1/`](./m1/) (Audited, 210 golden fixtures) |
| **M2** | Model Catalog, Download, Storage & Lifecycle | **CONDITIONAL** | 15/16 locally verified | [`docs/m2/`](./m2/) (Live GCS deployment verification pending) |
| **M3** | Production Runtime & Settings UX | **Pending** | Ready for implementation (0/12) | [`docs/on-device-llm-design.md#146-m3--production-runtime-and-settings-experience`](./on-device-llm-design.md) |
| **M4** | Hardening, Cross-Platform Validation & Launch | **Pending** | Queued (0/13) | [`docs/on-device-llm-design.md#147-m4--hardening-validation-and-rollout-readiness`](./on-device-llm-design.md) |


## 1. Purpose of This Handoff

This document records the context, decisions, repository findings, and remaining work from the session that produced the on-device LLM design for Project VOICE. A new session should read this handoff first, then use the primary design document as the source of truth.

The original request was to design support for running all sentence and word suggestions locally in Chrome, without calling Gemini after the user selects an on-device model.

For detailed implementation and validation records of completed milestones, see:
- Milestone 0: [`docs/m0/README.md`](./m0/README.md), [`docs/m0/decision.md`](./m0/decision.md), [`docs/m0/compatibility.json`](./m0/compatibility.json), [`docs/m0/audit.md`](./m0/audit.md)
- Milestone 1: [`docs/m1/README.md`](./m1/README.md), [`docs/m1/audit.md`](./m1/audit.md)
- Milestone 2: [`docs/m2/README.md`](./m2/README.md), [`docs/m2/audit.md`](./m2/audit.md)
- Sequence Tagging: [`docs/sequence-tagging-feature-brief.md`](./sequence-tagging-feature-brief.md)

The requested user journey was:

1. Open Project VOICE in Chrome.
2. Select an on-device model in Settings.
3. Press a model-download button.
4. Download the model from a Google Cloud project bucket.
5. Automatically load the model after download.
6. Generate all later word and sentence suggestions locally.
7. Reuse the installed model across future visits without downloading it again unless the user explicitly updates or replaces it.

Model training and fine-tuning are explicitly out of scope. Model weights are assumed to exist locally or in GCS.

## 2. Artifact Produced

The complete English design document is:

- [`docs/on-device-llm-design.md`](./on-device-llm-design.md)

It contains:

- Executive summary.
- Current architecture and data flow.
- Detailed terminology for every important new runtime, browser, storage, security, and LLM concept.
- Goals, non-goals, assumptions, and critical user journey.
- Provider and runtime-adapter interfaces.
- Prompt-rendering strategy.
- Local generation scheduling and cancellation.
- GCS manifest and signed-URL APIs.
- OPFS/IndexedDB persistence, resumable download, integrity verification, update, and rollback.
- Settings, accessibility, resource estimates, and privacy behavior.
- Alternatives with pros and cons.
- Failure handling, tests, acceptance criteria, rollout, risks, milestones, and effort estimates.

The design document is 1,121 lines and passed `git diff --check` at the end of the session.

## 3. User-Confirmed Decisions

These decisions were explicitly confirmed during the session and should not be reopened without a new user request or contradictory implementation evidence.

### Model compatibility

- Use an **adapter plus certified-model** compatibility contract.
- The architecture is extensible to additional LiteRT model types.
- The first production-certified path is a web-compatible Gemma `.litertlm` artifact using LiteRT-LM Web.
- Do not claim that every arbitrary raw `.tflite` file can run as an LLM.
- Unknown formats require a new built-in adapter with model-specific tokenizer, tensor, KV-cache, decoding, and sampling behavior.

### Cloud behavior

- Cloud remains the default for new and migrated users.
- If Local is selected and unavailable or fails, **never automatically fall back to Gemini**.
- The user must explicitly select Cloud again.
- In Local mode, no prompt, conversation context, persona, or generated suggestion is sent to `/run-macro` or Gemini.

### Model distribution

- Use a **private GCS bucket plus backend-generated signed URLs**.
- Chrome downloads model bytes directly from GCS.
- Do not proxy multi-gigabyte model files through the Flask/App Engine backend.
- Pin downloads to an immutable GCS object generation and support Range-based resume.

### Local import

- Allow importing an already-downloaded model file for development and debugging.
- Gate import behind a development/debug feature flag.
- Direct `.litertlm` files use the built-in LiteRT-LM adapter.
- Uncertified imported models are labeled as unverified and do not receive update metadata.

### Browser and offline scope

- V1 targets current stable **desktop Chrome** on macOS, Windows, and Linux where WebGPU works.
- Android Chrome is best-effort/future scope, not a v1 certification requirement.
- Full PWA/offline launch is desirable but low priority and belongs in future improvements.
- V1 makes inference local; it does not guarantee the app itself can launch without network access.

### Model selection UI

- Ordinary users see one administrator-configured Local model in v1.
- Do not add a multi-model user dropdown in v1.

### Resource reporting

- Use Web-only estimates.
- Show logical processor count, coarse device RAM, page/Worker memory estimates, storage/quota, backend, model activity, latency, and tokens per second.
- Do not claim to show exact system CPU, RAM, or GPU-memory usage.
- Label inference duty cycle as **Model activity**, not CPU usage.

## 4. Repository Findings

### Project structure

- Frontend: TypeScript, Lit, Material Web components.
- Backend: Python, Flask.
- Python package manager: `uv`.
- Frontend build: `esbuild`.
- Local development: `npm i`, then `npm run dev`.
- Deployment target: Google App Engine.

Repository instructions from `AGENTS.md`:

```bash
npm i
npm run dev
```

### Current suggestion flow

- `src/pv-app.ts` gathers partial input, language, persona, conversation history, last speech, and sentence emotion.
- `src/macro-api-client.ts` creates two requests: one sentence request and one word request.
- Both requests call `POST /run-macro`.
- `main.py` parses form data and calls `macro.RunMacro`.
- `macro.py` applies language-specific text transformations, renders a Jinja template, and calls Gemini.
- The frontend parses numbered lines such as `1. suggestion` and removes duplicates.

### Current settings and state

- `src/pv-setting-panel.ts` currently exposes a single AI dropdown containing Gemini models.
- `src/state.ts` stores `aiConfig` and derives the Gemini model and prompt IDs from the current language.
- `src/config-storage.ts` stores configuration in `localStorage`.
- `src/constants.ts` currently defaults `aiConfig` to `gemini_3_flash`.
- Provider selection and model selection are not currently separate.

### Current prompts

- Prompt templates live under `templates/prompts/`.
- They are rendered only in Python today.
- Current language paths include English, Japanese, Mandarin, French, German, and Swedish.
- Japanese and generic word prompts include special text transformations in `macro.py`, including `§` substitution.
- Local inference requires equivalent browser-side prompt construction and output cleanup.

### Current tests

- Browser/Jasmine tests exist under `src/tests/`.
- Python prompt tests exist under `tests/prompts/`.
- Existing response parser tests cover numbered output, whitespace, duplicates, unrelated lines, and result limits.

## 5. Technical Conclusions

### LiteRT family

- LiteRT is the low-level edge runtime/model ecosystem.
- LiteRT.js can execute compatible `.tflite` graphs in a browser but does not provide a universal LLM tokenizer, decode loop, KV cache, or sampling implementation.
- LiteRT-LM supplies higher-level LLM orchestration.
- `@litert-lm/core` is the chosen browser runtime.
- The official LiteRT-LM Web API was an early preview at the time of research and supported only selected web-compatible `.litertlm` models.
- A native or arbitrary `.litertlm` file is not automatically Web-compatible.

Official reference:

- [LiteRT-LM Web API](https://developers.google.com/edge/litert-lm/js)
- [LiteRT.js getting started](https://developers.google.com/edge/litert/web/get_started)
- [MediaPipe LLM Web guide recommending migration to LiteRT-LM](https://developers.google.com/edge/mediapipe/solutions/genai/llm_inference/web_js)

### Chrome runtime

- LiteRT-LM Web uses WebGPU.
- WebGPU must be feature-detected; browser name alone is insufficient because GPU, OS, driver, and policy can disable it.
- A dedicated Web Worker is the recommended owner of model loading, hashing, generation, cancellation, and metrics.
- `COOP: same-origin` and `COEP: require-corp` are required for cross-origin isolation and page-level memory measurement.
- Current external Google Fonts and Material Symbols should be self-hosted to avoid cross-origin-isolation issues.

Official references:

- [Chrome WebGPU documentation](https://developer.chrome.com/docs/web-platform/webgpu/)
- [Cross-origin isolation guidance](https://web.dev/articles/coop-coep)
- [Chrome page-memory measurement](https://web.dev/articles/monitor-total-page-memory-usage)

### Model persistence

- Store model files and partial downloads in OPFS.
- Store transactional lifecycle metadata in IndexedDB.
- Keep small user settings such as `inferenceMode` in `localStorage`.
- Call `navigator.storage.persist()` from the explicit Download/Import user action.
- Persistence survives normal reloads and browser restarts but not user-cleared site data, Incognito exit, or origin changes.

Official references:

- [OPFS documentation](https://web.dev/articles/origin-private-file-system)
- [Web Storage Standard](https://storage.spec.whatwg.org/)

## 6. Core Proposed Architecture

### Providers

```text
SuggestionProviderRouter
    ├── CloudSuggestionProvider → /run-macro → Gemini
    └── LocalSuggestionProvider → prompt renderer → Worker → LiteRT-LM/WebGPU
```

The router chooses exactly one provider from `inferenceMode: 'cloud' | 'local'`.

### Model lifecycle

```text
unsupported
not_downloaded
downloading
verifying
downloaded
loading
ready
generating
update_available
error
```

### Storage

```text
localStorage
  inferenceMode and small preferences

IndexedDB
  manifest, active version, download offset, verification state,
  last-known-good version

OPFS
  versioned model files and partial downloads
```

### Local generation

- Keep the existing word and sentence prompts separate in v1.
- Serialize local generations to limit memory pressure.
- Generate words first and return them as a partial result.
- Generate sentences second.
- Cancel active generation when newer input arrives.
- Keep only the newest queued request.
- Use sequence IDs so delayed stale output cannot appear in the UI.
- Include provider, model ID, and model version in suggestion cache keys.

### Prompt parity

- Keep existing `.jinja2` files as the canonical source.
- Bundle them with the frontend and render them using a restricted Jinja-compatible browser renderer.
- Keep Python rendering for Cloud mode.
- Add golden tests comparing Python and browser output for every prompt branch.
- Reproduce Japanese and `§` transformations and current response cleanup.

## 7. Proposed Backend Interfaces

### Default model manifest

```text
GET /api/on-device-models/default
```

Returns model ID, version, family, adapter ID, format, size, SHA-256, GCS generation, language/context capabilities, hardware/storage requirements, and generation defaults. It does not return an unrestricted bucket path.

### Signed URL

```text
POST /api/on-device-models/{modelId}/download-url
```

The request includes the desired version. The response returns a generation-pinned signed URL, expiration, expected size, checksum, and GCS generation.

The endpoint must:

- Sign only allowlisted model IDs and versions.
- Use existing session and CSRF controls.
- Avoid logging the complete URL.
- Support refreshing an expired URL during Range resume.

## 8. Proposed Settings Behavior

- Replace the current combined AI dropdown with **Cloud (Gemini)** and **On-device**.
- Keep the existing Gemini-model dropdown under Cloud.
- Show one administrator-configured model card under On-device.
- Selecting On-device stops Cloud requests immediately, even before the model is ready.
- Show Download, Resume, Load, Update, Retry, and Remove actions as appropriate.
- Automatically load after successful verification.
- Show lifecycle state, accessible progress, compatibility, storage, approximate resources, latency, and tokens per second.
- Require explicit confirmation before removing an installed model.
- Expose Import only through a development/debug feature flag.

## 9. Milestone Status & Implementation Progress

### 9.1 Milestone Execution Matrix

| Milestone | Code / Focus Area | Priority | Status | Progress | Exit Criteria & Verification Evidence |
|---|---|:---:|:---:|:---:|---|
| **Pre-M1** | **Race-Condition Elimination (Monotonic Sequence Tagging)**: `latestSequenceId` triple-gate checks across keystrokes, debounce, cache hits, and streaming chunks. | P0 | **Proposed** | Ready<br/>(0/4 tasks) | [`docs/sequence-tagging-feature-brief.md`](./sequence-tagging-feature-brief.md) (Design and test plan complete, ready for implementation) |
| **M0** | **Feasibility & Benchmark Harness**: Pin `@litert-lm/core@0.15.0` + `gemma-4-E2B-it-web.litertlm`; OPFS Worker loading; macOS reference validation. | P0 | **COMPLETE**<br/>(GO) | 100%<br/>(9/9 tasks) | **2026-08-27** — Validated on macOS (Apple M1 Pro / Chrome 151). 11 OPFS loads, 0 network leaks, 0 main-thread long tasks. Passing `npm run verify:m0`. Ref: [`docs/m0/`](./m0/) |
| **M1** | **Provider & Prompt Foundation**: Provider router with strict no-fallback; bundled Jinja browser renderer with Python parity; `MockLocalSuggestionProvider` CI seam; privacy regression tests. | P0 | **COMPLETE**<br/>(Accepted) | 100%<br/>(11/11 tasks) | **2026-08-27** — Audited in [`docs/m1/audit.md`](./m1/audit.md). 10 templates / 21 fixtures verified by `npm run verify:m1-prompts`. 0 fetch calls in Local mode. Ref: [`docs/m1/`](./m1/) |
| **M2** | **Model Catalog, Download, Storage & Lifecycle**: Backend manifest & signed URL APIs; private GCS CORS; OPFS/IndexedDB manager; Range resume; streaming SHA-256; atomic rollback. | P0 | **CONDITIONAL**<br/>(Not accepted) | 15/16 locally verified; external deployment gate remains | **2026-08-28** — Re-audited in [`docs/m2/audit.md`](./m2/audit.md). A recorded live GCS/IAM/CORS/Range verification is still required. |
| **M3** | **Production Runtime & Settings UX**: LiteRT-LM adapter; Worker protocol; real `LocalSuggestionProvider` inference; Settings UI model card & actions; telemetry; debug import; accessibility. | P0 | **Pending**<br/>(Next Target) | 0%<br/>(0/12 tasks) | Designed in [`docs/on-device-llm-design.md`](./on-device-llm-design.md) Section 14.6. Depends on M1 and M2. |
| **M4** | **Hardening, Cross-Platform Validation & Launch**: COOP/COEP; self-hosted assets; CSP; security review; Windows/Linux validation (M4.6); 30-min soak test; feature flags; runbooks. | P0 | **Pending** | 0%<br/>(0/13 tasks) | Designed in [`docs/on-device-llm-design.md`](./on-device-llm-design.md) Section 14.7. General-availability release gates. |

---

### 9.2 Overall Progress Metrics

| Metric | Pre-M1 | M0 | M1 | M2 | M3 | M4 | Overall Total |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Milestone Status** | Proposed | COMPLETE (GO) | COMPLETE | CONDITIONAL | Pending | Pending | **2 / 6 Milestones Completed; M2 release gates open** |
| **Total Tasks** | 4 | 9 | 11 | 16 | 12 | 13 | **65 Tasks** |
| **Completed Tasks** | 0 | 9 | 11 | 16 | 0 | 0 | **36 Completed (55.4%)** |
| **Pending / Proposed Tasks** | 4 | 0 | 0 | 0 | 12 | 13 | **29 Remaining** |
| **P0 Blocking Tasks** | 3 / 3 | 9 / 9 (100%) | 11 / 11 (100%) | 14 / 15 (93.3%) | 0 / 10 (0%) | 0 / 11 (0%) | **34 / 59 P0 Tasks Completed (57.6%)** |
| **Verification Gate** | Ready for Unit Tests | `npm run verify:m0` | `npm run verify:m1-prompts`<br/>`npm run test:on-device-boundary` | `uv run pytest`<br/>`npm run test:js` | E2E & CUJ tests | Compatibility matrix & soak test | All M0, M1, M2 gates active in CI |

---

### 9.3 Detailed Task Completion by Milestone

#### 9.3.1 Pre-M1: Monotonic Sequence Tagging (Quick-Win P0)

- **Objective:** Eliminate UI flickering, out-of-order suggestion overwrites, and debounce/cache inversion races before on-device streaming integration.
- **Reference Artifact:** [`docs/sequence-tagging-feature-brief.md`](./sequence-tagging-feature-brief.md)
- **Target Files:** `src/pv-app.ts`, `src/tests/test_pv-app.ts`

| Task ID | Task Description | Priority | Effort | Status | Deliverables & Completion Condition |
|---|---|:---:|:---:|:---:|---|
| **Pre-M1.1** | Add `latestSequenceId` and triple-gate checks in `src/pv-app.ts` | P0 | XS | **Proposed** | Increment monotonically on `updateSuggestions()`; enforce Gate 1 (cache hit), Gate 2 (pre-dispatch after debounce), and Gate 3 (post-fetch response arrival). |
| **Pre-M1.2** | Write Jasmine unit tests in `src/tests/test_pv-app.ts` | P0 | S | **Proposed** | Add unit tests covering out-of-order response resolution, cleared input during fetch, and cache protection from delayed in-flight responses. |
| **Pre-M1.3** | Manual QA validation under assistive input simulation | P1 | XS | **Proposed** | Verify high-speed typing (80+ WPM), rapid backspace/re-type, emotion chip toggles, language switching, and loading spinner behavior. |
| **Pre-M1.4** | Code review and merge into `main` | P0 | XS | **Proposed** | Verify 0% stale overwrite rate, 0 ms UI overhead, 8-byte memory footprint; clean merge without backend signature changes. |

#### 9.3.2 Milestone 0: Feasibility and Benchmark Harness (GO Decision)

- **Objective:** Prove runtime viability using a frozen candidate model and runtime in desktop Chrome before committing to full production architecture.
- **Frozen Reference Tuple:** `@litert-lm/core@0.15.0` + `gemma-4-E2B-it-web.litertlm` (commit `6b78abd019e61a1ca4cbe3b212d2c9ce8ff38a94`, `2,008,432,640` bytes, SHA-256 `3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5`).
- **Audit Record:** [`docs/m0/audit.md`](./m0/audit.md) | **Decision Record:** [`docs/m0/decision.md`](./m0/decision.md) | **Executable Gate:** `npm run verify:m0`

| Task ID | Requirement / Scope | Category | Priority | Status | Audited Verification Evidence |
|---|---|---|:---:|:---:|---|
| **M0.1** | Obtain and freeze candidate Gemma Web artifact | Model provisioning | P0 | **COMPLETE** | Frozen `gemma-4-E2B-it-web.litertlm` (2,008,432,640 bytes, Apache-2.0). Full SHA-256 independently verified and recorded in [`docs/m0/artifact.json`](./m0/artifact.json). |
| **M0.2** | Pin and locally bundle LiteRT-LM Web release | Runtime / build | P0 | **COMPLETE** | `@litert-lm/core` exact-pinned to `0.15.0`. Bundled locally via `tools/build-m0.mjs`; Wasm copied locally; 0 CDN references. |
| **M0.3** | Prove LiteRT-LM can run inside dedicated Worker | Runtime | P0 | **COMPLETE** | Executed candidate model inside dedicated Worker on Chrome 151 / Apple M1 Pro. 0 runtime crashes, 0 main-thread long tasks >200ms. |
| **M0.4** | Prove model persistence and load from OPFS | Storage / runtime | P0 | **COMPLETE** | Recorded 11 OPFS loads (5 page reloads, 1 browser restart) in `docs/m0/results/`. 0 model-byte network requests after initial copy. |
| **M0.5** | Validate cancellation and resource cleanup | Runtime | P0 | **COMPLETE** | Prefill canceled in 172.82 ms, decode in 39.34 ms; 0 stale chunks leaked; verified clean Engine deletion/recreation. |
| **M0.6** | Build repeatable benchmark harness | Performance | P0 | **COMPLETE** | Implemented `tools/m0-harness/`, served at `/m0`. Captures cold/warm load, TTFT, tokens/s, RAM class, OPFS usage without prompt leaks. |
| **M0.7** | Establish macOS development reference device | QA / compatibility | P0 | **COMPLETE** | Passed on macOS 26.6.1 / Apple M1 Pro / 16 GiB / Chrome 151. Compatibility recorded in [`docs/m0/compatibility.json`](./m0/compatibility.json). (Win/Linux deferred to M4.6). |
| **M0.8** | Validate representative prompt/output behavior | Model quality | P0 | **COMPLETE** | Passed all 6 warm multilingual test cases (en/ja/zh word & sentence prompts). Parsed exactly 5 suggestions per prompt within latency gates. |
| **M0.9** | Publish compatibility record & go/no-go decision | Architecture | P0 | **COMPLETE** | Recorded official **GO** decision in [`docs/m0/decision.md`](./m0/decision.md). Verified by `npm run verify:m0`. |

#### 9.3.3 Milestone 1: Provider and Prompt Foundation (Accepted)

- **Objective:** Establish provider-neutral interfaces, enforce strict routing with zero Cloud fallback, bundle canonical Jinja prompts, and prove browser/Python prompt parity.
- **Audit Record:** [`docs/m1/audit.md`](./m1/audit.md) | **Executable Gates:** `npm run verify:m1-prompts`, `npm run test:on-device-boundary`

| Task ID | Requirement / Scope | Category | Priority | Status | Audited Verification Evidence |
|---|---|---|:---:|:---:|---|
| **M1.1** | Inference-mode schema and configuration migration | Frontend state | P0 | **COMPLETE** | Added `InferenceMode` (`cloud` \| `local`) in `src/config-storage.ts` & `src/state.ts`. Default `cloud`; safe migration; tested in `test_config-storage.ts` & `test_state.ts`. |
| **M1.2** | Define provider-neutral request and result types | Architecture | P0 | **COMPLETE** | Defined `SuggestionRequest`, `SuggestionResult`, partial results, and provider interfaces in `src/suggestion-provider.ts`. Decoupled from runtime types. |
| **M1.3** | Extract existing Cloud flow into `CloudSuggestionProvider` | Frontend / Cloud | P0 | **COMPLETE** | Extracted from `MacroApiClient` into `src/cloud-suggestion-provider.ts`. Preserved `/run-macro` contract, abort handling, and response parsing. |
| **M1.4** | Implement `SuggestionProviderRouter` with strict no-fallback | Architecture / Privacy | P0 | **COMPLETE** | Implemented `src/suggestion-provider-router.ts`. Strictly 0 automatic fallback to Cloud on Local failure. Covered by router unit tests. |
| **M1.5** | Bundle canonical Jinja prompt sources into frontend | Build / prompts | P0 | **COMPLETE** | Bundled canonical `.jinja2` files via esbuild text loader in `src/prompt-templates.ts`. Verifier detects missing or extraneous templates. |
| **M1.6** | Implement restricted browser Jinja prompt renderer | Frontend / prompts | P0 | **COMPLETE** | Implemented `src/prompt-renderer.ts` supporting current template constructs, matching Python whitespace and escaping, and rejecting unknown prompt IDs. |
| **M1.7** | Port input and output normalization for Local inference | Frontend / prompts | P0 | **COMPLETE** | Implemented Japanese spacing, `§` workaround, asterisk cleanup, half-width spaces, deduplication, and numbered-list parsing in `src/local-suggestion-provider.ts`. |
| **M1.8** | Add Python/browser golden prompt tests | Testing / prompts | P0 | **COMPLETE** | Verified 10 canonical templates × 21 fixtures per template (210 checks) with byte-for-byte parity via `npm run verify:m1-prompts`. |
| **M1.9** | Implement mock `LocalSuggestionProvider` | Frontend / testing | P0 | **COMPLETE** | Created `MockLocalSuggestionProvider` for CI testing seam and `UnavailableLocalSuggestionProvider` as production safety wrapper before M3. |
| **M1.10** | Provider- and version-aware suggestion caching | Frontend | P0 | **COMPLETE** | Updated `PvAppElement.cacheKey()` in `src/pv-app.ts` to include provider mode, model ID/version, prompt IDs, language, input, and context. |
| **M1.11** | Local network privacy regression test suite | Privacy / testing | P0 | **COMPLETE** | Added spies on `fetch` in `src/tests/test_suggestion-providers.ts`. Verified 0 requests to `/run-macro` during Local typing, cancellation, and errors. |

#### 9.3.4 Milestone 2: Model Catalog, Download, Storage & Lifecycle (CONDITIONAL)

- **Objective:** Build GCS signed-URL distribution, OPFS model storage, IndexedDB metadata management, resumable Range downloads, streaming SHA-256 verification, and atomic rollback.
- **Reference Design:** [`docs/on-device-llm-design.md`](./on-device-llm-design.md) Section 14.5
- **Status:** **CONDITIONAL (15/16 locally verified; M2.5 live deployment gate pending)** (Audited in [`docs/m2/audit.md`](./m2/audit.md))

| Task ID | Task Description | Category | Priority | Effort | Status | Deliverables & Completion Condition |
|---|---|---|:---:|:---:|:---:|---|
| **M2.1** | Define and validate model-manifest schema | Shared API / security | P0 | M | **COMPLETE** | TypeScript and Python schemas, numeric bounds, allowed formats, rejection of executable/URL fields. |
| **M2.2** | Add administrator model configuration | Backend / ops | P0 | M | **COMPLETE** | Deployment-configured candidate model metadata (ID, version, bucket object, immutable generation, hash). |
| **M2.3** | Implement `GET /api/on-device-models/default` | Backend API | P0 | S | **COMPLETE** | Public manifest endpoint returning metadata, hardware requirements, and defaults with cache headers. |
| **M2.4** | Implement signed-download-URL endpoint | Backend API / security | P0 | M | **COMPLETE** | `POST /api/on-device-models/{modelId}/download-url` with generation pinning, 1hr TTL, CSRF, log redaction. |
| **M2.5** | Configure private GCS distribution path | Cloud infrastructure | P0 | M | **PENDING LIVE VERIFICATION** | Local policy tests exist, but the configured private bucket, IAM/CORS settings, immutable object generation, and real full/Range GET responses still need a recorded live verification. |
| **M2.6** | Implement IndexedDB metadata repository | Storage | P0 | M | **COMPLETE** | Transactional model/version stores, active/LKG updates, multi-instance persistence, schema upgrade v1->v2 preservation, and explicit corruption recovery via `recoverCorruptedDatabase()` tested in Chrome Jasmine. |
| **M2.7** | Implement OPFS model repository | Storage | P0 | M | **COMPLETE** | Deterministic versioned paths, streaming file read/write, Worker file handles, targeted deletion. |
| **M2.8** | Implement `ModelManager` lifecycle state machine | Frontend / storage | P0 | L | **COMPLETE** | 10-state machine (`unsupported` to `ready`), legal transitions, stable error codes, recovery actions. |
| **M2.9** | Capability, quota, and persistence preflight | Frontend / storage | P0 | M | **COMPLETE** | Feature detect WebGPU/OPFS/Worker, verify model + 20% quota, call `navigator.storage.persist()`. |
| **M2.10** | Streaming download, progress, and cancellation | Frontend / storage | P0 | L | **COMPLETE** | Stream signed response directly to OPFS partial file without memory copy; report speed/progress. |
| **M2.11** | Signed-URL refresh and Range resume | Frontend / backend | P0 | L | **COMPLETE** | Resume at verified byte offset, request fresh URL upon expiry, validate GCS generation match. |
| **M2.12** | Streaming SHA-256 & artifact verification | Worker / security | P0 | M | **COMPLETE** | Bounded-memory streaming hash with zero-copy `ArrayBuffer` transfer running inside a dedicated Web Worker (`verifyArtifactDigestInWorker`) with in-thread fallback. Tested in Chrome Jasmine. |
| **M2.13** | Activation and startup recovery | Storage / lifecycle | P0 | L | **COMPLETE** | Local-first IndexedDB/OPFS reconciliation with zero network calls for installed models. `defaultModelCandidateProbe` validates candidate file readability, size, and adapter constraints before atomic activation. |
| **M2.14** | Manual update, rollback, and cleanup | Storage / lifecycle | P0 | L | **COMPLETE** | Explicit metadata update checks retain the active/LKG artifact; cleanup occurs only after the first successful-suggestion confirmation boundary. |
| **M2.15** | Coordinate downloads across tabs | Frontend / concurrency | P1 | M | **COMPLETE** | Web Locks API and BroadcastChannel coordination to block duplicate parallel downloads. |
| **M2.16** | Lifecycle and failure-injection test suite | Testing | P0 | L | **COMPLETE** | Comprehensive suite covering site-data loss recovery, smoke test failure recovery, orphan partial file cleanup, zero re-download on repeated restarts, signed-metadata/Range tampering, and LKG retention. |

#### 9.3.5 Milestone 3: Production Runtime and Settings Experience (Pending)

- **Objective:** Connect `@litert-lm/core` Web Worker adapter to `LocalSuggestionProvider` and deliver user-facing Settings UI and telemetry.
- **Reference Design:** [`docs/on-device-llm-design.md`](./on-device-llm-design.md) Section 14.6
- **Status:** **Pending** (Queued after M2)

| Task ID | Task Description | Category | Priority | Effort | Status | Deliverables & Completion Condition |
|---|---|---|:---:|:---:|:---:|---|
| **M3.1** | Implement production LiteRT-LM runtime adapter | Runtime | P0 | L | **Pending** | Implement `ModelRuntimeAdapter` wrapping `@litert-lm/core`: probe, load, stream, cancel, dispose. |
| **M3.2** | Finalize typed inference Worker protocol | Runtime / frontend | P0 | L | **Pending** | Versioned request/response messaging schema for main thread and Worker; recoverable crash handling. |
| **M3.3** | Connect `ModelManager` loading and automatic startup | Runtime / lifecycle | P0 | M | **Pending** | Open active OPFS artifact, load into Worker, run activation smoke prompt, auto-load on page startup. |
| **M3.4** | Connect `LocalSuggestionProvider` to real inference | Runtime / frontend | P0 | M | **Pending** | Render word/sentence prompts, pass to Worker, normalize output, emit partial words then sentences. |
| **M3.5** | Implement latest-request scheduling and cancellation | Runtime / perf | P0 | M | **Pending** | Enforce 1 active generation, cancel obsolete prompts on typing, sequence ID matching. |
| **M3.6** | Separate inference source and Cloud model in Settings | UX / frontend | P0 | M | **Pending** | Settings UI: Cloud (Gemini) vs On-device toggle, independent model selection under Cloud. |
| **M3.7** | Build On-device model card and lifecycle actions | UX / frontend | P0 | L | **Pending** | Model metadata, download/load/update/remove buttons, confirmation dialog, accessible progress. |
| **M3.8** | Implement user-facing Local errors and recovery | UX / localization | P0 | M | **Pending** | Actionable error messages for out-of-memory, unsupported WebGPU, download fail, retry actions. |
| **M3.9** | Implement resource-status telemetry panel | Frontend / diagnostics | P1 | M | **Pending** | Logical CPUs, coarse RAM, page memory, WebGPU backend, inference activity, latency, tokens/sec. |
| **M3.10** | Implement development/debug model import | DevEx / storage | P1 | M | **Pending** | Feature-flagged `.litertlm` file picker import, OPFS copy, unverified badge, smoke test. |
| **M3.11** | Apply accessibility behavior to complete flow | Accessibility / UX | P0 | M | **Pending** | `aria-live` status, progress semantics, full keyboard/switch navigation, high-contrast support. |
| **M3.12** | Add frontend and real-runtime integration tests | Testing | P0 | L | **Pending** | End-to-end CUJ testing, mode toggle under load, cancellation races, fake adapter tests in CI. |

#### 9.3.6 Milestone 4: Hardening, Cross-Platform Validation and Launch (Pending)

- **Objective:** Fulfill security, accessibility, cross-origin isolation (COOP/COEP), CSP, Windows/Linux matrix (M4.6), and 30-min soak test release gates.
- **Reference Design:** [`docs/on-device-llm-design.md`](./on-device-llm-design.md) Section 14.7
- **Status:** **Pending** (General-Availability Release Gate)

| Task ID | Task Description | Category | Priority | Effort | Status | Deliverables & Completion Condition |
|---|---|---|:---:|:---:|:---:|---|
| **M4.1** | Enable COOP/COEP on all application responses | Hosting / security | P0 | M | **Pending** | Add `COOP: same-origin` & `COEP: require-corp` on Flask & App Engine static handlers; verify isolation. |
| **M4.2** | Self-host fonts, icons, runtime, Wasm, Worker assets | Build / hosting | P0 | M | **Pending** | Bundle Google Fonts, Material Symbols, LiteRT Wasm locally; 0 external runtime CDNs. |
| **M4.3** | Add and validate Content Security Policy (CSP) | Security | P0 | M | **Pending** | Strict CSP restricting scripts/Workers to self, allow only GCS model bucket connections. |
| **M4.4** | Complete backend, IAM, and signed-URL security review | Security / backend | P0 | M | **Pending** | Least privilege IAM audit, CSRF verification, rate limiting, generation check audit. |
| **M4.5** | Run end-to-end privacy and network tests | Privacy / QA | P0 | M | **Pending** | Wire-level packet/fetch capture confirming 0 bytes sent to Gemini/backend during Local mode. |
| **M4.6** | Complete desktop Chrome compatibility matrix | QA / compatibility | P0 | L | **Pending** | Validate on macOS (Apple Silicon/Intel), Windows 11 (NVIDIA/Intel/AMD), Linux (Mesa/Vulkan). |
| **M4.7** | Run performance, memory, and soak validation | Performance / QA | P0 | L | **Pending** | Measure latency SLOs (2s first-word, 5s complete), 30min continuous typing memory leak test. |
| **M4.8** | Run download and lifecycle failure-injection validation | QA / reliability | P0 | L | **Pending** | Network drop mid-download, disk full, corrupted OPFS bytes, GPU context loss recovery. |
| **M4.9** | Complete accessibility review and remediation | Accessibility / QA | P0 | M | **Pending** | Screen reader validation (NVDA/VoiceOver), switch control audit, focus trap remediation. |
| **M4.10** | Add feature-flag and rollout controls | Release / ops | P0 | M | **Pending** | Gradual rollout (internal canary -> 10% -> 100%), kill-switch without silent Cloud routing. |
| **M4.11** | Add privacy-safe local diagnostics export | Operations / support | P1 | M | **Pending** | Client-side export of hardware capabilities, state logs, errors (excluding user text). |
| **M4.12** | Write deployment, support, and update runbooks | Documentation / ops | P1 | M | **Pending** | Runbooks for publishing new models, rotating GCS keys, incident response, rollback guide. |
| **M4.13** | Execute final release review | Release management | P0 | S | **Pending** | Executive sign-off across privacy, security, accessibility, and performance gates. |

---

## 10. Important Acceptance Criteria

- Local mode makes zero `/run-macro` calls.
- Local failure makes zero automatic Cloud calls.
- Model bytes are not downloaded again across normal reloads and browser restarts.
- Download resume, checksum rejection, update rollback, and site-data deletion behavior are tested.
- Typing remains responsive while inference runs in the Worker.
- Stale suggestions never appear after newer input.
- Current language prompt paths remain renderable and parseable.
- Settings and progress controls remain keyboard- and screen-reader-accessible.
- Proposed performance targets are p95 first word suggestions within 2 seconds and the complete result within 5 seconds on the agreed reference-device matrix.
- If the target Gemma artifact fails the M0 memory, stability, or latency gates, it does not ship; the team must provide a smaller Web-compatible artifact or explicitly revise the design.

## 11. Open Inputs Before Implementation

The design is decision-complete at the architectural level, but implementation still needs concrete deployment inputs:

1. Exact Gemma model artifact, file size, checksum, license, and GCS object generation (frozen for M0: `gemma-4-E2B-it-web.litertlm`).
2. Exact `@litert-lm/core` version to pin after M0 validation (frozen for M0: `0.15.0`).
3. Private GCS bucket and production/development CORS origins.
4. Backend identity and IAM permission used to sign URLs.
5. Production feature-flag mechanism for enabling Local mode.
6. Development feature-flag mechanism for local import.
7. Desktop Chrome reference-device matrix for macOS, Windows, and Linux.
8. Final performance SLO approval; the design currently proposes 2-second first-word and 5-second complete-result p95 targets.
9. Model-quality evaluation corpus and human-review criteria for each supported language.
10. Decision on whether French, German, and Swedish experimental language modes are release-blocking or best-effort for the first certified model.

## 12. Recommended Starting Point for the Next Session

1. **Begin Milestone 3 (Production Runtime & Settings UX):**
   - Connect `@litert-lm/core` Web Worker adapter to `LocalSuggestionProvider` using verified candidate model artifacts from OPFS (`src/on-device/model-storage.ts`).
   - Implement typed Worker protocol (`LITERT_LM_INIT`, `LITERT_LM_GENERATE`, `LITERT_LM_UNLOAD`).
   - Build user-facing Settings UI model card (`src/pv-settings-overlay.ts`) showing download/ready status, storage usage, download action, and update check.
   - Wire telemetry and structured lifecycle metrics.
2. **Verify Milestone Gates:**
   - Run verification checks regularly:
     ```bash
     npm run verify:m1-prompts
     npm run test:on-device-boundary
     npm run test:js
     uv run pytest
     ```

## 13. Workspace State at Handoff

- **Completed Foundation Modules in `src/`:**
  - `src/suggestion-provider.ts`: provider-neutral interface & `SuggestionProviderRouter` with strict no-fallback.
  - `src/cloud-suggestion-provider.ts`: extracted Cloud suggestion provider.
  - `src/prompt-templates.ts` & `src/prompt-renderer.ts`: bundled canonical Jinja templates and restricted browser Jinja renderer.
  - `src/local-suggestion-provider.ts`: local suggestion orchestration, transformations, and response normalization.
  - `src/mock-local-suggestion-provider.ts` & `src/unavailable-local-suggestion-provider.ts`: CI test seam and production safe provider.
- **Completed M2 Storage & Lifecycle Modules in `src/on-device/` & Backend:**
  - `model_manifest.py`: Python manifest schema validator and public manifest extractor.
  - `model_catalog.py`: Administrator model catalog and GCS generation-pinned signed URL generator.
  - `src/on-device/model-manifest.ts`: TypeScript manifest validation and interfaces.
  - `src/on-device/model-metadata.ts`: IndexedDB and in-memory model metadata repository.
  - `src/on-device/model-storage.ts`: OPFS and in-memory streaming model storage repository.
  - `src/on-device/hash-verifier.ts`: Incremental FIPS 180-4 streaming SHA-256 verifier.
  - `src/on-device/tab-coordinator.ts`: Web Locks and BroadcastChannel cross-tab download coordinator.
  - `src/on-device/model-client.ts`: HTTP client for default manifest and signed download URLs.
  - `src/on-device/model-manager.ts`: Complete 10-state lifecycle orchestrator.
- **Feasibility Harness in `tools/m0-harness/`:**
  - Independent feasibility harness under `/m0` (`npm run dev:m0`) with recorded macOS validation results in `docs/m0/results/`.
- **Documentation Suite in `docs/`:**
  - `docs/architecture.md` (and `docs/architecture.mmd`): complete 3-tier system architecture.
  - `docs/on-device-llm-design.md`: full technical design document.
  - `docs/sequence-tagging-feature-brief.md`: race condition elimination design.
  - `docs/on-device-llm-session-handoff.md`: session handoff and milestone tracking record.
  - `docs/m0/`: M0 feasibility README, audit, decision record, artifact and compatibility manifests.
  - `docs/m1/`: M1 provider foundation README and completion audit.
  - `docs/m2/`: M2 model catalog, download, storage and lifecycle README and completion audit.

Before committing, run:

```bash
git diff --check
git status --short
```

Project standard verification commands:

```bash
npm i
uv sync
npm run dev
npm run test:js
npm run test:py
npm run verify:m1-prompts
```
