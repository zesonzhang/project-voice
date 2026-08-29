/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {ModelErrorCode} from './model-lifecycle.js';

export interface PreflightCheckResult {
  supported: boolean;
  webgpuSupported: boolean;
  fallbackAdapter: boolean;
  opfsSupported: boolean;
  workerSupported: boolean;
  httpsOrLocal: boolean;
  crossOriginIsolated: boolean;
  persistenceGranted: boolean;
  deviceMemoryGB: number | null;
  memoryWarning?: string;
  quotaAvailableBytes: number;
  quotaTotalBytes: number;
  errorCode?: ModelErrorCode;
  errorMessage?: string;
}

export interface CapabilitiesCheckers {
  webgpuChecker?: () => Promise<boolean>;
  crossOriginIsolatedChecker?: () => boolean;
  deviceMemoryChecker?: () => number | undefined;
  quotaEstimator?: () => Promise<{quota?: number; usage?: number}>;
  adapterChecker?: (adapterId: string) => boolean | Promise<boolean>;
}

/**
 * Preflight check for WebGPU, OPFS, Worker, storage quota, and persistent storage.
 */
export async function checkCapabilities(
  requiredSizeBytes?: number,
  adapterId = 'litert-lm',
  checkers: CapabilitiesCheckers = {},
  requirements: {
    minimumDeviceMemoryGB?: number;
    minimumFreeStorageBytes?: number;
  } = {},
): Promise<PreflightCheckResult> {
  const isHttpsOrLocal =
    typeof window !== 'undefined'
      ? window.isSecureContext ||
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1'
      : true;

  const opfsSupported =
    typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

  const workerSupported = typeof Worker !== 'undefined';
  const crossOriginIsolated = checkers.crossOriginIsolatedChecker
    ? checkers.crossOriginIsolatedChecker()
    : checkers.webgpuChecker
      ? true
      : typeof window === 'undefined' || window.crossOriginIsolated === true;

  const deviceMemoryGB = checkers.deviceMemoryChecker
    ? (checkers.deviceMemoryChecker() ?? null)
    : typeof navigator === 'undefined'
      ? null
      : ((navigator as Navigator & {deviceMemory?: number}).deviceMemory ??
        null);
  const memoryWarning =
    deviceMemoryGB !== null &&
    requirements.minimumDeviceMemoryGB !== undefined &&
    deviceMemoryGB < requirements.minimumDeviceMemoryGB
      ? `Approximate device memory (${deviceMemoryGB} GB) is below the recommended minimum (${requirements.minimumDeviceMemoryGB} GB).`
      : undefined;

  let webgpuSupported = false;
  let fallbackAdapter = false;
  if (checkers.webgpuChecker) {
    try {
      webgpuSupported = await checkers.webgpuChecker();
    } catch {
      webgpuSupported = false;
    }
  } else if (
    typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    (navigator as {gpu?: {requestAdapter?: () => Promise<unknown>}}).gpu
  ) {
    try {
      const gpu = (
        navigator as {gpu?: {requestAdapter?: () => Promise<unknown>}}
      ).gpu;
      const adapter = (await gpu?.requestAdapter?.()) as
        | {isFallbackAdapter?: boolean}
        | null
        | undefined;
      fallbackAdapter = adapter?.isFallbackAdapter === true;
      webgpuSupported = !!adapter && !fallbackAdapter;
    } catch {
      webgpuSupported = false;
    }
  }

  let quotaAvailable = Number.MAX_SAFE_INTEGER;
  let quotaTotal = Number.MAX_SAFE_INTEGER;
  if (checkers.quotaEstimator) {
    try {
      const est = await checkers.quotaEstimator();
      quotaTotal = est.quota || Number.MAX_SAFE_INTEGER;
      quotaAvailable = Math.max(0, (est.quota || 0) - (est.usage || 0));
    } catch {
      // Ignored
    }
  } else if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      quotaTotal = est.quota || Number.MAX_SAFE_INTEGER;
      quotaAvailable = Math.max(0, (est.quota || 0) - (est.usage || 0));
    } catch {
      // Ignored
    }
  }

  let persistenceGranted = false;
  if (typeof navigator !== 'undefined' && navigator.storage?.persisted) {
    try {
      persistenceGranted = await navigator.storage.persisted();
    } catch {
      persistenceGranted = false;
    }
  }

  let adapterSupported = false;
  if (checkers.adapterChecker) {
    try {
      adapterSupported = await checkers.adapterChecker(adapterId);
    } catch {
      adapterSupported = false;
    }
  } else {
    // Default: litert-lm is supported when Worker + WebGPU + OPFS are available.
    adapterSupported = true;
  }

  if (
    !isHttpsOrLocal ||
    !opfsSupported ||
    !workerSupported ||
    !webgpuSupported ||
    !crossOriginIsolated ||
    !adapterSupported
  ) {
    const missing: string[] = [];
    if (!isHttpsOrLocal) missing.push('Secure context (HTTPS)');
    if (!opfsSupported) missing.push('Origin Private File System (OPFS)');
    if (!workerSupported) missing.push('Web Workers');
    if (!webgpuSupported) missing.push('WebGPU adapter');
    if (fallbackAdapter) missing.push('Hardware WebGPU adapter');
    if (!crossOriginIsolated) missing.push('Cross-origin isolation');
    if (!adapterSupported) missing.push(`Runtime adapter (${adapterId})`);

    return {
      supported: false,
      webgpuSupported,
      fallbackAdapter,
      opfsSupported,
      workerSupported,
      httpsOrLocal: isHttpsOrLocal,
      crossOriginIsolated,
      persistenceGranted,
      deviceMemoryGB,
      memoryWarning,
      quotaAvailableBytes: quotaAvailable,
      quotaTotalBytes: quotaTotal,
      errorCode: !adapterSupported
        ? 'ERR_ADAPTER_UNSUPPORTED'
        : !webgpuSupported
          ? 'ERR_WEBGPU_UNSUPPORTED'
          : 'ERR_STORAGE_UNSUPPORTED',
      errorMessage: `Hardware/browser capabilities missing: ${missing.join(', ')}`,
    };
  }

  // Require model size + 20% headroom
  if (requiredSizeBytes || requirements.minimumFreeStorageBytes) {
    const requiredWithHeadroom = Math.max(
      (requiredSizeBytes ?? 0) * 1.2,
      requirements.minimumFreeStorageBytes ?? 0,
    );
    if (quotaAvailable < requiredWithHeadroom) {
      return {
        supported: false,
        webgpuSupported,
        fallbackAdapter,
        opfsSupported,
        workerSupported,
        httpsOrLocal: isHttpsOrLocal,
        crossOriginIsolated,
        persistenceGranted,
        deviceMemoryGB,
        memoryWarning,
        quotaAvailableBytes: quotaAvailable,
        quotaTotalBytes: quotaTotal,
        errorCode: 'ERR_INSUFFICIENT_STORAGE',
        errorMessage: `Insufficient disk quota. Required: ${Math.round(requiredWithHeadroom / 1e6)} MB, Available: ${Math.round(quotaAvailable / 1e6)} MB`,
      };
    }
  }

  return {
    supported: true,
    webgpuSupported,
    fallbackAdapter,
    opfsSupported,
    workerSupported,
    httpsOrLocal: isHttpsOrLocal,
    crossOriginIsolated,
    persistenceGranted,
    deviceMemoryGB,
    memoryWarning,
    quotaAvailableBytes: quotaAvailable,
    quotaTotalBytes: quotaTotal,
  };
}
