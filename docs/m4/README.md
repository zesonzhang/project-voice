# Milestone 4.1–4.4: Hosting and Security Hardening

This increment completes the repository work for M4.1 through M4.4. It makes
the production application cross-origin isolated, removes runtime CDN
dependencies, enforces a restrictive Content Security Policy, and closes the
release-blocking backend findings found during the signed-model distribution
review.

## Delivered controls

### M4.1 — COOP/COEP on every response

- Flask applies `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` to rendered pages, APIs, errors,
  and development static responses.
- The App Engine `/static` handler declares the same headers because static
  files are served before requests reach Flask.
- Same-origin static resources also receive
  `Cross-Origin-Resource-Policy: same-origin`.
- Tests cover the root page, 404 responses, static assets, M0 Worker assets,
  and Wasm.

COOP severs cross-origin opener relationships and COEP blocks embedded
cross-origin resources unless they opt into CORS/CORP. Integrations that open
Project VOICE in a cross-origin window must use `postMessage` through a
separately reviewed architecture; remote fonts, scripts, frames, and images
cannot be added casually.

### M4.2 — Self-hosted runtime assets (Font self-hosting deferred)

- LiteRT-LM is bundled into the inference Worker and all Wasm files are copied
  to `/static/vendor/litert-lm/wasm/` by `tools/build-worker.mjs`.
- Worker, TinySegmenter, click, and chime assets are all same-origin.
- Self-hosting Google Fonts and Material Symbols has been deferred to future
  improvements to avoid vendoring large binary font files in the repository.
  The template loads Roboto, Roboto Mono, Noto Sans JP, and Material Symbols
  from Google Fonts CDN using `crossorigin="anonymous"` to comply with
  `Cross-Origin-Embedder-Policy: require-corp`.

### M4.3 — Content Security Policy

The same policy is emitted by Flask and the App Engine static handler:

```text
default-src 'self'; base-uri 'none';
connect-src 'self' https://storage.googleapis.com;
font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; img-src 'self' data:;
media-src 'self' blob:; object-src 'none'; script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; worker-src 'self'; form-action 'self'
```

`style-src 'unsafe-inline'` is intentionally retained because Lit and Material
Web components install static component styles into shadow roots. `https://fonts.googleapis.com`
and `https://fonts.gstatic.com` are scoped explicitly for font and icon stylesheets/files while
self-hosting remains deferred. Executable
content and Workers remain restricted to same-origin resources. GCS is the
only external connection origin and is needed for generation-pinned model
downloads. Cloud suggestions and audio stay on the application origin.

### M4.4 — Backend and signed-URL review

- Flask's former global permissive CORS middleware was removed; application
  APIs are same-origin.
- URL signing requires an app-created session, SeaSurf CSRF validation, an
  allowlisted model ID/version, and a per-client sliding-window rate limit.
- Signed responses are `private, no-store`, URLs stay in memory, and audit logs
  record request/model/version/generation/expiry metadata while redacting the
  URL and signature.
- V4 URLs pin the exact immutable GCS generation and expire after one hour.
- Manifest validation rejects unknown/executable fields, unsafe bucket/object
  bindings, path traversal, control characters, excessive sizes/token counts,
  invalid hashes, and unsupported runtime adapters in Python and TypeScript.
- Production refuses to start without `SECRET_KEY`; session cookies are
  HttpOnly, SameSite=Lax, and Secure on App Engine.
- `tools/verify_gcs_distribution.py --live` now requires the expected runtime
  IAM member and exact allowed origins, verifies UBLA/no-public-access,
  enforces `roles/storage.objectViewer` as the runtime bucket role, exercises
  URL signing, and checks live full/Range/invalid Range download contracts.

Google documents that a signed-URL identity needs permission for the operation
represented by the URL and `iam.serviceAccounts.signBlob`; it also notes that
anyone holding the URL can use it until expiry. See the official
[signed URL overview](https://docs.cloud.google.com/storage/docs/access-control/signed-urls)
and [V4 helper setup](https://docs.cloud.google.com/storage/docs/access-control/signing-urls-with-helpers).

## Deployment gate

Prepare an explicit-origin CORS file from `gcs-cors.example.json`, then run:

```bash
gcloud storage buckets update gs://BUCKET_NAME \
  --uniform-bucket-level-access \
  --cors-file=docs/m4/gcs-cors.example.json

export MODEL_SIGNER_IAM_MEMBER='serviceAccount:SERVICE_ACCOUNT_EMAIL'
export ON_DEVICE_ALLOWED_ORIGINS='https://PRODUCTION_ORIGIN,https://STAGING_ORIGIN'
export ON_DEVICE_MODEL_CONFIG_PATH='/secure/path/model-catalog.json'
npm run verify:gcs
```

Grant the runtime identity `roles/storage.objectViewer` on only the model
bucket. Grant `roles/iam.serviceAccountTokenCreator` on the signing service
account so the runtime can call `signBlob`; do not grant Storage Admin to the
runtime. The live verifier's successful signed GET proves both the signing and
object-read permissions. Cloud Storage's official
[CORS documentation](https://docs.cloud.google.com/storage/docs/cross-origin)
describes exact origin/method matching.

The repository audit is complete. The live command is a mandatory deployment
evidence gate because production IAM, bucket metadata, and origins are not
available in the source checkout.

## Verification

```bash
uv run pytest
npm run lint
npm run test
npm run build
npm run verify:gcs:policy
```

