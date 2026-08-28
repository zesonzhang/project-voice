# Milestone 3: Production Runtime & Settings UX

Milestone 3 delivers the production WebGPU inference runtime, the dedicated Web Worker architecture, the ModelManager runtime lifecycle integration, the Settings UX, and complete privacy enforcement with zero silent fallback to cloud Gemini.

## Core Capabilities & Architecture

1. **Pre-M1 Sequence Tagging & Triple-Gate Race Elimination:**
   - Enforces strict monotonic sequence tagging across user keystrokes in `src/pv-app.ts`.
   - **Gate 1 (Cache Hit Check):** Discards cached suggestion lookups if newer input advanced `suggestionRequestId` before retrieval completed.
   - **Gate 2 (Pre-Dispatch Debounce Check):** Cancels dispatch inside `setTimeout` if `requestId !== this.suggestionRequestId`.
   - **Gate 3 (Post-Fetch & Partial Result Check):** Discards out-of-order suggestion completions or partial word emissions if sequence ID has advanced.

2. **Worker Protocol & Dedicated Web Worker (M3.1, M3.2):**
   - Versioned typed message protocol defined in `src/on-device/worker-protocol.ts` (`WORKER_PROTOCOL_VERSION = 1`).
   - Dedicated Web Worker `src/on-device/inference-worker.ts` bundled into `static/inference-worker.js` with Wasm assets synced.
   - Isolates CPU- and memory-intensive LLM execution (`@litert-lm/core@0.15.0`) from the main thread, keeping 60 FPS UI responsiveness during generation.
   - Handles `LOAD_MODEL`, `GENERATE`, `CANCEL`, `UNLOAD_MODEL`, `SMOKE_TEST`, and `GET_CAPABILITIES`.
   - Traps WebGPU device loss and emits structured recoverable error events.

3. **Runtime Adapter Pattern (M3.1):**
   - Standard `ModelRuntimeAdapter` interface in `src/on-device/model-runtime-adapter.ts`.
   - `InferenceWorkerClient` (`src/on-device/worker-client.ts`) implements `ModelRuntimeAdapter` on top of the dedicated Worker.
   - `FakeModelRuntimeAdapter` (`src/on-device/fake-runtime-adapter.ts`) provides a deterministic in-memory CI seam for browser tests.

4. **ModelManager Lifecycle Loading & Auto-Startup (M3.3):**
   - `ModelManager` integrates `runtimeAdapter` into its 10-state machine.
   - `loadActiveModel()` opens OPFS `.litertlm` artifact, loads weights into WebGPU via the adapter, executes smoke test hook, and transitions to `ready`.
   - `unloadActiveModel()` frees WebGPU resources and transitions back to `downloaded`.
   - `startup(autoLoad = true)` reconciles OPFS/IndexedDB on app launch and automatically loads the model when in `local` mode.

5. **Production Local Suggestion Provider & Serialized Inference (M3.4, M3.5):**
   - `LocalSuggestionProvider` in `src/local-suggestion-provider.ts` replaces the M1 placeholder.
   - Renders bundled Jinja templates using `renderPrompt` with full parameter parity.
   - **Serialized execution:** Generates words first and emits partial suggestions via `onPartialResult`, then generates sentences second, preventing GPU thrashing.
   - Applies Japanese whitespace normalization (`§` delimiter replacement and half-width space stripping).
   - AbortController and cancellation propagate to worker to halt generation immediately on new keystrokes.

6. **Settings UX & On-Device Model Card (M3.6, M3.7):**
   - Clean separation between Inference Source (`Cloud (Gemini)` vs. `On-device`) and Cloud AI Model selection in `src/pv-setting-panel.ts`.
   - Model Card displays model name, format, size, version, and reactive lifecycle badge (`Download Required`, `Downloading (XX% - XX MB/s)`, `Ready (Active)`, `Error`, etc.).
   - Full lifecycle action buttons: `Download`, `Cancel Download`, `Load Model`, `Unload`, `Retry`, `Remove`, `Check for Updates`.
   - Model removal is protected by an explicit confirmation dialog.

7. **User-Facing Local Errors & Zero Silent Fallback (M3.8):**
   - Localized, actionable error messages for `ERR_WEBGPU_UNSUPPORTED`, `ERR_INSUFFICIENT_STORAGE`, `ERR_DOWNLOAD_FAILED`, `ERR_CHECKSUM_MISMATCH`, `ERR_LOAD_FAILED`, `ERR_SMOKE_TEST_FAILED`, `ERR_TAB_LOCKED`.
   - Explicit recovery options (Retry, Download, manual switch to Cloud).
   - **Zero silent fallback invariant:** Local inference errors never trigger silent fallback to Cloud Gemini; suggestion text never leaves the browser in local mode.

8. **Resource-Status Telemetry Panel (M3.9):**
   - Collapsible diagnostics panel exposing:
     - Logical CPUs (`navigator.hardwareConcurrency`)
     - Device RAM class (`navigator.deviceMemory`)
     - OPFS storage usage and quota (`navigator.storage.estimate()`)
     - Model lifecycle state and rolling 60-second inference duty cycle
     - Last inference latency (ms) and throughput (tok/s)

9. **Development / Debug Model Import (M3.10):**
   - `importLocalModel(file: File)` in `ModelManager`.
   - Allows importing arbitrary local `.litertlm` model files via file picker.
   - Computes streaming SHA-256 into OPFS, saves metadata record marked `unverified_import`, runs smoke test, and activates model with unverified badge.

10. **Accessibility (A11y) (M3.11):**
    - `aria-live="polite"` for status and privacy notices.
    - `aria-live="assertive"` for error alerts.
    - Accessible progress bar semantics (`role="progressbar"`, `aria-valuenow`, `md-linear-progress`).
    - Full keyboard navigation and dialog focus management.

## Verification Summary

All verification suites pass cleanly:
- `npx tsc --noEmit`: 0 errors
- `npm run lint:js`: 0 errors
- `npm run test:m1-prompts`: 10 templates × 21 fixtures verified
- `npm run test:on-device-boundary`: production boundary checks passed
- `uv run pytest`: 61 tests passed (100%)
- `npm run test:js`: 223 Jasmine specs passed (0 failures)
- `npm run build`: builds frontend bundle, compiles requirements, builds inference worker, and syncs Wasm assets.
