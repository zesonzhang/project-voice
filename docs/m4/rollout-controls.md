# M4.10 Feature-Flag and Rollout Controls

This document specifies the feature flag architecture, cohort gating, and release controls for Project VOICE On-device LLM inference.

## 1. Feature Flag Definitions & Defaults

| Flag Identifier | Environment Variable | Default Value | Allowed Values | Purpose |
|---|---|---|---|---|
| `onDeviceMode` | `FEATURE_ON_DEVICE_MODE` | `all` (dev) / `disabled` (prod initial) | `disabled`, `internal`, `canary`, `all` | Gates availability of on-device LLM inference across cohorts. |
| `debugModelImport` | `FEATURE_DEBUG_MODEL_IMPORT` | `0` (`false`) | `0`, `1` | Enables manual file picker import of local candidate `.litertlm` bundles. |
| `rolloutPercentage` | `ON_DEVICE_ROLLOUT_PERCENTAGE` | `100` | `0` - `100` | Controls deterministic percentage rollout bucket for general audience (`all` mode). |

## 2. API Endpoint: `GET /api/features`

Returns public, non-sensitive feature configuration cached for 60 seconds:
```json
{
  "onDeviceMode": "all",
  "debugModelImport": false,
  "rolloutPercentage": 100
}
```

## 3. Cohort Hashing & Determinism

- **Client Hashing:** `hashClientIdToBucket(clientId)` maps any stable client identifier deterministically to an integer in `[0, 99]`.
- **Cohort Matching:**
  - `disabled`: All new activations return `false`.
  - `internal`: Restricted strictly to verified internal dogfooders (`isInternalUser === true`).
  - `canary`: Restricted to clients where `bucket < min(rolloutPercentage, 10)`.
  - `all`: Clients with `bucket < rolloutPercentage`.

## 4. STRICT PRIVACY INVARIANT: Zero Silent Fallback on Rollout Pause or Kill-Switch

When an operator pauses or disables on-device rollout (`onDeviceMode = 'disabled'` or lower percentage):

1. **New Users (Default Cloud):**
   - Retain `cloud` mode.
   - The "On-device" option in the inference mode dropdown is disabled with an explanatory tooltip ("Temporarily paused for your cohort").
2. **Existing Installed Local Users:**
   - **THE SYSTEM MUST NEVER SILENTLY REROUTE LOCAL USERS TO CLOUD GEMINI (`/run-macro`)!**
   - If model weights are already installed and verified in local OPFS, local offline inference continues unhindered (`resolveSafeInferenceMode()` returns `effectiveMode: 'local'`).
   - If an emergency stop is required, the UI presents an explicit dialog and requires user action to switch back to Cloud; zero prompts or keystrokes are sent to the network without consent.
