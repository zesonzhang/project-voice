# User Troubleshooting Guide: On-Device LLM Suggestions

## 1. "WebGPU Not Supported"
- **Symptom:** On-device toggle is disabled or shows `ERR_WEBGPU_UNSUPPORTED`.
- **Solution:**
  1. Ensure you are using desktop Google Chrome version 125 or newer.
  2. In Chrome, open `chrome://settings/system` and ensure **"Use graphics acceleration when available"** is ON.
  3. Navigate to `chrome://gpu` and check that WebGPU shows "Hardware accelerated".

## 2. "Insufficient Storage"
- **Symptom:** Download fails with `ERR_INSUFFICIENT_STORAGE`.
- **Solution:** Project VOICE requires approximately 2.5 GB of free disk space to store and unpack model weights safely. Clear unused files on your computer and retry.

## 3. "Download Stalled or Interrupted"
- **Symptom:** Download progress stops moving.
- **Solution:** Click **"Cancel Download"**, refresh the page, and click **"Resume Download"**. Project VOICE resumes from the exact byte where it paused without re-downloading earlier chunks.

## 4. "Model Context Lost / Device Lost"
- **Symptom:** Error banner shows "WebGPU device lost".
- **Solution:** This happens when your computer's graphics driver reboots or runs low on VRAM. Click **"Load Model"** or refresh the tab to re-initialize the accelerator.

## 5. How to Export Diagnostics for Support
1. Click the **Gear (Settings)** icon in Project VOICE.
2. Select **Resource & Diagnostics**.
3. Click **"Export Diagnostics (JSON)"**.
4. Attach the downloaded JSON file to your support request.
