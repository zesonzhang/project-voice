# On-Device LLM Implementation and Maintenance Guide

**Status:** Current implementation map and contributor guide
**Last reviewed:** 2026-08-29
**Scope:** The custom LiteRT-LM/WebGPU provider. Chrome built-in AI remains a
future architecture option and is not part of the current implementation.

This document is the shortest path for reviewing or changing the on-device LLM
feature. The detailed design remains in
[`on-device-llm-design.md`](./on-device-llm-design.md), milestone evidence is
under `docs/m0/` through `docs/m4/`, and operational procedures are under
[`m4/runbooks/`](./m4/runbooks/). The session handoff is historical context; it
is not the source of truth for the current file layout.

## Non-negotiable invariants

1. Local mode never falls back to Cloud. A local failure stays local and is
   shown to the user.
2. Prompts, conversation text, and generated suggestions do not leave the
   browser in Local mode. Catalog and signed-model-URL requests are allowed.
3. Only schema-validated, allowlisted manifests may reach the production model
   lifecycle.
4. Downloaded artifacts are pinned to an immutable GCS generation and must pass
   size and SHA-256 verification before activation.
5. Inference runs in the dedicated classic Web Worker. Do not move LiteRT-LM
   generation onto the UI thread.
6. A candidate update must not destroy the last-known-good version before the
   candidate completes its first successful real suggestion.
7. Production code under `src/on-device/` must not depend on the M0 harness.
8. Production modules must not import or re-export modules under `src/tests/`.

The executable guards are `npm run test:on-device-boundary` and
`npm run verify:m4-privacy`.

## End-to-end implementation map

### Application wiring and suggestion flow

| Responsibility | Implementation |
|---|---|
| Construct the manager, Worker adapter, and providers | `src/pv-app.ts` |
| Persist `cloud` / `local` selection | `src/config-storage.ts` |
| Apply rollout-pause policy for new activations | `src/feature-flags.ts` |
| Route to exactly one provider; no fallback | `src/suggestion-provider-router.ts` |
| Render word then sentence prompts and stream local results | `src/local-suggestion-provider.ts` |
| Render the bundled Jinja-compatible prompts | `src/prompt-renderer.ts`, `src/prompt-templates.ts` |
| Parse, normalize, and deduplicate model output | `src/suggestion-parser.ts` |
| Prevent stale async results from reaching the UI | sequence gates in `src/pv-app.ts` and the local provider |

The local request path is:

```text
pv-app
  -> SuggestionProviderRouter(local)
  -> LocalSuggestionProvider
  -> prompt renderer
  -> InferenceWorkerClient
  -> inference-worker.js
  -> LiteRT-LM / WebGPU
  -> suggestion parser
  -> sequence-gated UI update
```

`LocalSuggestionProvider` deliberately serializes word and sentence generation
to limit GPU and memory pressure. Cancellation is enforced at both the provider
sequence gate and the Worker protocol.

### Model lifecycle and persistence

| Module | Owned responsibility |
|---|---|
| `src/on-device/model-lifecycle.ts` | Shared lifecycle states, progress contract, stable error codes, and typed lifecycle error. It must not import the coordinator. |
| `src/on-device/model-manager.ts` | Lifecycle coordinator and public facade: startup reconciliation, state transitions, verification, activation, update, rollback, removal. |
| `src/on-device/model-capabilities.ts` | Secure-context, WebGPU, OPFS/Worker, adapter, persistence, and quota preflight. |
| `src/on-device/model-client.ts` | Fetch and validate the public manifest and request signed download URLs. |
| `src/on-device/model-downloader.ts` | Signed URL validation/cache, resumable Range download, 403 refresh, 416 restart, streaming writes and progress. |
| `src/on-device/hash-verifier.ts` | Incremental SHA-256 verification without loading the model into main-thread memory. |
| `src/on-device/model-storage.ts` | OPFS artifact/partial-file repository and in-memory test implementation. |
| `src/on-device/model-metadata.ts` | IndexedDB model/version metadata, active/LKG transaction rules, and in-memory test implementation. |
| `src/on-device/tab-coordinator.ts` | Web Lock ownership and BroadcastChannel progress/state fan-out across tabs. |
| `src/on-device/model-importer.ts` | Development-only `.litertlm` streaming import and unverified-import metadata. |
| `src/on-device/model-manifest.ts` | Browser-side public manifest schema and allowlist validation. |

The manager coordinates these services; it should not reimplement their HTTP,
storage, capability, or import algorithms. Domain services depend on
`model-lifecycle.ts`, not on `model-manager.ts`, which keeps the dependency graph
acyclic and makes each service independently testable.

Storage is split intentionally:

- OPFS stores large `.litertlm` and `.partial` byte streams.
- IndexedDB stores manifests, offsets, verification state, active version, and
  last-known-good version.
- `localStorage` stores user configuration only; it is not a model database.

### Worker runtime

| Module/artifact | Responsibility |
|---|---|
| `src/on-device/model-runtime-adapter.ts` | Provider-neutral runtime interface. |
| `src/on-device/worker-protocol.ts` | Versioned request/response schema and runtime validation. |
| `src/on-device/worker-client.ts` | Main-thread adapter, request timeouts, streaming, cancellation, and metrics. |
| `src/on-device/inference-worker.ts` | LiteRT-LM engine ownership, WebGPU probing, generation, cleanup, and device-loss handling. |
| `src/on-device/fake-runtime-adapter.ts` | Deterministic runtime seam for browser tests. |
| `static/inference-worker.js` and `.map` | Generated bundle; do not edit by hand. |
| `tools/build-worker.mjs` | Builds the Worker and synchronizes required Wasm assets. |

The Worker is classic rather than module-based because the pinned LiteRT-LM
release loads Wasm glue through `importScripts()`. Review this constraint before
changing bundling or Worker construction.

### Settings, diagnostics, and rollout

| Responsibility | Implementation |
|---|---|
| Settings mode selector and top-level integration | `src/pv-setting-panel.ts` |
| Model card custom element and event binding | `src/pv-on-device-model-card.ts` |
| Model card | `src/pv-on-device-model-card.ts` |
| Pure status formatting and actionable messages | `src/on-device/ui-utils.ts` |
| Privacy-safe local diagnostics | `src/on-device/diagnostics-exporter.ts` |
| Rollout API and client policy | `main.py`, `src/feature-flags.ts` |
| Operations and support | `docs/m4/rollout-controls.md`, `docs/m4/runbooks/` |

Diagnostics must never include prompts, conversation text, generated output,
cookies, authorization tokens, or signed URL query strings.

### Backend catalog and distribution

| Responsibility | Implementation |
|---|---|
| Private/public manifest validation | `model_manifest.py` |
| Deployment-configured catalog and generation-pinned GCS signing | `model_catalog.py` |
| Feature, manifest, and signed URL HTTP endpoints | `main.py` |
| Distribution policy checks | `tools/verify_gcs_distribution.py` |
| Backend coverage | `tests/test_model_catalog.py`, `tests/test_gcs_distribution.py` |

Production configuration comes from `ON_DEVICE_MODEL_CONFIG_JSON` or
`ON_DEVICE_MODEL_CONFIG_PATH`. `EXAMPLE_MODEL_CONFIG` is a fixture and is never
loaded implicitly. The public endpoint must not expose `gcsBucket` or
`gcsObject`.

## Safe change recipes

### Change or promote a model

Follow [`m4/runbooks/model-promotion.md`](./m4/runbooks/model-promotion.md).
Update deployment configuration rather than source defaults. Keep a version
label immutable: the same `(modelId, version)` must never identify new bytes.
Run both Python schema tests and the live distribution verification gate before
promotion.

### Change the manifest schema

Update the Python and TypeScript validators together:

1. `model_manifest.py`
2. `src/on-device/model-manifest.ts`
3. `tests/test_model_catalog.py`
4. `src/tests/test_model-manifest.ts`
5. Relevant examples and the API section of the design document

Unknown fields are rejected by design. A schema change is an API change, not a
frontend-only edit.

### Change the Worker protocol or LiteRT-LM version

Update `worker-protocol.ts`, both protocol participants, the pinned package
version, and `LITERT_LM_VERSION` together. Rebuild generated Worker assets with
`node tools/build-worker.mjs`; then run runtime, integration, compatibility, and
privacy tests. Increment `WORKER_PROTOCOL_VERSION` for incompatible messages.

### Add a lifecycle state or error

Change `model-lifecycle.ts`, the legal-transition table in `model-manager.ts`,
UI formatting/actionable messages, diagnostics expectations, and lifecycle
tests together. A new state must have documented entry and recovery paths.

### Change prompts or parsing

Maintain Cloud/local prompt parity unless the design explicitly changes. Run
`npm run verify:m1-prompts`; cover cancellation and stale-output behavior as
well as the expected text output.

## Review and verification checklist

For a normal on-device change:

```bash
npm run lint:js
npm run test:js
npm run test:on-device-boundary
npm run verify:m1-prompts
npm run verify:m4-privacy
npm run verify:m4-compatibility
uv run pytest
git diff --check
```

Additional gates:

- Worker/runtime change: `node tools/build-worker.mjs` and review generated
  bundle changes; use the real WebGPU matrix where applicable.
- Catalog/distribution change: `npm run verify:gcs:policy`; use
  `npm run verify:gcs` only with deployment credentials and network access.
- Performance-sensitive change: follow `docs/m4/performance-soak.md` and
  `docs/m4/failure-injection.md`.
- UI change: run `src/tests/test_on_device_model_card.ts` and `src/tests/test_on_device_settings.ts`, then complete the manual accessibility checklist in `docs/m4/accessibility.md`.

When reviewing, verify the invariants first, then the happy path. Pay special
attention to interrupted downloads, mode switches, abort races, multi-tab
ownership, checksum failures, device loss, offline startup, update rollback,
and cleanup after removal.

## Test ownership map

- Lifecycle/storage/catalog: `src/tests/test_model-manager.ts`,
  `test_model-storage.ts`, `test_model-metadata.ts`, `test_model-manifest.ts`
- Runtime/provider/integration: `test_m3_runtime.ts`, `test_m3_integration.ts`,
  `test_suggestion-providers.ts`, `test_pv-app.ts`
- Hardening: `test_m4_*.ts`, `tools/verify-m4-*.mjs`
- Cross-tab and integrity: `test_tab-coordinator.ts`, `test_hash-verifier.ts`
- Backend: `tests/test_model_catalog.py`, `tests/test_gcs_distribution.py`,
  `tests/test_main.py`
- Prompt parity: `tools/verify-m1-prompt-parity.mjs` and `tests/prompts/`

Prefer the in-memory storage/metadata implementations and fake runtime for
deterministic unit tests. Real artifact and WebGPU tests belong in the dedicated
compatibility/performance environment, not the default CI path.
