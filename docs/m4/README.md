# Milestone 4: Production Hardening, Quality, and Release Audit

This directory contains the documentation, audits, matrices, and runbooks for Milestone 4 (M4.1 through M4.13) of the Project VOICE On-device LLM implementation (`@litert-lm/core@0.15.0` + `gemma-4-e2b-it-web.litertlm`).

## Delivered Milestones Overview

| Milestone | Area | Documentation / Artifact | Status |
|---|---|---|:---:|
| **M4.1** | Security Isolation | Global COOP (`same-origin`) & COEP (`require-corp`) in `main.py` and `app.yaml` | **Complete** |
| **M4.2** | Asset Self-Hosting | Same-origin LiteRT Worker and Wasm (`/static/vendor/litert-lm/wasm/`) | **Complete** |
| **M4.3** | Content Security Policy | Restrictive CSP on Flask and App Engine static handlers | **Complete** |
| **M4.4** | Cloud Download Auth | Session + CSRF, rate limiting, 1-hour generation pinning | **Complete** |
| **M4.5** | E2E Privacy Verification | `tools/verify-m4-privacy-network.mjs`, `src/tests/test_m4_privacy_network.ts` | **Complete** |
| **M4.6** | Compatibility Matrix | `docs/m4/compatibility-matrix.md`, `docs/m4/compatibility.json`, `tools/verify-m4-compatibility.mjs` | **Complete** |
| **M4.7** | Performance & Soak | `docs/m4/performance-soak.md`, `tools/m4-soak-runner.mjs`, `src/tests/test_m4_performance_soak.ts` | **Complete** |
| **M4.8** | Failure Injection | `docs/m4/failure-injection.md`, `src/tests/test_m4_failure_injection.ts` | **Complete** |
| **M4.9** | Accessibility (A11y) | `docs/m4/accessibility.md`, `src/tests/test_m4_accessibility.ts` | **Complete** |
| **M4.10** | Rollout & Feature Flags | `docs/m4/rollout-controls.md`, `/api/features`, `src/feature-flags.ts` | **Complete** |
| **M4.11** | Privacy Diagnostics | `docs/m4/diagnostics-export.md`, `src/on-device/diagnostics-exporter.ts` | **Complete** |
| **M4.12** | Operations Runbooks | `docs/m4/runbooks/` (6 operational runbooks) | **Complete** |
| **M4.13** | Release Audit & Sign-off | `docs/m4/audit.md` | **Complete** |

---

## Key Invariants & Release Guarantees

1. **Strict Privacy Invariant:** Zero bytes sent to `/run-macro` or external cloud while Local mode is active. Pausing or disabling rollout NEVER silently reroutes an installed local user to Cloud Gemini.
2. **Deterministic Resumption:** Download interruptions, network drops, or tab reloads resume via HTTP Range requests without re-downloading existing chunks or losing byte offsets.
3. **Atomic Verification & Promotion:** Model artifacts are downloaded as `.partial` and promoted only after SHA-256 validation. Failed updates roll back cleanly to the last known good (LKG) version.
4. **Performance SLOs:** Warm first-word latency p95 <= 2.0s; complete completion p95 <= 5.0s; 0 main-thread blocking tasks > 200ms; < 10% memory growth over 30-min soak; output parse rate >= 95%.
5. **Universal Accessibility:** Compliant with WCAG 2.1 AA criteria, including screen reader live announcements (`aria-live`), progress bar roles, keyboard/switch navigation, and alert dialog focus restoration.

---

## Operational Runbooks (`docs/m4/runbooks/`)

- [Model Catalog Promotion](runbooks/model-promotion.md)
- [Emergency Rollback & Kill-Switch](runbooks/emergency-rollback.md)
- [Cache Invalidation & TTL Policies](runbooks/cache-invalidation.md)
- [GCS Signed URL Key Rotation](runbooks/signed-url-rotation.md)
- [Support Escalation & Diagnostics Triage](runbooks/support-escalation.md)
- [User Troubleshooting Guide](runbooks/user-troubleshooting.md)
