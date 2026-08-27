# Milestone 2 Completion Audit

**Audit date:** 2026-08-28
**Overall status:** CONDITIONALLY COMPLETE (15/16 tasks verified locally; M2.5 requires a live deployment record).
The code-level gates pass locally. M2.5 is not closed by the policy simulator:
the live verifier must run against the configured private bucket, immutable
object generation, IAM policy, CORS rules, and real HTTP Range responses before
the milestone can be marked fully complete.

## Task Traceability Matrix (M2.1 – M2.16)

| Task ID | Task Description | Category | Status | Evidence & Implementation Details |
|---|---|---|:---:|---|
| **M2.1** | Define and validate model-manifest schema | Shared API / security | Complete | Strict TypeScript (`src/on-device/model-manifest.ts`) and Python (`model_manifest.py`) validators. Enforces version 1, alphanumeric model IDs, numeric bounds, allowlisted families/adapters/formats, language sets, and rejects any URL schemes or unknown fields. Covered by `tests/test_model_catalog.py` and `src/tests/test_model-manifest.ts`. |
| **M2.2** | Add administrator model configuration | Backend / ops | Complete | `model_catalog.py` manages deployment-configured candidate model metadata. Startup validation enforces schema, sha256 hex format, numeric generations, and private GCS bucket/object bindings without exposing unrestricted bucket paths. |
| **M2.3** | Implement `GET /api/on-device-models/default` | Backend API | Complete | Endpoint in `main.py` returns public manifest with `Cache-Control: public, max-age=300`. Returns explicit JSON 404 when unconfigured. Tested in `tests/test_model_catalog.py`. |
| **M2.4** | Implement signed-download-URL endpoint | Backend API / security | Complete | `POST /api/on-device-models/{modelId}/download-url` in `main.py` generates generation-pinned GCS signed URLs with 1-hour TTL. Enforces SeaSurf CSRF protection, validates model and version, and strictly redacts signed URLs from server logs. Tested in `tests/test_model_catalog.py`. |
| **M2.5** | Configure private GCS distribution path | Cloud infrastructure | Pending live verification | `npm run verify:gcs:policy` covers local policy logic. `npm run verify:gcs` is the deployment gate and must inspect the configured bucket/object and real HTTP responses; a successful run and deployment record are still required. |
| **M2.6** | Implement IndexedDB metadata repository | Storage | Complete | `IndexedDbModelMetadataStore` provides transactional model and version stores, multi-instance persistence, schema upgrade migration, and an explicit corruption-recovery path via `recoverCorruptedDatabase()`. Real browser tests in `src/tests/test_model-metadata.ts` run against IndexedDB in Chrome. |
| **M2.7** | Implement OPFS model repository | Storage | Complete | `src/on-device/model-storage.ts` implements `OpfsModelStorage` and `InMemoryModelStorage`. Implements deterministic `/project-voice/models/{modelId}/{version}.{partial,litertlm}` layout, chunked streaming read/write, targeted deletion, and File handle extraction. Tested in `src/tests/test_model-storage.ts`. |
| **M2.8** | Implement `ModelManager` lifecycle state machine | Frontend / storage | Complete | `src/on-device/model-manager.ts` implements the 10-state machine (`unsupported`, `not_downloaded`, `downloading`, `verifying`, `downloaded`, `loading`, `ready`, `generating`, `update_available`, `error`) with stable error codes and legal transitions. Tested in `src/tests/test_model-manager.ts`. |
| **M2.9** | Capability, quota, and persistence preflight | Frontend / storage | Complete | `ModelManager.checkCapabilities()` feature-detects HTTPS/localhost, WebGPU, OPFS, and Workers. Enforces model size + 20% storage quota headroom. Calls `navigator.storage.persist()` on download while treating denied persistence as a non-blocking warning. Tested in `src/tests/test_model-manager.ts`. |
| **M2.10** | Streaming download, progress, and cancellation | Frontend / storage | Complete | `ModelManager.executeDownload()` streams signed response directly to OPFS partial file without memory buffering. Emits bytes, speed, ETA, and progress, periodically persisting offset to IndexedDB. AbortController clean cancellation retains partial data. Tested in `src/tests/test_model-manager.ts`. |
| **M2.11** | Signed-URL refresh and Range resume | Frontend / backend | Complete | `ModelManager` resumes at verified byte offset with `Range: bytes=${offset}-`. Refreshes expired signed URLs (403) from API client and resumes. Safely handles servers returning 200 by restarting safely from offset 0. Tested in `src/tests/test_model-manager.ts`. |
| **M2.12** | Streaming SHA-256 & artifact verification | Worker / security | Complete | `src/on-device/hash-verifier.ts` implements `verifyArtifactDigestInWorker` running in a dedicated Web Worker with zero-copy `ArrayBuffer` transfer, keeping the main thread responsive during multi-GB hashing, with graceful in-thread fallback. Tested in `src/tests/test_hash-verifier.ts` for byte parity and progress reporting. |
| **M2.13** | Activation and startup recovery | Storage / lifecycle | Complete | Startup reconciles IndexedDB and OPFS with zero network calls for already installed models. `defaultModelCandidateProbe` validates candidate file readability, size, and adapter constraints before atomic activation. Tested in `src/tests/test_model-manager.ts`. |
| **M2.14** | Manual update, rollback, and cleanup | Storage / lifecycle | Complete | Background/manual update checks retain active version during candidate download, verifies storage space for both models, activates atomically, and deletes superseded version only after activation. `rollback()` restores `lastKnownGoodVersion`. Tested in `src/tests/test_model-manager.ts`. |
| **M2.15** | Coordinate downloads across tabs | Frontend / concurrency | Complete | `src/on-device/tab-coordinator.ts` implements `BrowserTabCoordinator` using Web Locks API (`model-download:${modelId}:${version}`) and `BroadcastChannel` (`project-voice-model-lifecycle`) to prevent duplicate downloads and synchronize progress across tabs. Tested in `src/tests/test_model-manager.ts`. |
| **M2.16** | Lifecycle and failure-injection test suite | Testing | Complete | Comprehensive failure-injection suite covers site-data loss recovery, smoke test failure recovery, orphan partial file cleanup, zero re-download on browser restart, signed-metadata/`Content-Range` tampering, exact LKG retention, path traversal, and short reads. Tested in `src/tests/test_model-manager.ts` and `tests/test_gcs_distribution.py`. |

## Verification Record

The following automated verification checks passed cleanly:

```bash
# 1. TypeScript compilation check
npx tsc --noEmit
# Exit code: 0 (clean compilation, zero errors)

# 2. GTS linting check
npx gts lint "src/on-device/*.ts" "src/tests/test_model*.ts" "src/tests/test_hash-verifier.ts"
# Exit code: 0 (clean, zero lint errors, zero warnings)

# 3. Python formatting check
npm run lint:py
# Exit code: 0 (perfect YAPF formatting across all Python sources)

# 4. Local GCS distribution policy verification
npm run verify:gcs:policy
# Validates policy logic and simulated HTTP contracts only.

# 4b. Live GCS deployment gate (not recorded in this commit)
npm run verify:gcs
# Requires deployment configuration, credentials, and network access.

# 5. Backend Python test suite
uv run pytest
# 61 passed, 9 warnings (including test_model_catalog.py and test_gcs_distribution.py)

# 6. On-device boundary guard
npm run test:on-device-boundary
# On-device production boundary checks passed.

# 7. Canonical Jinja prompt parity check
npm run verify:m1-prompts
# M1 prompt parity passed for 10 templates and 21 fixtures each.

# 8. M0 result verifier check
npm run test:m0-verifier
# M0 result verifier tests passed.

# 9. Frontend test bundle build
npm run pretest
# spec/test_bundle.js 854.2kb bundled successfully

# 10. Full Jasmine browser test suite
npm run test:js
# 199 specs, 0 failures
```

## M2 Exit Decision

**CONDITIONAL ACCEPTANCE (15/16 locally verified).**
The application implementation and local automated suites satisfy the code-level
requirements. Final M2 acceptance remains blocked on a successful live M2.5
verification against the deployed GCS bucket and immutable candidate object.
