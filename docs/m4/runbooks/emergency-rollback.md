# Runbook: Emergency Model Rollback

**Objective:** Instantly revert to a known-good model version if a newly released version exhibits regressions, instability, or crashes.

## 1. Fast Rollback via Backend Catalog
1. Revert the catalog configuration in `model_catalog.py` to the previous version and generation.
2. Deploy backend service.
3. Invalidate CDN cache:
   ```bash
   gcloud compute url-maps invalidate-cdn-cache project-voice-lb --path="/api/on-device-models/*"
   ```

## 2. Emergency Kill-Switch for Rollout
If model download issues or crashes are widespread:
1. Set `FEATURE_ON_DEVICE_MODE=disabled` in production environment.
2. Existing local users continue safely using their installed LKG weights without cloud leaks.
3. New users remain in default Cloud mode.

## 3. Client-Side Last-Known-Good (LKG) Activation
1. If a client update fails during smoke test or activation:
   - `ModelManager.rollback()` automatically triggers.
   - Restores previous verified version from OPFS and IndexedDB.
   - Removes corrupted or failed candidate partial file.
