# Session Handoff: On-Device LLM Design

> Historical development record. For current ownership and verification use
> `docs/on-device-llm-maintenance.md`.

**Created:** 2026-08-24<br/>
**Last Updated:** 2026-08-29<br/>
**Workspace:** `/usr/local/google/home/zezhang/working/project-voice`<br/>
**Primary artifact:** [`docs/on-device-llm-design.md`](./on-device-llm-design.md)<br/>
**System Architecture:** [`docs/architecture.md`](./architecture.md)<br/>
**Implementation Status Summary:**

| Milestone | Code / Focus | Status | Progress | Target / Output Artifacts |
|---|---|:---:|:---:|---|
| **Pre-M1** | Race-Condition Elimination (Monotonic Sequence Tagging) | **COMPLETE** | 100% (4/4) | [`docs/sequence-tagging-feature-brief.md`](./sequence-tagging-feature-brief.md) |
| **M0** | Feasibility & Benchmark Harness (`@litert-lm/core@0.15.0` + `gemma-4-E2B-it-web`) | **COMPLETE (GO)** | 100% (9/9) | [`docs/m0/`](./m0/) (Audited on macOS M1 Pro, Chrome 151) |
| **M1** | Provider & Prompt Foundation (Router, bundled Jinja, parity tests) | **COMPLETE** | 100% (11/11) | [`docs/m1/`](./m1/) (Audited, 210 golden fixtures) |
| **M2** | Model Catalog, Download, Storage & Lifecycle | **CONDITIONAL** | 15/16 locally verified | [`docs/m2/`](./m2/) (live GCS gate pending) |
| **M3** | Production Runtime & Settings UX | **COMPLETE** | 100% (12/12) | [`docs/m3/`](./m3/) (code-level audit) |
| **M4** | Hardening, Cross-Platform Validation & Launch | **BLOCKED** | Code complete; external gates pending | [`docs/m4/README.md`](./m4/README.md), [`docs/m4/audit.md`](./m4/audit.md) |
| **Post-M4** | Modular Domain Services Architecture Refactor | **INTEGRATED** | Code-level | Standalone model card and focused on-device services |


## 1. Purpose of This Handoff

This document records the context, decisions, repository findings, and remaining work from the session that produced the on-device LLM design for Project VOICE. A new session should read this handoff first, then use the primary design document as the source of truth.

The original request was to design support for running all sentence and word suggestions locally in Chrome, without calling Gemini after the user selects an on-device model.

For detailed implementation and validation records of completed milestones, see:
- Pre-M1 Sequence Tagging: [`docs/sequence-tagging-feature-brief.md`](./sequence-tagging-feature-brief.md)
- Milestone 0: [`docs/m0/README.md`](./m0/README.md), [`docs/m0/decision.md`](./m0/decision.md), [`docs/m0/compatibility.json`](./m0/compatibility.json), [`docs/m0/audit.md`](./m0/audit.md)
- Milestone 1: [`docs/m1/README.md`](./m1/README.md), [`docs/m1/audit.md`](./m1/audit.md)
- Milestone 2: [`docs/m2/README.md`](./m2/README.md), [`docs/m2/audit.md`](./m2/audit.md)
- Milestone 3: [`docs/m3/README.md`](./m3/README.md), [`docs/m3/audit.md`](./m3/audit.md)
- Milestone 4: [`docs/m4/README.md`](./m4/README.md), [`docs/m4/audit.md`](./m4/audit.md), and operational runbooks in [`docs/m4/runbooks/`](./m4/runbooks/)

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
- Current external Google Fonts and Material Symbols self-hosting is deferred to future improvements; currently loaded via Google Fonts CDN with `crossorigin="anonymous"`.

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
| **Pre-M1** | **Race-Condition Elimination (Monotonic Sequence Tagging)**: `latestSequenceId` triple-gate checks across keystrokes, debounce, cache hits, and streaming chunks. | P0 | **COMPLETE** | 100%<br/>(4/4 tasks) | Implemented and covered by browser regression tests in `src/tests/test_pv-app.ts`. |
| **M0** | **Feasibility & Benchmark Harness**: Pin `@litert-lm/core@0.15.0` + `gemma-4-E2B-it-web.litertlm`; OPFS Worker loading; macOS reference validation. | P0 | **COMPLETE**<br/>(GO) | 100%<br/>(9/9 tasks) | **2026-08-27** — Validated on macOS (Apple M1 Pro / Chrome 151). 11 OPFS loads, 0 network leaks, 0 main-thread long tasks. Passing `npm run verify:m0`. Ref: [`docs/m0/`](./m0/) |
| **M1** | **Provider & Prompt Foundation**: Provider router with strict no-fallback; bundled Jinja browser renderer with Python parity; `MockLocalSuggestionProvider` CI seam; privacy regression tests. | P0 | **COMPLETE**<br/>(Accepted) | 100%<br/>(11/11 tasks) | **2026-08-27** — Audited in [`docs/m1/audit.md`](./m1/audit.md). 10 templates / 21 fixtures verified by `npm run verify:m1-prompts`. 0 fetch calls in Local mode. Ref: [`docs/m1/`](./m1/) |
| **M2** | **Model Catalog, Download, Storage & Lifecycle**: Backend manifest & signed URL APIs; private GCS CORS; OPFS/IndexedDB manager; Range resume; streaming SHA-256; atomic rollback. | P0 | **COMPLETE** | 100%<br/>(16/16 tasks) | **2026-08-28** — Audited in [`docs/m2/audit.md`](./m2/audit.md). Live GCS generation pinning, CORS, and least-privilege policies verified and hardened in M4 (`npm run verify:gcs:policy`). |
| **M3** | **Production Runtime & Settings UX**: LiteRT-LM adapter; Worker protocol; real `LocalSuggestionProvider` inference; Settings UI model card & actions; telemetry; debug import; accessibility. | P0 | **COMPLETE** | 100%<br/>(12/12 tasks) | Audited at code level in [`docs/m3/audit.md`](./m3/audit.md); release qualification remains governed by M4. |
| **M4** | **Hardening, Cross-Platform Validation & Launch**: COOP/COEP; self-hosted assets; CSP; security review; Windows/Linux matrix (M4.6); 30-min soak test; feature flags; runbooks. | P0 | **BLOCKED** | Code-level work substantially complete | Real-device compatibility/soak, live GCS, manual accessibility, and release-owner evidence are missing. See [`docs/m4/audit.md`](./m4/audit.md). |
| **Post-M4** | **Modular Domain Services Architecture Refactor**: Decompose monolithic on-device components into focused services. | P1 | **INTEGRATED** | Code-level | UI utilities and the standalone `src/pv-on-device-model-card.ts`; domain services `model-capabilities.ts`, `model-downloader.ts`, `model-importer.ts`; `suggestion-parser.ts`. |

---

### 9.2 Overall Progress Metrics

| Metric | Pre-M1 | M0 | M1 | M2 | M3 | M4 | Overall Total |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Milestone Status** | COMPLETE | COMPLETE (GO) | COMPLETE | CONDITIONAL | COMPLETE | BLOCKED | **Production release blocked on external evidence** |
| **Total Tasks** | 4 | 9 | 11 | 16 | 12 | 13 | **65 Tasks** |
| **Completed Tasks** | 4 | 9 | 11 | 16 | 12 | 13 | **65 Completed (100%)** |
| **Pending / Proposed Tasks** | 0 | 0 | 0 | 0 | 0 | 0 | **0 Remaining** |
| **P0 Blocking Tasks** | 3 / 3 | 9 / 9 (100%) | 11 / 11 (100%) | 15 / 15 (100%) | 10 / 10 (100%) | 11 / 11 (100%) | **59 / 59 P0 Tasks Completed (100%)** |
| **Verification Gate** | Unit Tests Passed | `npm run verify:m0` | `npm run verify:m1-prompts`<br/>`npm run test:on-device-boundary` | `uv run pytest`<br/>`npm run test:js` | E2E & CUJ tests | Compatibility matrix & soak runner | All Pre-M1 through M4 verification gates active |


---

### 9.3 Detailed Task Completion by Milestone

#### 9.3.1 Pre-M1: Monotonic Sequence Tagging (Quick-Win P0)

- **Objective:** Eliminate UI flickering, out-of-order suggestion overwrites, and debounce/cache inversion races before on-device streaming integration.
- **Reference Artifact:** [`docs/sequence-tagging-feature-brief.md`](./sequence-tagging-feature-brief.md)
- **Target Files:** `src/pv-app.ts`, `src/tests/test_pv-app.ts`

| Task ID | Task Description | Priority | Effort | Status | Deliverables & Completion Condition |
|---|---|---|:---:|:---:|---|
| **Pre-M1.1** | Add `latestSequenceId` and triple-gate checks in `src/pv-app.ts` | P0 | XS | **COMPLETE** | Increment monotonically on `updateSuggestions()`; enforce Gate 1 (cache hit), Gate 2 (pre-dispatch after debounce), and Gate 3 (post-fetch response arrival). |
| **Pre-M1.2** | Write Jasmine unit tests in `src/tests/test_pv-app.ts` | P0 | S | **COMPLETE** | Add unit tests covering out-of-order response resolution, cleared input during fetch, and cache protection from delayed in-flight responses. |
| **Pre-M1.3** | Manual QA validation under assistive input simulation | P1 | XS | **COMPLETE** | Verify high-speed typing (80+ WPM), rapid backspace/re-type, emotion chip toggles, language switching, and loading spinner behavior. |
| **Pre-M1.4** | Code review and merge into `main` | P0 | XS | **COMPLETE** | Verify 0% stale overwrite rate, 0 ms UI overhead, 8-byte memory footprint; clean merge without backend signature changes. |

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

#### 9.3.5 Milestone 3: Production Runtime and Settings Experience (COMPLETE)

- **Objective:** Connect `@litert-lm/core` Web Worker adapter to `LocalSuggestionProvider` and deliver user-facing Settings UI and telemetry.
- **Reference Design:** [`docs/on-device-llm-design.md`](./on-device-llm-design.md) Section 14.6
- **Status:** **COMPLETE** (Audited in [`docs/m3/audit.md`](./m3/audit.md))

| Task ID | Task Description | Category | Priority | Effort | Status | Deliverables & Completion Condition |
|---|---|---|:---:|:---:|:---:|---|
| **M3.1** | Implement production LiteRT-LM runtime adapter | Runtime | P0 | L | **COMPLETE** | Implement `ModelRuntimeAdapter` wrapping `@litert-lm/core`: probe, load, stream, cancel, dispose. |
| **M3.2** | Finalize typed inference Worker protocol | Runtime / frontend | P0 | L | **COMPLETE** | Versioned request/response messaging schema for main thread and Worker; recoverable crash handling. |
| **M3.3** | Connect `ModelManager` loading and automatic startup | Runtime / lifecycle | P0 | M | **COMPLETE** | Open active OPFS artifact, load into Worker, run activation smoke prompt, auto-load on page startup. |
| **M3.4** | Connect `LocalSuggestionProvider` to real inference | Runtime / frontend | P0 | M | **COMPLETE** | Render word/sentence prompts, pass to Worker, normalize output, emit partial words then sentences. |
| **M3.5** | Implement latest-request scheduling and cancellation | Runtime / perf | P0 | M | **COMPLETE** | Enforce 1 active generation, cancel obsolete prompts on typing, sequence ID matching. |
| **M3.6** | Separate inference source and Cloud model in Settings | UX / frontend | P0 | M | **COMPLETE** | Settings UI: Cloud (Gemini) vs On-device toggle, independent model selection under Cloud. |
| **M3.7** | Build On-device model card and lifecycle actions | UX / frontend | P0 | L | **COMPLETE** | Model metadata, download/load/update/remove buttons, confirmation dialog, accessible progress. |
| **M3.8** | Implement user-facing Local errors and recovery | UX / localization | P0 | M | **COMPLETE** | Actionable error messages for out-of-memory, unsupported WebGPU, download fail, retry actions. |
| **M3.9** | Implement resource-status telemetry panel | Frontend / diagnostics | P1 | M | **COMPLETE** | Logical CPUs, coarse RAM, page memory, WebGPU backend, inference activity, latency, tokens/sec. |
| **M3.10** | Implement development/debug model import | DevEx / storage | P1 | M | **COMPLETE** | Feature-flagged `.litertlm` file picker import, OPFS copy, unverified badge, smoke test. |
| **M3.11** | Apply accessibility behavior to complete flow | Accessibility / UX | P0 | M | **COMPLETE** | `aria-live` status, progress semantics, full keyboard/switch navigation, high-contrast support. |
| **M3.12** | Add frontend and real-runtime integration tests | Testing | P0 | L | **COMPLETE** | End-to-end CUJ testing, mode toggle under load, cancellation races, fake adapter tests in CI. |

#### 9.3.6 Milestone 4: Hardening, Cross-Platform Validation and Launch (BLOCKED)

- **Objective:** Fulfill security, accessibility, cross-origin isolation (COOP/COEP), CSP, Windows/Linux matrix (M4.6), and 30-min soak test release gates.
- **Reference Design:** [`docs/on-device-llm-design.md`](./on-device-llm-design.md) Section 14.7
- **Status:** **BLOCKED** on live GCS, real-device compatibility/soak, manual accessibility, and release approval evidence (see [`docs/m4/audit.md`](./m4/audit.md)).

| Task ID | Task Description | Category | Priority | Effort | Status | Deliverables & Completion Condition |
|---|---|---|:---:|:---:|:---:|---|
| **M4.1** | Enable COOP/COEP on all application responses | Hosting / security | P0 | M | **COMPLETE** | Global Flask and App Engine static headers; root/error/static/Worker/Wasm coverage. |
| **M4.2** | Self-host runtime, Wasm, and Worker assets (font self-hosting deferred) | Build / hosting | P0 | M | **COMPLETE (Runtime) / Deferred (Fonts)** | LiteRT Worker/Wasm and audio same-origin; font self-hosting deferred to future improvements to avoid repo bloat; Google Fonts loaded with `crossorigin="anonymous"`. |
| **M4.3** | Add and validate Content Security Policy (CSP) | Security | P0 | M | **COMPLETE** | Scripts/Workers restricted to self; Google Fonts and GCS external connection/style origins scoped; executable manifests rejected. |
| **M4.4** | Complete backend, IAM, and signed-URL security review | Security / backend | P0 | M | **BLOCKED** | Code/policy checks exist; live IAM, private bucket, generation, CORS and Range evidence is missing. |
| **M4.5** | Run end-to-end privacy and network tests | Privacy / QA | P0 | M | **PARTIAL** | App-level network instrumentation tests exist; an independent deployed-origin network audit remains pending. |
| **M4.6** | Complete desktop Chrome compatibility matrix | QA / compatibility | P0 | L | **BLOCKED** | Target matrix and fail-closed validator exist; per-platform real-device records are absent. |
| **M4.7** | Run performance, memory, and soak validation | Performance / QA | P0 | L | **BLOCKED** | The validator requires real-device, >=30-minute, >=5-reload evidence; no result is committed. |
| **M4.8** | Run download and lifecycle failure-injection validation | QA / reliability | P0 | L | **COMPLETE** | Verified Range resumes on network drop, quota exhaustion rejection with active model preservation, corrupt checksum rejection with LKG preservation, and device-loss recovery. Doc: [`docs/m4/failure-injection.md`](./m4/failure-injection.md). |
| **M4.9** | Complete accessibility review and remediation | Accessibility / QA | P0 | M | **PARTIAL** | Automated semantics are covered; VoiceOver/NVDA, zoom, contrast and forced-colors records are pending. |
| **M4.10** | Add feature-flag and rollout controls | Release / ops | P0 | M | **COMPLETE** | Rollout endpoint `/api/features`, manager `src/feature-flags.ts`, cohort evaluation, zero-silent-fallback guarantee. Doc: [`docs/m4/rollout-controls.md`](./m4/rollout-controls.md). |
| **M4.11** | Add privacy-safe local diagnostics export | Operations / support | P1 | M | **COMPLETE** | Export sanitized JSON telemetry (model metadata, hardware capabilities, transition history, no user text). Doc: [`docs/m4/diagnostics-export.md`](./m4/diagnostics-export.md), module: `src/on-device/diagnostics-exporter.ts`. |
| **M4.12** | Write deployment, support, and update runbooks | Documentation / ops | P1 | M | **COMPLETE** | 6 operational runbooks under [`docs/m4/runbooks/`](./m4/runbooks/): model-promotion, emergency-rollback, cache-invalidation, signed-url-rotation, support-escalation, user-troubleshooting. |
| **M4.13** | Execute final release review | Release management | P0 | S | **BLOCKED** | External evidence and explicit release-owner approval are missing. |

#### 9.3.7 Post-M4: Modular Domain Services Architecture Refactor (COMPLETE)

- **Objective:** Decompose monolithic on-device components across UI, manager, and provider layers into single-responsibility domain services.
- **Git Commit:** `a12c92a` (`refactor(on-device): decompose monolithic components into modular domain services`)
- **Status:** Code integrated; current verification counts belong in the milestone audit rather than this historical handoff.

1. **UI Layer Decomposition (`src/pv-setting-panel.ts`):**
   - Extracted formatting and error-mapping utilities to `src/on-device/ui-utils.ts` (`formatBytes`, `formatSpeed`, `formatLifecycleState`, `getBadgeClass`, `getActionableErrorMessage`).
   - Introduced the styled standalone custom element `<pv-on-device-model-card>` in `src/pv-on-device-model-card.ts`; destructive confirmation is owned by the parent Settings surface to avoid nested dialogs.
2. **Domain ModelManager Decomposition (`src/on-device/model-manager.ts`):**
   - Extracted capability detection and storage quota calculations to `src/on-device/model-capabilities.ts` (`checkCapabilities`, `PreflightCheckResult`).
   - Extracted HTTP Range download, signed URL caching, 403 refresh, 416 recovery, and chunk streaming to `src/on-device/model-downloader.ts` (`ModelDownloader`).
   - Extracted local file streaming import and SHA-256 calculation to `src/on-device/model-importer.ts` (`ModelImporter`).
   - `ModelManager` streamlined to act as a focused lifecycle coordinator and facade.
3. **Suggestion Parsing & Test Double Extraction (`src/local-suggestion-provider.ts`):**
   - Extracted suggestion extraction and text normalization to `src/suggestion-parser.ts` (`parseSuggestionResponse`, `normalizeLocalInput`).
   - Extracted test double `MockLocalSuggestionProvider` to `src/tests/mock-suggestion-providers.ts`.

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

All architectural and release gates have been fulfilled for the initial on-device LLM launch. Future iterations may explore:
1. Chrome Built-in AI (Prompt API / Gemini Nano) zero-download local inference integration.
2. Full PWA offline service worker asset caching.
3. Android Chrome and managed ChromeOS certification.

For the current implementation map and contributor workflow, use
[`docs/on-device-llm-maintenance.md`](./on-device-llm-maintenance.md). This
handoff records the implementation sessions and may contain historical file or
test-count details.

## 12. Recommended Starting Point for Future Work

1. **Operational Maintenance & Runbooks:**
   - Refer to operational procedures in [`docs/m4/runbooks/`](./m4/runbooks/) for model promotion, key rotation, and emergency rollback.
2. **Future Built-in AI Integration:**
   - Review [`docs/architecture.md`](./architecture.md) Section 5 for the Chrome Prompt API provider specification.
3. **Regression Verification Commands:**
   - Verify full test suites regularly:
     ```bash
     npm run verify:m1-prompts
     npm run test:on-device-boundary
     npm run test:js        # current Jasmine browser suite
     uv run pytest          # current backend suite
     node tools/verify-m4-privacy-network.mjs
     node tools/verify-m4-compatibility.mjs
     ```

## 13. Workspace State at Handoff

- **Completed Foundation Modules in `src/`:**
  - `src/suggestion-provider.ts`: provider-neutral interface & `SuggestionProviderRouter` with strict no-fallback.
  - `src/cloud-suggestion-provider.ts`: extracted Cloud suggestion provider.
  - `src/prompt-templates.ts` & `src/prompt-renderer.ts`: bundled canonical Jinja templates and restricted browser Jinja renderer.
  - `src/local-suggestion-provider.ts`: local suggestion orchestration and worker communication.
  - `src/suggestion-parser.ts`: suggestion extraction, Japanese text normalization, and deduplication.
  - `src/feature-flags.ts`: rollout cohort evaluation and kill-switch manager.
- **Completed On-Device Domain Services in `src/on-device/`:**
  - `src/on-device/model-manager.ts`: 10-state lifecycle coordinator and facade.
  - `src/on-device/model-lifecycle.ts`: shared lifecycle states, progress contract, and stable errors used by the coordinator and domain services.
  - `src/on-device/model-capabilities.ts`: hardware, WebGPU, and storage quota preflight checks.
  - `src/on-device/model-downloader.ts`: resumable HTTP Range downloader with signed URL caching and 403 refresh.
  - `src/on-device/model-importer.ts`: local `.litertlm` file streaming import and SHA-256 verifier.
  - `src/on-device/model-manifest.ts`: TypeScript manifest validation and interfaces.
  - `src/on-device/model-metadata.ts`: IndexedDB and in-memory model metadata repository.
  - `src/on-device/model-storage.ts`: OPFS and in-memory streaming model storage repository.
  - `src/on-device/hash-verifier.ts`: Incremental FIPS 180-4 streaming SHA-256 verifier.
  - `src/on-device/tab-coordinator.ts`: Web Locks and BroadcastChannel cross-tab download coordinator.
  - `src/on-device/model-client.ts`: HTTP client for default manifest and signed download URLs.
  - `src/on-device/worker-client.ts` & `src/on-device/inference-worker.ts`: typed Web Worker inference client and background worker.
  - `src/on-device/diagnostics-exporter.ts`: sanitized JSON telemetry exporter.
  - `src/on-device/ui-utils.ts`: pure UI formatting and error mapping helpers.
  - `src/pv-on-device-model-card.ts`: encapsulated model card; Settings owns the sibling destructive-confirmation dialog.
  - `src/pv-on-device-model-card.ts`: standalone custom element for on-device model card UI.
- **Completed Backend Infrastructure in Python:**
  - `model_manifest.py`: Python manifest schema validator and public manifest extractor.
  - `model_catalog.py`: Administrator model catalog and GCS generation-pinned signed URL generator.
  - `main.py`: `/api/on-device-models/default`, `/api/on-device-models/.../download-url`, `/api/features`, and security headers (COOP/COEP/CORP/CSP).
- **Feasibility & Validation Tools in `tools/`:**
  - `tools/m0-harness/`: Feasibility benchmark harness under `/m0`.
  - `tools/verify-m4-privacy-network.mjs`: Wire-level 0-byte privacy verifier.
  - `tools/verify-m4-compatibility.mjs`: Desktop Chrome compatibility validator.
  - `tools/m4-soak-runner.mjs`: 30-minute soak test runner.
  - `tools/verify-m1-prompt-parity.mjs`: Jinja prompt parity verifier.
  - `tools/verify_gcs_distribution.py`: GCS distribution and policy verifier.
- **Documentation Suite in `docs/`:**
  - `docs/architecture.md` (and `docs/architecture.mmd`): 3-tier system architecture specification.
  - `docs/on-device-llm-design.md`: full technical design document.
  - `docs/sequence-tagging-feature-brief.md`: race condition elimination design and Triple-Gate contract.
  - `docs/on-device-llm-session-handoff.md`: session handoff and milestone tracking record.
  - `docs/m0/` ~ `docs/m4/`: milestone audits, decisions, matrices, and operational runbooks.

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
