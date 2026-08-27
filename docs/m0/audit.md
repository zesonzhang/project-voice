# Milestone 0 Completion Audit

**Audit date:** 2026-08-27
**Overall status:** COMPLETE — the macOS development reference device passes
every M0 gate. Windows and Linux validation is deferred to post-development
compatibility work.

| Requirement | Status | Evidence |
|---|---|---|
| M0.1 Freeze candidate artifact | Complete | `artifact.json` records the immutable repository commit, filename, byte size, full SHA-256, source, Apache-2.0 license, and feasibility-only distribution decision. The complete 2,008,432,640-byte artifact was independently hashed and matched. |
| M0.2 Pin and locally bundle runtime | Complete | `@litert-lm/core` is exact-pinned at 0.15.0. `tools/build-m0.mjs` bundles Worker/runtime code, copies Wasm assets locally, and rejects non-approved CDN references. |
| M0.3 Run in dedicated Worker | Complete | Stable Chrome 151 on the macOS development reference device ran the real 2.0 GB candidate through the dedicated Worker with zero runtime errors and zero main-thread long tasks. |
| M0.4 OPFS persistence | Complete | The macOS export records 11 OPFS loads, including Engine recreation, five completed page reload/load cycles, and one Chrome restart/load cycle. Every record reports zero model-byte network requests. |
| M0.5 Cancellation and cleanup | Complete | Real prefill and decode cancellation were acknowledged in 172.82 ms and 39.34 ms respectively, with zero stale renders; repeated loads also exercised Engine deletion/recreation. |
| M0.6 Repeatable benchmark harness | Complete | The sanitized export captures cold/warm load, first token, first parsed suggestion, total latency, prefill/decode rates, page-memory estimate, OPFS usage/quota, long tasks, stable errors, and coarse environment metadata without prompt/output content. |
| M0.7 Establish development reference device | Complete | The macOS 26.6.1 / Apple M1 Pro / 16 GiB / Chrome 151 reference result passes. Windows and Linux are explicitly deferred to post-development compatibility validation. |
| M0.8 Representative behavior | Complete | The real candidate returned five parsed suggestions for every warm English/Japanese/Mandarin word/sentence case on macOS. All warm cases met the first-parsed and total-latency targets. |
| M0.9 Compatibility and decision | Complete | `compatibility.json` records the frozen tuple and macOS development envelope; `decision.md` records the M0 GO decision. Wider platform certification remains a later release gate. |

The executable gate is `npm run verify:m0`. It validates the frozen tuple,
privacy-safe schema, macOS reference-device coverage, OPFS load evidence, all
six prompt cases, both cancellation phases, responsiveness, latency targets,
and absence of runtime errors. Windows and Linux results are accepted when
available but are not M0 blockers.

## Follow-up compatibility work

Run the same sequence on Windows and Linux reference devices during the
post-development compatibility phase, then add their sanitized exports to
`docs/m0/results/` and update `compatibility.json`.
