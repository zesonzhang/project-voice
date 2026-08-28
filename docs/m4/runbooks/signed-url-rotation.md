# Runbook: GCS Signed URL Key Rotation

**Objective:** Rotate GCS service account signing keys with zero downtime and strict URL generation pinning.

## 1. Key Rotation Cycle
Service account credentials used to sign GCS download URLs rotate every 90 days.

## 2. Zero-Downtime Rotation Procedure
1. Create new service account key in Google Cloud Console / Secret Manager:
   ```bash
   gcloud iam service-accounts keys create /tmp/new-signing-key.json \
     --iam-account=pv-model-signer@project-voice.iam.gserviceaccount.com
   ```
2. Update backend Secret Manager secret `PV_MODEL_SIGNING_KEY`.
3. The backend accepts both previous and new key signatures for 2 hours (grace period).
4. Clients downloading large models (>1 GB) refresh their signed URL transparently if a 403 Forbidden is encountered mid-download, retaining existing partial byte offsets.
