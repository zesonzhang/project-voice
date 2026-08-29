# Desktop Chrome Compatibility Matrix (M4.6)

This document records the intended desktop Chrome compatibility matrix for Project VOICE On-device LLM inference (`@litert-lm/core@0.15.0` + `gemma-4-e2b-it-web.litertlm`). Schema and static checks are not substitutes for recorded real-device runs.

**Status: target matrix only. No M4 real-device records are present, so none of these rows is certified.**

## 1. Intended Platform Matrix

| Platform ID | OS / Architecture | Target Hardware / GPU | Minimum RAM | Recommended RAM | Backend | Chrome Version | Intended Tier |
|---|---|---|---|---|---|---|:---:|
| `macos-arm64-apple-silicon` | macOS Sonoma / Sequoia (arm64) | Apple Silicon (M1, M2, M3, M4) | 8 GiB | 16 GiB | Metal via WebGPU | >= 125.0 | **Tier 1 (Reference)** |
| `macos-x64-intel-metal` | macOS Sonoma (x64) | Intel Core i7/i9 + Discrete AMD Radeon Pro 5500M+ | 16 GiB | 16 GiB | Metal via WebGPU | >= 125.0 | **Tier 2 (Supported)** |
| `windows-x64-nvidia-d3d12` | Windows 11 23H2+ (x64) | NVIDIA GeForce RTX 3060 / 4060 / 4070+ (Driver >= 550) | 8 GiB | 16 GiB | Direct3D 12 via WebGPU | >= 125.0 | **Tier 1 (Reference)** |
| `windows-x64-intel-d3d12` | Windows 11 23H2+ (x64) | Intel Iris Xe / Intel Arc A-Series (Driver >= 31.0) | 16 GiB | 16 GiB | Direct3D 12 via WebGPU | >= 125.0 | **Tier 2 (Supported)** |
| `windows-x64-amd-d3d12` | Windows 11 23H2+ (x64) | AMD Radeon RX 6600 / 6700 / 7800 (Adrenalin >= 24.3) | 8 GiB | 16 GiB | Direct3D 12 via WebGPU | >= 125.0 | **Tier 1 (Reference)** |
| `linux-x64-vulkan-mesa` | Ubuntu 22.04/24.04, Debian 12, gLinux (x64) | AMD RADV / Intel ANV / NVIDIA Proprietary (Mesa >= 23.2 / Driver >= 550) | 8 GiB | 16 GiB | Vulkan via WebGPU | >= 125.0 | **Tier 2 (Supported)** |

The tier column expresses the desired qualification level. A row becomes certified only after a matching real-device evidence file passes `npm run verify:m4-compatibility`.

---

## 2. Hardware Preflight Requirements

Before initiating model download or loading, `ModelManager.checkCapabilities()` enforces:

1. **Secure Context:** HTTPS or `localhost` (`window.isSecureContext === true`).
2. **WebGPU Hardware Accelerator:** `navigator.gpu` available; `navigator.gpu.requestAdapter()` returns a non-null, non-fallback adapter.
3. **Dedicated Web Worker:** `typeof Worker !== 'undefined'`.
4. **Origin Private File System (OPFS):** `navigator.storage.getDirectory()` available for direct file streaming.
5. **Storage Quota:** At least `model.sizeBytes * 1.2` (~2.5 GiB) free storage space reported by `navigator.storage.estimate()`.
6. **Cross-Origin Isolation:** COOP `same-origin` and COEP `require-corp` active (`window.crossOriginIsolated === true`).

---

## 3. Unsupported Environments & Stable Error Mapping

When an environment does not satisfy minimum requirements, Project VOICE reports a stable, localized error code without crashing and without falling back to Cloud Gemini:

| Condition | Detected Indicator | Stable Error Code | User-Facing Action |
|---|---|---|---|
| No WebGPU support | `navigator.gpu == null` or adapter request rejected | `ERR_WEBGPU_UNSUPPORTED` | Prompt to update Chrome or enable hardware acceleration in browser settings. |
| Software Rasterizer fallback | `adapter.isFallbackAdapter === true` | `ERR_WEBGPU_UNSUPPORTED` | Disable software CPU rasterization; prompt for discrete or integrated hardware GPU. |
| Insufficient Storage | `quotaAvailable < 2.5 GB` | `ERR_INSUFFICIENT_STORAGE` | Show required vs. available MB; prompt user to clear disk space. |
| Unsupported Runtime Adapter | `manifest.adapterId !== 'litert-lm'` | `ERR_ADAPTER_UNSUPPORTED` | Manifest rejected; prevent loading uncertified runtime code. |
| WebGPU Device Loss / Crash | `device.lost` event emitted | `ERR_LOAD_FAILED` | Dispose failed engine; display "WebGPU context lost" with explicit Reload button. |
| Denied Persistent Storage | `navigator.storage.persist() === false` | Warning only (`ERR_PERSISTENCE_DENIED`) | Warn that browser may evict weights under extreme storage pressure, but allow inference to proceed. |

---

## 4. Verification Evidence

No M4 compatibility evidence is committed. Place one schema-v1, `evidenceType: "real-device"` JSON record per platform under `docs/m4/results/`, with the exact frozen runtime/model tuple and install, reload, update, recovery, and latency results. The verifier intentionally reports `BLOCKED` until every target row is covered.
