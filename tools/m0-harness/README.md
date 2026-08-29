# M0 feasibility harness source

This directory contains the frozen engineering harness used to collect and
verify the M0 LiteRT-LM feasibility evidence. It is intentionally outside
`src/` because it is not part of the production application architecture.

Use `npm run dev:m0` to build and enable the harness locally. The normal
development server, production build, and Google Cloud deployment exclude it.
Production on-device implementation belongs under `src/on-device/`.
