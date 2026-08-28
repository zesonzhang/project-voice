# Runbook: Support Escalation & Diagnostics Triage

**Objective:** Standard operating procedure for triaging on-device LLM issues reported by users.

## 1. Escalation Hierarchy
- **Tier 1 (Helpdesk / User Support):** Direct user to export privacy-safe diagnostics snapshot from Settings -> Resource & Diagnostics -> Export Diagnostics.
- **Tier 2 (Platform & Operations):** Review `systemInfo` and `lastError` in the diagnostics JSON:
  - If `ERR_WEBGPU_UNSUPPORTED`: Check browser version and flags.
  - If `ERR_INSUFFICIENT_STORAGE`: Advise user on freeing disk space.
  - If `ERR_DOWNLOAD_FAILED`: Check network connectivity and GCS status.
- **Tier 3 (Core Engineering On-Call):** Triage device loss, WebGPU crashes, or runtime driver panics.

## 2. Privacy Handling
- The diagnostics JSON contains zero user text, zero prompts, zero personas, and zero conversation logs.
- Safe to transmit over internal ticketing and bug tracking systems.
