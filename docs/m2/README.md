# Milestone 2: Model Catalog, Download, Storage & Lifecycle

Milestone 2 delivers a secure, resumable, persistent, and rollback-safe model
installation and lifecycle foundation for on-device inference in Project VOICE.
It operates independently of the final Settings UI and production inference
engine, providing a robust programmatic API.

## Core Capabilities & Architecture

1. **Model Manifest & Catalog (M2.1, M2.2, M2.3):**
   - Public manifest schema validated in both Python (`model_manifest.py`) and
     TypeScript (`src/on-device/model-manifest.ts`).
   - Rejects unapproved adapters, format strings, unknown top-level keys,
     out-of-bounds generation parameters, and dangerous executable or URL fields.
   - Served via `GET /api/on-device-models/default` with `Cache-Control: public, max-age=300`.
   - Never exposes backend bucket names or private object storage paths.

2. **Signed Download URLs & Generation Pinning (M2.4, M2.5):**
   - `POST /api/on-device-models/{modelId}/download-url` generates genuine
     one-hour GCS V4 signed URLs pinned to the exact immutable generation.
   - Protected by SeaSurf CSRF and session controls.
   - Server-side logging strictly redacts signed URL tokens and signatures.

Production does not fall back to a source-controlled model binding. Configure
`ON_DEVICE_MODEL_CONFIG_JSON` or `ON_DEVICE_MODEL_CONFIG_PATH` with
`defaultModelId`, a `models` array, and each model's private `gcsBucket` and
`gcsObject`. Configuration is validated when the Flask application imports;
without it the catalog endpoint returns `NO_DEFAULT_MODEL_CONFIGURED`.

The runtime credentials used by `google-cloud-storage` must be able to sign URL
bytes and access only the configured object. Bucket IAM, CORS, immutable upload,
and real full/Range GET checks are deployment gates; local mock tests do not
prove those controls.

3. **Origin Private File System (OPFS) Repository (M2.7):**
   - Deterministic storage layout under `/project-voice/models/{modelId}/`:
     - `{version}.partial`: actively streaming or interrupted download bytes.
     - `{version}.litertlm`: verified, certified candidate model artifact.
   - Chunked streaming read/write without loading multi-gigabyte models into RAM.
   - Isolated version deletion preserving working models.

4. **IndexedDB Metadata Repository (M2.6):**
   - Structured transactional metadata database `project-voice-model-store`:
     - `models`: tracks `activeVersion`, `lastKnownGoodVersion`, and timestamps.
     - `versions`: tracks version manifests, download offsets, verification
       state (`unverified`, `verifying`, `verified`, `corrupt`), and import status.
   - Atomic rollback to `lastKnownGoodVersion` if a new model version fails.

5. **Lifecycle State Machine (`ModelManager`) (M2.8, M2.9, M2.10, M2.11):**
   - 10-state machine: `unsupported`, `not_downloaded`, `downloading`, `verifying`,
     `downloaded`, `loading`, `ready`, `generating`, `update_available`, `error`.
   - Preflight capability detection for HTTPS/localhost, WebGPU, OPFS, Workers,
     storage quota (model size + 20% headroom), and persistent storage.
   - Streaming download with periodic offset persistence (500 ms / 1 MB).
   - Resumable Range requests (`Range: bytes=${offset}-`) with automatic 403
     signed URL refresh and safe recovery if server ignores Range (HTTP 200).

6. **Streaming SHA-256 Verification (M2.12):**
   - Incremental FIPS 180-4 standard SHA-256 calculation (`StreamingSha256`)
     streaming file slices in 2 MB chunks.
   - Zero full-memory copies for 2GB+ model files.
   - Real-time verification progress reporting (0–100%).
   - Immediate deletion of corrupted candidate files upon checksum mismatch.
   - Worker processing applies per-chunk acknowledgement/backpressure so a
     multi-gigabyte artifact cannot accumulate in the Worker message queue.

7. **Activation & Rollback Boundaries (M2.13, M2.14):**
   - Pluggable probe and smoke test hooks before atomic promotion.
   - Atomic activation in IndexedDB; retains superseded version until new
     model proves stable.
   - Startup reconciliation resolves verified metadata and OPFS bytes with zero
     catalog or model-byte requests. Candidate activation is guarded by
     `defaultModelCandidateProbe`.

8. **Multi-Tab Concurrency (M2.15):**
   - Web Locks API (`model-download:${modelId}:${version}`) prevents duplicate
     parallel downloads across tabs.
   - `BroadcastChannel` (`project-voice-model-lifecycle`) synchronizes download
     progress and state transitions across open tabs.

## Automated Verification

Run all Milestone 2 verification checks:

```bash
# TypeScript compilation and GTS linting
npx tsc --noEmit
npx gts lint "src/on-device/*.ts" "src/tests/test_model*.ts" "src/tests/test_hash-verifier.ts"

# Python formatting, local GCS policy checks, and backend test suite
npm run lint:py
npm run verify:gcs:policy
uv run pytest

# Deployment gate: requires ON_DEVICE_MODEL_CONFIG_JSON or
# ON_DEVICE_MODEL_CONFIG_PATH plus GCP credentials and network access.
npm run verify:gcs

# Frontend browser test suite (Jasmine in Chrome)
npm run pretest
npm run test:js

# System boundary and parity checks
npm run test:on-device-boundary
npm run verify:m1-prompts
npm run test:m0-verifier
```

---

## Post-M2 Evolution & Domain Modularization Note

1. **M4 Security Hardening:**
   - In Milestone 4 (M4.4), the signed-download-URL endpoint was further hardened with per-client sliding-window rate limiting, strict CSP, and full isolation headers (`COOP: same-origin`, `COEP: require-corp`, `CORP: same-origin`). See [`docs/m4/README.md`](../m4/README.md) and [`docs/m4/audit.md`](../m4/audit.md).
2. **Domain Decomposition Refactor (Commit `a12c92a`):**
   - The monolithic `ModelManager` was decomposed into focused domain services:
     - `src/on-device/model-capabilities.ts` (`ModelCapabilities`): Hardware, WebGPU, and storage quota preflight checks.
     - `src/on-device/model-downloader.ts` (`ModelDownloader`): Resumable HTTP Range download, signed URL caching, 403 refresh, and chunk streaming.
     - `src/on-device/model-importer.ts` (`ModelImporter`): Local `.litertlm` file streaming import and SHA-256 calculation.
     - `ModelManager` now serves as the focused lifecycle coordinator and facade delegating to these services.
