# Runbook: Cache Invalidation & TTL Policies

**Objective:** Maintain high CDN cache hit ratios while allowing rapid cache purging during deployments.

## 1. Cache-Control Header Specifications
- `/api/on-device-models/default`: `Cache-Control: public, max-age=300` (5 minutes).
- `/api/features`: `Cache-Control: public, max-age=60` (1 minute).
- Signed download URLs: TTL 3600 seconds (1 hour).
- Static assets (`/dist/*`): Content-hashed immutable assets `max-age=31536000, immutable`.

## 2. Invalidation Procedures
```bash
# Invalidate default catalog endpoint
gcloud compute url-maps invalidate-cdn-cache project-voice-lb --path="/api/on-device-models/default"

# Invalidate feature flags
gcloud compute url-maps invalidate-cdn-cache project-voice-lb --path="/api/features"
```
