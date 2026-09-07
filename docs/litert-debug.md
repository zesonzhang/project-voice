# LiteRT-LM debug playground

Run on the current checkout:

```sh
npm i
npm run dev:litert-debug
```

With npm 12, if installation reports `EALLOWGIT` for the existing `simhash-js`
dependency, use `npm i --allow-git=root` for that installation.

Open <http://127.0.0.1:5000/debug/litert-lm> in a WebGPU-capable desktop browser.
For another port, run `npm run build:litert-debug` followed by
`ENABLE_LITERT_DEBUG=1 uv run flask --app main run --port 5001`.
`npm run watch:litert-debug` rebuilds the debug page and worker during editing.
No GCS catalog, model signing credentials, or cloud inference configuration is
needed. The optional Secret Manager warning at server startup does not affect
this page.

Download Gemma 4 E2B, then load it. The public Hugging Face artifact is pinned to
revision `6b78abd019e61a1ca4cbe3b212d2c9ce8ff38a94`, 2,008,432,640 bytes, SHA-256
`3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5`.
These identifiers come from commit `f528a8f`'s `docs/m0/artifact.json`.
The runtime remains `@litert-lm/core@0.15.0`; WASM is served locally.

The downloader uses up to four concurrent 8 MiB Range requests, commits only
contiguous completed chunks into the existing OPFS storage, and verifies
the complete SHA-256 before promotion. Interrupted downloads resume using Range;
a 200 response restarts the file using a single streaming download. Connection
setup times out after 180 seconds; this does not limit total download duration.
Promotion copies the partial, so allow about
4.1 GB of free browser storage. Cache and metadata use the existing Project VOICE
OPFS/IndexedDB stores with the separate `debug-gemma-4-e2b-web` model ID. As with
local imports, generation `0` denotes a non-GCS artifact. This record is not a
production-certified model and does not change the main application's selection.

Choose a word and sentence template in Playground. Their shared variables appear
once, `text` comes from the input, and templates execute serially. Expand each
result to see its actual rendered prompt and raw response. Ordinary chat uses
completed user/assistant turns as structured preface messages. Stopped or failed
turns stay visible but are excluded from subsequent context. Switching modes or
starting a new conversation clears the session. Context errors require starting
a new conversation; the application does not truncate history. The engine uses
the existing 2048-token context setting.
LiteRT-LM 0.15 requires `prefillPrefaceOnInit` for these history messages to
affect inference. Its classic Worker also resolves WASM binaries relative to
the Worker URL; the debug build copies binaries into the gated debug directory.

The page and its dedicated assets return 404 unless `ENABLE_LITERT_DEBUG=1`.
Production build does not include the debug entrypoint; `.gcloudignore` excludes
its source, template, build script and generated bundle. Only debug responses
allow public model download origins and WASM compilation in CSP. Production
runtime assets retain their existing deployment behavior.

## Verification

```sh
npm run localize:build
npx tsc --noEmit
npm run test:js
uv run pytest
npm run verify:prompt-parity
npm run test:on-device-boundary
npm run build
npm run build:litert-debug
```

Manual GPU acceptance: download, cancel/resume, refresh and load from cache,
generate Mandarin word/sentence suggestions, chat for two turns with a fact from
the first turn, stop and generate again, start a new conversation, unload/reload.
Check browser console for CSP/WASM errors and record actual runtime metrics.

## Implementation validation (2026-09-06)

- TypeScript check and targeted GTS lint passed.
- Jasmine: 270 specs passed, including bounded concurrent ranges, resume,
  checksum rejection, connection timeout, cancellation, paired templates,
  structured history, mode reset and native select defaults.
- Python: 90 tests passed; debug route/CSP/WASM gating coverage is included.
- Prompt parity: all 10 templates, 21 fixtures per template passed.
- Production boundary check, production frontend/Worker bundles, Python
  requirements compilation and standalone debug build passed. The requirements
  step required network access to PyPI.
- Desktop and 390px layouts were inspected. Native Chrome reported WebGPU,
  cross-origin isolation and OPFS available. Public-source cancellation and
  resume were exercised in a real browser.

## Real model acceptance (2026-09-07)

Native Chrome 152 on macOS, LiteRT-LM 0.15.0, the pinned Gemma 4 E2B artifact
above, using hardware WebGPU with cross-origin isolation and OPFS enabled:

- Completed the public browser download, SHA-256 validation and promotion.
  The source was slow and intermittently timed out; retries resumed saved
  contiguous ranges. Refresh recognized the verified cache without downloading.
- First successful load plus smoke test: 37,123.9 ms. A subsequent page reload
  loaded in 3,599.6 ms; explicit unload/reload loaded in 3,399.3 ms.
- Default Mandarin templates with `周末 公园` produced exactly five words
  (`周末`, `公园`, `休息`, `散步`, `享受`) and five sentences, including
  `悠闲地在周末公园散步，呼吸着新鲜的空气。`.
  Word TTFT/total: 1,330.9/4,452.5 ms, decode 8.3 tok/s, prefill 281.3 tok/s.
  Sentence TTFT/total: 1,403.9/14,900.3 ms, decode 8.1 tok/s, prefill 378.9 tok/s.
- Chat turn one: `请记住：我最喜欢的颜色是蓝色。只回复收到。` → `收到`.
  Turn two: `我最喜欢什么颜色？` → `我最喜欢的颜色是蓝色。`.
  Second-turn TTFT/total: 665.1/1,524.2 ms, decode 9.2 tok/s.
- Stopped a streaming long park essay. Partial text remained with the interrupted
  label; the following color question completed with `蓝色` (1,000.6 ms total).
  New conversation cleared visible turns; switching modes cleared their session.
- Fixed two issues found only with the real runtime: debug-relative WASM assets
  initially returned HTML, and preface history needed explicit prefill. Repeated
  the affected flows successfully after both fixes.
- No CSP or WASM loading errors after the fixes. The runtime emits NPU registry,
  audio filterbank and unsupported profiling-summary logs, including INFO lines
  written to console error; these did not prevent WebGPU text generation.
- The existing integration test now uses an isolated coordinator fixture so
  delayed BroadcastChannel events from other tests cannot alter its model state.
