# Milestone 0 Feasibility Harness

This directory and the development-only `/m0` route document the repeatable
feasibility work defined by M0.1–M0.9 in `docs/on-device-llm-design.md`. The
harness source lives under `tools/m0-harness/`; it is isolated from the
production suggestion path and is excluded from normal builds and deployments.
It does not enable Local mode in the main application.

## Frozen tuple

- Runtime: `@litert-lm/core@0.15.0`.
- Model: `gemma-4-E2B-it-web.litertlm`.
- Immutable model commit:
  `6b78abd019e61a1ca4cbe3b212d2c9ce8ff38a94`.
- Expected size: `2,008,432,640` bytes.
- Expected SHA-256:
  `3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5`.
- Backend: WebGPU in stable desktop Chrome.

Machine-readable details are in `artifact.json`.

## Build and run

```bash
npm install
uv sync
npm run dev:m0
```

Open `http://localhost:5000/m0` in stable desktop Chrome. `dev:m0` explicitly
enables and builds the harness; the normal `npm run dev` returns 404 for this
route. The page is served with COOP/COEP headers so page/Worker memory
measurement can be used when Chrome supports it. The runtime JavaScript is
bundled into the Worker. Loader scripts are copied from the pinned npm package
to `/static/vendor/litert-lm/wasm/` and their Wasm binaries are also copied to
`/static/`, where Emscripten resolves them relative to the classic Worker URL.
No runtime CDN is used.

The upstream package exports an unused default jsDelivr path, so that literal
remains in the bundle. The M0 classic Worker explicitly calls `loadLiteRtLm()`
with the same-origin loader path before creating an engine. The build check
requires that local path and rejects every other runtime CDN reference.

## Acquire and verify the candidate

The page can download the frozen candidate directly into OPFS. To verify the
artifact independently before importing it, download from the immutable URL
recorded in `artifact.json`, then run:

```bash
shasum -a 256 gemma-4-E2B-it-web.litertlm
wc -c gemma-4-E2B-it-web.litertlm
```

Both values must exactly match the frozen tuple. The M0 page also rejects a
local import whose filename or byte size differs. Streaming SHA-256 enforcement
inside the application belongs to M2; M0 records and independently verifies the
candidate digest.

## Required run sequence

1. Select **Check capabilities**. HTTPS/localhost, OPFS, WebGPU adapter, and
   WebGPU device must all be available.
2. Select **Download frozen candidate**, or import the independently verified
   file. This is the only step that retrieves model bytes.
3. Select **Load from OPFS**. Record the first load as cold.
4. Run one case as the recorded WebGPU warm-up, then run all six English,
   Japanese, and Mandarin word/sentence cases as warm samples.
5. Start a sentence case and select **Cancel** during prefill; repeat during
   decode. Confirm that no later chunk changes the output.
6. Select **Unload**, then **Load from OPFS** and rerun a case. This exercises
   engine deletion and recreation.
7. Reload Chrome five times and restart Chrome at least once. Every load must
   report `source: opfs`; DevTools Network must show zero model-byte requests.
8. Select **Export sanitized JSON**. Generated output and prompt text are
   intentionally excluded.
9. The M0 development gate requires this sequence on one current stable Chrome
   macOS device. Windows and Linux validation is deferred to the
   post-development compatibility phase.

The exported records capture load/generation timing, time to first token, time
to first parsed suggestion, complete latency, LiteRT-LM prefill/decode rates,
page memory where available, OPFS usage/quota, main-thread long tasks, and
coarse browser/device metadata.

## Automated checks

```bash
npm run pretest
npm run test:js
uv run pytest
npm run build:m0
npm run test:m0-verifier
```

Normal CI uses protocol and parser tests rather than loading the two-gigabyte
model. A real artifact is required for the dedicated device run.

## Result handling

Commit sanitized result exports under `docs/m0/results/` using names such as
`macos-m1-pro-chrome-151.json`. Update `compatibility.json` with the exact OS,
Chrome, GPU/driver or graphics backend, RAM class, pass/fail status, and result
path. Never add prompts, persona, conversation history, generated suggestions,
serial numbers, hardware UUIDs, or full signed URLs.

After the macOS export is present, run:

```bash
npm run verify:m0
```

The verifier rejects exports that contain sensitive-content fields, do not use
the frozen runtime/model tuple, omit required device metadata, lack five OPFS
loads, miss a benchmark case or cancellation phase, render stale chunks, exceed
the provisional latency or main-thread responsiveness targets, contain runtime
errors, or omit the macOS development reference result. Windows and Linux
exports are optional for M0 and are validated when supplied.

The milestone is complete only when every M0.1–M0.9 item and the documented
M0 exit criteria pass. The current decision is recorded in `decision.md`.
