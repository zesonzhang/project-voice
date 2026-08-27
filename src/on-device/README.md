# On-device inference production boundary

Production model lifecycle, storage, Worker protocol, and runtime adapter code
belongs in this directory. Code here must use validated model manifests and
provider-neutral application contracts; it must not import the M0 feasibility
harness.

The repeatable M0 benchmark remains under `tools/m0-harness/`. It may exercise
the same pinned LiteRT-LM release, but it is a development tool rather than a
production runtime implementation.

`npm run test:on-device-boundary` guards this separation in CI.
