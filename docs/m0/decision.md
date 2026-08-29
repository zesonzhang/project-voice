# M0 Go/No-Go Record

**Date:** 2026-08-27
**Decision:** GO for subsequent development on the certified macOS tuple

The engineering harness is implemented, the runtime/model tuple is frozen, and
the macOS development reference device meets the M0 gates. Subsequent
development may proceed on this certified tuple. This is not a general-release
certification; Windows and Linux compatibility remains post-development work.

## Completed

- M0.1: candidate name, immutable version, size, SHA-256, public license, source,
  and feasibility-only distribution scope are recorded; the downloaded
  2,008,432,640-byte artifact passed a full SHA-256 check.
- M0.2: LiteRT-LM 0.15.0 is exact-pinned. Runtime code is bundled and Wasm is
  copied to a same-origin path with no runtime CDN dependency.
- Engineering portions of M0.3–M0.6 and M0.8: the dedicated Worker supports
  OPFS loading, isolated conversations, streaming, cancellation, sequence-based
  stale-output suppression, conversation/engine deletion, structured errors,
  representative multilingual cases, and sanitized metrics export.
- The local route, isolation headers, Wasm MIME type, TypeScript compile, Python
  tests, and Jasmine browser tests pass.
- The macOS 26.6.1 / Apple M1 Pro / 16 GiB / Chrome 151 reference run passes all
  per-device gates: 11 OPFS loads with zero model-byte requests (including five
  page reloads and one Chrome restart), all six warm language/kind cases,
  prefill and decode cancellation, zero runtime errors, and zero main-thread
  long tasks.

## Deferred compatibility validation

- Run current stable Chrome results on Windows and Linux reference devices,
  including latency, memory, stability, and main-thread responsiveness.
- Publish the broader supported-device envelope and compare the collected
  results with the Section 13.3 release targets before general availability.

`npm run verify:m0` is the executable M0 evidence gate. It requires a passing
macOS export; Windows and Linux exports are validated when they are added but
do not block this development milestone.

If the macOS development tuple or a later release-platform candidate fails
memory, stability, or latency gates, do not ship that combination; use a
smaller/correctly packaged Web artifact or explicitly revise the design. The
Local-only privacy guarantee must not be relaxed.
