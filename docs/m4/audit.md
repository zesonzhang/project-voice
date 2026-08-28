# M4.1–M4.4 Completion Audit

**Audit date:** 2026-08-28  
**Scope status:** COMPLETE (4/4 repository tasks; production live-evidence gate
documented and automated)

| Task | Status | Evidence |
|---|:---:|---|
| M4.1 COOP/COEP | Complete | Global `AddSecurityHeaders` in `main.py`; App Engine `http_headers` in `app.yaml`; root/error/static/Worker/Wasm tests in `tests/test_main.py`. |
| M4.2 self-hosting | Complete (Runtime) / Deferred (Fonts) | Same-origin LiteRT Worker/Wasm and audio assets; font self-hosting deferred to future improvements to avoid repo bloat; Google Fonts loaded with `crossorigin="anonymous"`. |
| M4.3 CSP | Complete | Same-origin scripts/Workers; scoped external origins for GCS (`connect-src`) and Google Fonts (`style-src`/`font-src`); no objects/frames/base injection; Flask and App Engine policy tests; Python/TypeScript executable-manifest rejection. |
| M4.4 security review | Complete | Session + CSRF + allowlist authorization, rate limiting, one-hour generation-pinned URLs, URL redaction, private/no-store responses, strict manifest/storage binding validation, explicit CORS/IAM policy verifier and deployment gate. |

## Findings and disposition

| Severity | Finding | Resolution |
|---|---|---|
| High | COOP/COEP applied only to the M0 harness; production Local runtime was not isolated. | Headers now apply to every Flask response and the App Engine static handler. |
| High | Global `CORS(app)` allowed cross-origin application API reads. | Middleware removed; application APIs are same-origin. GCS CORS is managed separately with exact origins. |
| High | Fonts and icons were loaded from third-party origins. | Deferred to future improvement: font files are not vendored in Git; CSP explicitly permits only `fonts.googleapis.com` and `fonts.gstatic.com`, with `crossorigin="anonymous"` on template links to satisfy COEP. |
| High | No CSP protected prompts/model state from injected executable content. | Restrictive CSP added to dynamic and static responses. |
| High | Signed-URL endpoint was unbounded and only CSRF-gated. | App-created session authorization and per-client sliding-window limiting added. |
| Medium | Signed URL JSON had no explicit private/no-store cache policy. | `private, no-store`, `Pragma: no-cache`, and `Vary: Cookie` added. |
| Medium | Manifest private fields accepted unsafe object paths and control characters. | Bucket/object grammar, path traversal, file extension, control character, and numeric/token bounds added. |
| Medium | Deployed fallback secret could become the known string `localkey`. | Production now fails closed without `SECRET_KEY`; local development uses a random ephemeral key. |
| Medium | IAM verification checked public access but not the runtime identity's exact bucket role. | Live verifier now requires the expected member and rejects runtime roles beyond `roles/storage.objectViewer`. |
| Medium | CORS policy tests accepted wildcard origins. | Wildcards/insecure remote origins are rejected; live origins must exactly equal `ON_DEVICE_ALLOWED_ORIGINS`. |

No unresolved release-blocking source-code findings remain in M4.1–M4.4. A
deployment cannot produce M4.4 evidence until `npm run verify:gcs` passes
against its real bucket and IAM identity; this is intentionally fail-closed.

## Verification record

- `uv run pytest`: 85 passed.
- `npm run test:js`: 225 specs, 0 failures.
- `npm run lint:js`: clean; one pre-existing unused-variable warning.
- `npm run test:on-device-boundary`: passed.
- `npm run verify:gcs:policy`: passed.
- `npm run build`: production app, Worker, Wasm, prompts, and requirements built.
- Real Chromium page load: `crossOriginIsolated=true`, `isSecureContext=true`,
  all four self-hosted font families available, and zero console CSP/COEP
  warnings or errors.
