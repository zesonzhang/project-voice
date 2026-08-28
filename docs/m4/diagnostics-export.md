# M4.11 Privacy-Safe Local Diagnostics Export

This document details the architecture, sanitization rules, and report format for the privacy-safe diagnostics export mechanism in Project VOICE On-device LLM inference.

## 1. Overview & Objectives

When a user encounters hardware incompatibilities, WebGPU context crashes, or download stalls, support engineers need visibility into device capabilities, lifecycle state transitions, and error codes without compromising user privacy.

The diagnostics exporter (`src/on-device/diagnostics-exporter.ts`) generates a self-contained, sanitized JSON snapshot.

## 2. Strict Privacy Invariants

The export snapshot enforces mathematical zero-knowledge regarding user communication:

1. **Zero User Keystrokes or Text:** The text field content, partial words, and suggestion history are completely excluded.
2. **Zero Persona or Profile Info:** User persona, medical background, or communication profile are excluded.
3. **Zero Conversation Logs:** Conversation history turns are excluded.
4. **Zero Credentials / Signed URLs:** GCS signed URLs, HMAC signatures (`sig=...`, `X-Goog-Signature=...`), and Bearer authorization tokens are scrubbed using regular expression sanitization before inclusion.

## 3. Diagnostics Report Schema

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-08-28T09:30:00.000Z",
  "systemInfo": {
    "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...",
    "isSecureContext": true,
    "crossOriginIsolated": true,
    "webgpuSupported": true,
    "opfsSupported": true,
    "workerSupported": true,
    "persistenceGranted": true
  },
  "lifecycle": {
    "currentState": "ready",
    "activeModelId": "gemma-4-e2b-it-web",
    "activeVersion": "2026-08-01",
    "activeModelSizeBytes": 2008432640,
    "transitionHistory": [
      {"timestamp": 1724837400000, "from": "not_downloaded", "to": "downloading"},
      {"timestamp": 1724837450000, "from": "downloading", "to": "loading"},
      {"timestamp": 1724837452000, "from": "loading", "to": "ready"}
    ]
  },
  "storage": {
    "quotaTotalBytes": 100000000000,
    "quotaAvailableBytes": 45000000000,
    "installedVersions": [
      {
        "modelId": "gemma-4-e2b-it-web",
        "version": "2026-08-01",
        "sizeBytes": 2008432640,
        "verificationState": "verified",
        "createdAt": 1724837450000
      }
    ]
  },
  "lastError": {
    "code": null,
    "sanitizedMessage": null
  },
  "privacyVerification": {
    "userTextIncluded": false,
    "personaIncluded": false,
    "conversationHistoryIncluded": false,
    "signedUrlsIncluded": false
  }
}
```

## 4. UI Access

Users can export this report at any time by opening Settings -> Resource & Diagnostics -> Clicking **"Export Diagnostics (JSON)"**. The file is generated entirely on the client side via a local Blob and triggered as a direct file download.
