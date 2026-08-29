# Phase 4 (M4.1–M4.13) Release Audit

**Audit date:** 2026-08-29

**Scope status:** Code-level hardening substantially complete; external evidence incomplete.

**Release decision:** **BLOCKED**

The implementation can proceed through CI and controlled development use, but this repository does not contain the real-device, live-cloud, manual-accessibility, or release-approval records needed for a production sign-off.

## Milestone status

| Milestone | Area | Status | Evidence / remaining gap |
|---|---|:---:|---|
| M4.1 | COOP / COEP | Code complete | Headers and automated response tests exist; verify on the deployed origin. |
| M4.2 | Asset self-hosting | Partial | Runtime/Worker/Wasm are same-origin; font self-hosting remains deferred. |
| M4.3 | CSP | Code complete | Policy and automated tests exist; deployed-header inspection remains required. |
| M4.4 | Download security | Blocked | Session, CSRF, rate limiting and policy checks exist; live IAM, private-bucket, generation, CORS and Range verification is missing. |
| M4.5 | Privacy regression | Code complete | Browser tests instrument application network APIs. This is not an independent packet-capture audit. |
| M4.6 | Compatibility | Blocked | Target matrix and evidence validator exist; per-platform real-device JSON records are missing. |
| M4.7 | Performance / soak | Blocked | Validator requires >=30-minute real-device evidence; no result is committed. |
| M4.8 | Failure injection | Code complete | Deterministic storage/download/runtime failure tests pass; repeat critical paths on qualified hardware. |
| M4.9 | Accessibility | Partial | Automated semantics are covered; VoiceOver/NVDA, zoom, forced-colors and full contrast records are missing. |
| M4.10 | Rollout | Code complete | Disabled/internal/canary/all cohorts, server-asserted internal membership and no-silent-cloud behavior are tested. |
| M4.11 | Diagnostics | Code complete | Sanitized export tests exist; operational review remains advisable. |
| M4.12 | Runbooks | Draft complete | Runbooks exist but have not been exercised in a production drill. |
| M4.13 | Final review | Blocked | Depends on M4.4, M4.6, M4.7 and M4.9 evidence and explicit owner approval. |

## Section 13.3 gates

| Gate | Target | Repository evidence | Disposition |
|---|---:|---|:---:|
| No cloud request while Local is active | 0 bytes | App-level fetch/network regression tests | Code test passed; independent audit pending |
| First-word latency p95 | <= 2.0 s | None from a real production tuple | Blocked |
| Complete-result latency p95 | <= 5.0 s | None from a real production tuple | Blocked |
| Main-thread jitter | 0 inference tasks > 200 ms | Worker architecture and synthetic tests only | Blocked |
| Persistence | 0 re-downloads across 5 reloads | No M4 real-device result | Blocked |
| Memory growth | < 10% over 30 minutes | No M4 real-device result | Blocked |
| Parse rate | >= 95% | Deterministic parser corpus only | Hardware/model evidence pending |

## Verified in this review

- TypeScript compilation succeeds.
- Relevant on-device/settings lint succeeds.
- Browser suite: 259 specs, 0 failures.
- Backend suite: 90 tests passed (including 5 feature-endpoint tests).
- Compatibility and soak validators fail closed with `BLOCKED` when evidence is absent.

The repository-wide JS lint still reports formatting/unused-variable findings in pre-existing files outside the reviewed commit range. That does not invalidate the targeted on-device checks, but it must be cleared before claiming a clean global pipeline.

## Required evidence to unblock release

1. Run `npm run verify:gcs` against the deployed private bucket and retain the output/deployment identity.
2. Add schema-v1 `evidenceType: "real-device"` compatibility records for every matrix platform and run `npm run verify:m4-compatibility`.
3. Record a >=30-minute, >=5-reload production-model soak result and run `npm run test:m4-soak -- <result.json>`.
4. Attach manual accessibility results for VoiceOver, NVDA, keyboard-only, 200% zoom, contrast and forced colors.
5. Repeat deployed-origin security/privacy inspection and obtain named release-owner approval.
