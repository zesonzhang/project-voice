# Session Handoff: On-Device LLM Design

**Created:** 2026-08-24  
**Workspace:** `/Users/zezhang/working/project-voice`  
**Primary artifact:** [`docs/on-device-llm-design.md`](./on-device-llm-design.md)  
**Implementation status:** Design only; no application code or dependencies changed

## 1. Purpose of This Handoff

This document records the context, decisions, repository findings, and remaining work from the session that produced the on-device LLM design for Project VOICE. A new session should read this handoff first, then use the primary design document as the source of truth.

The original request was to design support for running all sentence and word suggestions locally in Chrome, without calling Gemini after the user selects an on-device model.

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

## 9. Proposed Effort and Milestones

| Milestone | Summary | Estimate |
|---|---|---:|
| M0 | Feasibility: pin runtime, load target Gemma from OPFS in a Worker, benchmark supported desktop Chrome platforms | 1–2 weeks |
| M1 | Provider routing and browser/Python prompt parity | 2 weeks |
| M2 | Manifest/signing APIs, GCS CORS, OPFS/IndexedDB lifecycle, resume, verification, update/rollback | 3–4 weeks |
| M3 | LiteRT-LM adapter, Worker protocol, Settings, telemetry estimates, debug import | 2–3 weeks |
| M4 | Security, cross-origin isolation, accessibility, E2E/device testing, soak tests, rollout | 2–3 weeks |

Overall estimate: **12–16 engineer-weeks**, or approximately **7–9 calendar weeks with two engineers**.

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

1. Exact Gemma model artifact, file size, checksum, license, and GCS object generation.
2. Exact `@litert-lm/core` version to pin after M0 validation.
3. Private GCS bucket and production/development CORS origins.
4. Backend identity and IAM permission used to sign URLs.
5. Production feature-flag mechanism for enabling Local mode.
6. Development feature-flag mechanism for local import.
7. Desktop Chrome reference-device matrix for macOS, Windows, and Linux.
8. Final performance SLO approval; the design currently proposes 2-second first-word and 5-second complete-result p95 targets.
9. Model-quality evaluation corpus and human-review criteria for each supported language.
10. Decision on whether French, German, and Swedish experimental language modes are release-blocking or best-effort for the first certified model.

These are provisioning, release, or evaluation inputs rather than unresolved architecture choices.

## 12. Recommended Starting Point for the Next Session

If the next session is for document review:

1. Read [`docs/on-device-llm-design.md`](./on-device-llm-design.md).
2. Review the user-confirmed decisions in Section 3 of this handoff.
3. Edit the primary design document directly; keep this handoff synchronized only if decisions materially change.

If the next session is for implementation:

1. Confirm the exact model artifact and runtime package version.
2. Start with M0 only; do not begin the full model-management UI before proving the model loads and generates from an OPFS `File`/`Blob` in a dedicated Chrome Worker.
3. Measure initial load time, warm generation latency, peak page/Worker memory, stability, cancellation, and all required language prompts.
4. Record M0 findings in a new document under `docs/` and update the design if the official LiteRT-LM API differs from the proposed adapter contract.
5. After M0 passes, implement provider separation and prompt-parity tests before building download/update UX.

Likely implementation areas include:

- `src/pv-app.ts`
- `src/macro-api-client.ts`
- `src/pv-setting-panel.ts`
- `src/state.ts`
- `src/config-storage.ts`
- `src/language.ts`
- `templates/prompts/`
- `main.py`
- App Engine/static response configuration
- New frontend model-manager, provider, adapter, Worker, storage, and prompt-renderer modules

## 13. Workspace State at Handoff

- No production code was modified.
- No tests were run because the session produced documentation only.
- No npm or Python dependency was installed or changed.
- The `docs/` directory is currently untracked in Git and contains:
  - `docs/on-device-llm-design.md`
  - `docs/on-device-llm-session-handoff.md`
- Existing user files and repository changes were not modified.

Before committing, run:

```bash
git diff --check
git status --short
```

If implementation begins later, use the project-standard commands:

```bash
npm i
npm run dev
npm test
npm run lint
```

