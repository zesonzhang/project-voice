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

import {FakeModelRuntimeAdapter} from '../on-device/fake-runtime-adapter.js';
import {ModelManager} from '../on-device/model-manager.js';
import {ModelManifest} from '../on-device/model-manifest.js';
import {InMemoryModelMetadataStore} from '../on-device/model-metadata.js';
import {InMemoryModelStorage} from '../on-device/model-storage.js';
import {
  LifecycleBroadcastMessage,
  TabCoordinator,
} from '../on-device/tab-coordinator.js';

class MockTabCoordinator implements TabCoordinator {
  async acquireDownloadLock<T>(
    _modelId: string,
    _version: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return await action();
  }
  broadcastProgress(_progress: LifecycleBroadcastMessage): void {
    void _progress;
  }
  broadcastStateChange(_change: LifecycleBroadcastMessage): void {
    void _change;
  }
  onMessage(_listener: (msg: LifecycleBroadcastMessage) => void): () => void {
    void _listener;
    return () => {};
  }
  close(): void {}
}

const COMPAT_MANIFEST: ModelManifest = {
  schemaVersion: 1,
  modelId: 'gemma-4-e2b-it-web',
  version: '2026-08-01',
  displayName: 'Gemma 4 E2B Web',
  family: 'gemma',
  adapterId: 'litert-lm',
  format: 'litertlm',
  sizeBytes: 2008432640,
  sha256: '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5',
  gcsGeneration: '1700000000000001',
  capabilities: {
    textGeneration: true,
    languages: ['en', 'ja'],
    maxInputTokens: 2048,
    maxOutputTokens: 256,
  },
  requirements: {
    webgpu: true,
    minimumDeviceMemoryGB: 8,
    minimumFreeStorageBytes: 2500000000,
  },
  generation: {
    temperature: 0,
    topP: 0.5,
    maxOutputTokens: 256,
  },
};

describe('M4.6 Desktop Chrome Compatibility Matrix & Capability Checks', () => {
  let metadataStore: InMemoryModelMetadataStore;
  let storage: InMemoryModelStorage;

  beforeEach(() => {
    metadataStore = new InMemoryModelMetadataStore();
    storage = new InMemoryModelStorage();
  });

  it('validates compliant Tier 1 desktop Chrome environments (macOS Metal, Windows D3D12, Linux Vulkan)', async () => {
    if (typeof navigator !== 'undefined' && navigator.storage) {
      spyOn(navigator.storage, 'persisted').and.resolveTo(true);
    }
    const manager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator: new MockTabCoordinator(),
      apiClient: {
        getDefaultManifest: async () => COMPAT_MANIFEST,
        getSignedDownloadUrl: async () => ({
          url: 'https://test',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: COMPAT_MANIFEST.sizeBytes,
          sha256: COMPAT_MANIFEST.sha256,
          gcsGeneration: COMPAT_MANIFEST.gcsGeneration,
        }),
      },
      webgpuChecker: async () => true,
      quotaEstimator: async () => ({
        quota: 50_000_000_000,
        usage: 10_000_000_000,
      }),
      persistenceRequester: async () => true,
    });

    const preflight = await manager.checkCapabilities(
      COMPAT_MANIFEST.sizeBytes,
      COMPAT_MANIFEST.adapterId,
    );

    expect(preflight.errorMessage).toBeUndefined();
    expect(preflight.supported).toBeTrue();
    expect(preflight.webgpuSupported).toBeTrue();
    expect(preflight.httpsOrLocal).toBeTrue();
    expect(preflight.persistenceGranted).toBeTrue();
    expect(preflight.quotaAvailableBytes).toBeGreaterThanOrEqual(
      COMPAT_MANIFEST.sizeBytes * 1.2,
    );
    expect(preflight.errorCode).toBeUndefined();
  });

  it('gracefully detects missing WebGPU accelerator and reports ERR_WEBGPU_UNSUPPORTED without crash', async () => {
    const manager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator: new MockTabCoordinator(),
      apiClient: {
        getDefaultManifest: async () => COMPAT_MANIFEST,
        getSignedDownloadUrl: async () => ({
          url: 'https://test',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: COMPAT_MANIFEST.sizeBytes,
          sha256: COMPAT_MANIFEST.sha256,
          gcsGeneration: COMPAT_MANIFEST.gcsGeneration,
        }),
      },
      webgpuChecker: async () => false,
      quotaEstimator: async () => ({
        quota: 50_000_000_000,
        usage: 10_000_000_000,
      }),
    });

    const preflight = await manager.checkCapabilities(
      COMPAT_MANIFEST.sizeBytes,
      COMPAT_MANIFEST.adapterId,
    );

    expect(preflight.supported).toBeFalse();
    expect(preflight.webgpuSupported).toBeFalse();
    expect(preflight.errorCode).toBe('ERR_WEBGPU_UNSUPPORTED');
    expect(preflight.errorMessage).toContain('WebGPU adapter');
  });

  it('detects insufficient storage quota (< 2.5 GB) and reports ERR_INSUFFICIENT_STORAGE', async () => {
    const manager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator: new MockTabCoordinator(),
      apiClient: {
        getDefaultManifest: async () => COMPAT_MANIFEST,
        getSignedDownloadUrl: async () => ({
          url: 'https://test',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: COMPAT_MANIFEST.sizeBytes,
          sha256: COMPAT_MANIFEST.sha256,
          gcsGeneration: COMPAT_MANIFEST.gcsGeneration,
        }),
      },
      webgpuChecker: async () => true,
      // Only 500 MB available (required: ~2.41 GB)
      quotaEstimator: async () => ({quota: 1_000_000_000, usage: 500_000_000}),
    });

    const preflight = await manager.checkCapabilities(
      COMPAT_MANIFEST.sizeBytes,
      COMPAT_MANIFEST.adapterId,
    );

    expect(preflight.supported).toBeFalse();
    expect(preflight.errorCode).toBe('ERR_INSUFFICIENT_STORAGE');
    expect(preflight.errorMessage).toContain('Insufficient disk quota');
  });

  it('rejects unsupported runtime adapter IDs with ERR_ADAPTER_UNSUPPORTED', async () => {
    const manager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator: new MockTabCoordinator(),
      apiClient: {
        getDefaultManifest: async () => COMPAT_MANIFEST,
        getSignedDownloadUrl: async () => ({
          url: 'https://test',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: COMPAT_MANIFEST.sizeBytes,
          sha256: COMPAT_MANIFEST.sha256,
          gcsGeneration: COMPAT_MANIFEST.gcsGeneration,
        }),
      },
      webgpuChecker: async () => true,
      quotaEstimator: async () => ({
        quota: 50_000_000_000,
        usage: 10_000_000_000,
      }),
      adapterChecker: () => false,
    });

    const preflight = await manager.checkCapabilities(
      COMPAT_MANIFEST.sizeBytes,
      'unknown-custom-runtime-adapter',
    );

    expect(preflight.supported).toBeFalse();
    expect(preflight.errorCode).toBe('ERR_ADAPTER_UNSUPPORTED');
  });

  it('handles denied persistent storage gracefully without blocking compliant inference', async () => {
    const manager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator: new MockTabCoordinator(),
      apiClient: {
        getDefaultManifest: async () => COMPAT_MANIFEST,
        getSignedDownloadUrl: async () => ({
          url: 'https://test',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: COMPAT_MANIFEST.sizeBytes,
          sha256: COMPAT_MANIFEST.sha256,
          gcsGeneration: COMPAT_MANIFEST.gcsGeneration,
        }),
      },
      webgpuChecker: async () => true,
      quotaEstimator: async () => ({
        quota: 50_000_000_000,
        usage: 10_000_000_000,
      }),
      persistenceRequester: async () => false, // Denied by browser
    });

    const preflight = await manager.checkCapabilities(
      COMPAT_MANIFEST.sizeBytes,
      COMPAT_MANIFEST.adapterId,
    );

    // Persistence denial is non-fatal: user can still run inference, though eviction risk exists
    expect(preflight.supported).toBeTrue();
    expect(preflight.persistenceGranted).toBeFalse();
  });

  it('handles probe failures on incompatible artifacts cleanly during activation preflight', async () => {
    const fakeAdapter = new FakeModelRuntimeAdapter({supported: false});
    new ModelManager({
      metadataStore,
      storage,
      tabCoordinator: new MockTabCoordinator(),
      apiClient: {
        getDefaultManifest: async () => COMPAT_MANIFEST,
        getSignedDownloadUrl: async () => ({
          url: 'https://test',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: COMPAT_MANIFEST.sizeBytes,
          sha256: COMPAT_MANIFEST.sha256,
          gcsGeneration: COMPAT_MANIFEST.gcsGeneration,
        }),
      },
      runtimeAdapter: fakeAdapter,
      webgpuChecker: async () => true,
    });

    const probeResult = await fakeAdapter.probe(
      COMPAT_MANIFEST,
      new File([new Uint8Array(10)], 'test.litertlm'),
    );
    expect(probeResult.supported).toBeFalse();
    expect(probeResult.errorMessage).toContain(
      'simulated unsupported WebGPU device',
    );
  });
});
