# M4.8 Download and Lifecycle Failure-Injection Validation

This document records the empirical results of download and lifecycle failure-injection validation for Project VOICE On-device LLM inference.

## 1. Failure Scenarios & Validation Matrix

| Injected Failure Mode | Injection Vector | Expected System Behavior | Verified Result |
|---|---|---|:---:|
| **Network Disconnection Mid-Download** | `ReadableStream` error thrown after 512 bytes | Download halted with `ERR_DOWNLOAD_FAILED`; partial file (512 bytes) and offset preserved; subsequent download resumes from Range `bytes=512-` with 0 duplicate bytes. | **PASSED** |
| **Quota Exhaustion during Update** | `quotaEstimator` reports insufficient storage (< 2.5 GB) | Candidate download blocked with `ERR_INSUFFICIENT_STORAGE`; active verified model v1 remains intact in OPFS and metadata store. | **PASSED** |
| **Corrupted Candidate Checksum** | Injected altered payload bytes | Streaming SHA-256 validation rejects artifact with `ERR_CHECKSUM_MISMATCH`; candidate `.partial` deleted; active last-known-good (LKG) model preserved. | **PASSED** |
| **Signed URL Expiration** | Remote endpoint returns HTTP 403 Forbidden | Automatically requests refreshed signed URL with generation match; resumes download transparently. | **PASSED** |
| **Server Range Ignore (HTTP 200)** | Server responds with 200 instead of 206 Partial Content | Detects missing `Content-Range`; resets partial file to byte 0 to prevent corruption; downloads full artifact. | **PASSED** |
| **Range Not Satisfiable (HTTP 416)** | Server responds with 416 | Resets partial file and offset to 0; restarts download from byte 0. | **PASSED** |
| **IndexedDB / OPFS Desynchronization** | Metadata indicates active verified model, but file missing in OPFS | Reconciles during `initialize()`; falls back to `not_downloaded` without application crash. | **PASSED** |
| **WebGPU Device Loss Mid-Generation** | WebGPU runtime throws device lost / context removed error | Runtime disposes failed engine; cancels pending promise; alerts user cleanly with 0 silent fallback to Cloud Gemini. | **PASSED** |

## 2. Recovery & Data Integrity Guarantees

1. **Atomic Promotion:** Model files are downloaded as `<version>.partial` and promoted to `<version>.litertlm` only after SHA-256 digest matches manifest exactly.
2. **LKG Retention:** The active verified version is never deleted until a candidate has passed download, checksum verification, smoke test, and first successful suggestion.
3. **Zero Accidental Deletion:** In no failure scenario does a failed download or update remove the active last-known-good model.
