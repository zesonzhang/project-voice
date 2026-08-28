# Runbook: On-Device Model Catalog Promotion

**Objective:** Safely release a new candidate model bundle to Project VOICE users.

## 1. Prerequisites
- Validated candidate `.litertlm` artifact built and frozen.
- Complete SHA-256 hash computed over candidate bytes.
- Benchmark passed on Tier 1 reference platforms (macOS Apple Silicon, Windows D3D12, Linux Vulkan).
- Model size conforms to quota guidelines (<= 2.1 GB).

## 2. Procedure
1. **Upload to Google Cloud Storage:**
   ```bash
   gsutil cp gemma-4-e2b-it-web.litertlm gs://project-voice-models/gemma-4-e2b-it-web/2026-09-01.litertlm
   # Record generation ID
   gsutil stat gs://project-voice-models/gemma-4-e2b-it-web/2026-09-01.litertlm | grep Generation
   ```
2. **Update Model Catalog Configuration:**
   In `model_catalog.py` (or catalog JSON):
   - Update `version`: `"2026-09-01"`
   - Update `sha256`: candidate SHA-256
   - Update `size_bytes`: candidate exact size
   - Update `gcs_generation`: exact GCS generation string
3. **Verify Catalog Policy:**
   ```bash
   npm run verify:gcs:policy
   uv run pytest tests/test_model_catalog.py
   ```
4. **Deploy Backend:**
   - Deploy backend update.
   - Cache TTL for `/api/on-device-models/default` is 300s; clients will discover the new version within 5 minutes or on manual "Check for Updates".
