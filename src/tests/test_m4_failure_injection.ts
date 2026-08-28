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

import {LocalSuggestionProvider} from '../local-suggestion-provider.js';
import {FakeModelRuntimeAdapter} from '../on-device/fake-runtime-adapter.js';
import {ModelManager} from '../on-device/model-manager.js';
import {ModelManifest} from '../on-device/model-manifest.js';
import {InMemoryModelMetadataStore} from '../on-device/model-metadata.js';
import {InMemoryModelStorage} from '../on-device/model-storage.js';
import {
  LifecycleBroadcastMessage,
  TabCoordinator,
} from '../on-device/tab-coordinator.js';
import {SuggestionRequest} from '../suggestion-provider.js';

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

const FI_V1_MANIFEST: ModelManifest = {
  schemaVersion: 1,
  modelId: 'gemma-fi-test',
  version: 'v1.0.0',
  displayName: 'Gemma FI Test V1',
  family: 'gemma',
  adapterId: 'litert-lm',
  format: 'litertlm',
  sizeBytes: 1024,
  sha256: 'b2256110f2c4226de0008dd4382a388e033f211b617bd3237135ab1d59a722b6',
  gcsGeneration: '1001',
  capabilities: {
    textGeneration: true,
    languages: ['en'],
    maxInputTokens: 1024,
    maxOutputTokens: 128,
  },
  requirements: {
    webgpu: true,
    minimumDeviceMemoryGB: 8,
    minimumFreeStorageBytes: 2000,
  },
  generation: {
    temperature: 0,
    topP: 0.5,
    maxOutputTokens: 128,
  },
};

const FI_V2_MANIFEST: ModelManifest = {
  ...FI_V1_MANIFEST,
  version: 'v2.0.0',
  displayName: 'Gemma FI Test V2',
  sizeBytes: 2048,
  sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  gcsGeneration: '1002',
};

function createValidSignedUrl(manifest: ModelManifest) {
  return {
    url: `https://storage.googleapis.com/test-bucket/model.litertlm?generation=${manifest.gcsGeneration}&sig=test`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    sizeBytes: manifest.sizeBytes,
    sha256: manifest.sha256,
    gcsGeneration: manifest.gcsGeneration,
  };
}

const SAMPLE_REQ: SuggestionRequest = {
  text: 'Hello failure test',
  language: 'English',
  cloudModel: 'gemini',
  sentencePromptId: 'SentenceGeneric20260130',
  wordPromptId: 'WordGeneric20240628',
  persona: '',
  lastOutputSpeech: '',
  lastInputSpeech: '',
  conversationHistory: '',
  sentenceEmotion: '',
};

describe('M4.8 Download and Lifecycle Failure-Injection Validation', () => {
  let metadataStore: InMemoryModelMetadataStore;
  let storage: InMemoryModelStorage;
  let tabCoordinator: MockTabCoordinator;

  beforeEach(() => {
    metadataStore = new InMemoryModelMetadataStore();
    storage = new InMemoryModelStorage();
    tabCoordinator = new MockTabCoordinator();
  });

  it('resumes download after simulated network disconnection without losing downloaded chunks', async () => {
    const payload = new Uint8Array(FI_V1_MANIFEST.sizeBytes);
    payload.fill(42);

    let networkAttempts = 0;
    const failingFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      networkAttempts++;
      const headers = (init?.headers as Record<string, string>) || {};
      const range = headers['Range'] || '';

      if (networkAttempts === 1) {
        // First chunk streams 512 bytes, then simulates network drop
        let chunkSent = false;
        const stream = new ReadableStream({
          pull(controller) {
            if (!chunkSent) {
              chunkSent = true;
              controller.enqueue(payload.subarray(0, 512));
            } else {
              controller.error(
                new TypeError('Network connection lost (simulated offline)'),
              );
            }
          },
        });
        return new Response(stream, {
          status: 206,
          headers: {
            'Content-Length': '512',
            'Content-Range': `bytes 0-511/${payload.byteLength}`,
          },
        });
      }

      // Second attempt resumes from Range
      expect(range).toContain('bytes=512-');
      const secondChunk = payload.subarray(512);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(secondChunk);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Length': String(secondChunk.byteLength),
          'Content-Range': `bytes 512-${payload.byteLength - 1}/${payload.byteLength}`,
        },
      });
    }) as unknown as typeof fetch;

    const manager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator,
      apiClient: {
        getDefaultManifest: async () => FI_V1_MANIFEST,
        getSignedDownloadUrl: async () => createValidSignedUrl(FI_V1_MANIFEST),
      },
      customFetch: failingFetch,
      webgpuChecker: async () => true,
      smokeTestHook: async () => true,
    });

    // Attempt 1: Network drops mid-stream
    await manager.downloadModel(FI_V1_MANIFEST);
    expect(manager.getState()).toBe('error');
    expect(manager.getError()?.code).toBe('ERR_DOWNLOAD_FAILED');

    // Partial bytes must be preserved
    const hasPartial = await storage.hasPartial(
      FI_V1_MANIFEST.modelId,
      FI_V1_MANIFEST.version,
    );
    expect(hasPartial).toBeTrue();
    const partialSize = await storage.getPartialSize(
      FI_V1_MANIFEST.modelId,
      FI_V1_MANIFEST.version,
    );
    expect(partialSize).toBe(512);

    // Attempt 2: Resume download
    await manager.downloadModel(FI_V1_MANIFEST);
    expect(networkAttempts).toBe(2);
    expect(manager.getState()).toBe('ready');
  });

  it('preserves active healthy model when candidate update download fails quota check', async () => {
    // Setup active healthy V1 model in storage & metadata
    await metadataStore.saveModel({
      modelId: FI_V1_MANIFEST.modelId,
      activeVersion: FI_V1_MANIFEST.version,
      lastKnownGoodVersion: FI_V1_MANIFEST.version,
      updatedAt: Date.now(),
    });
    await metadataStore.saveVersion({
      modelId: FI_V1_MANIFEST.modelId,
      version: FI_V1_MANIFEST.version,
      manifest: FI_V1_MANIFEST,
      fileName: `${FI_V1_MANIFEST.version}.litertlm`,
      partialFileName: `${FI_V1_MANIFEST.version}.partial`,
      sizeBytes: FI_V1_MANIFEST.sizeBytes,
      sha256: FI_V1_MANIFEST.sha256,
      gcsGeneration: FI_V1_MANIFEST.gcsGeneration,
      downloadOffset: FI_V1_MANIFEST.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    await storage.writeChunk(
      FI_V1_MANIFEST.modelId,
      FI_V1_MANIFEST.version,
      new Uint8Array(FI_V1_MANIFEST.sizeBytes),
      0,
    );
    await storage.promotePartialToModel(
      FI_V1_MANIFEST.modelId,
      FI_V1_MANIFEST.version,
    );

    // Quota estimator reports only 100 bytes free (candidate V2 requires ~2457 bytes)
    const manager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator,
      apiClient: {
        getDefaultManifest: async () => FI_V2_MANIFEST,
        getSignedDownloadUrl: async () => createValidSignedUrl(FI_V2_MANIFEST),
      },
      quotaEstimator: async () => ({quota: 10_000, usage: 9_900}),
      webgpuChecker: async () => true,
    });

    await manager.initialize();
    expect(manager.getState()).toBe('downloaded');

    // Attempt to download candidate update V2
    await manager.downloadModel(FI_V2_MANIFEST);
    expect(manager.getState()).toBe('error');
    expect(manager.getError()?.code).toBe('ERR_INSUFFICIENT_STORAGE');

    // V1 active model MUST NOT be deleted or corrupted
    const v1Exists = await storage.hasModel(
      FI_V1_MANIFEST.modelId,
      FI_V1_MANIFEST.version,
    );
    expect(v1Exists).toBeTrue();
    const activeModelRecord = await metadataStore.getModel(
      FI_V1_MANIFEST.modelId,
    );
    expect(activeModelRecord?.activeVersion).toBe(FI_V1_MANIFEST.version);
  });

  it('rejects candidate model with corrupted checksum and leaves active LKG intact', async () => {
    // 1. Setup active V1 model
    await metadataStore.saveModel({
      modelId: FI_V1_MANIFEST.modelId,
      activeVersion: FI_V1_MANIFEST.version,
      lastKnownGoodVersion: FI_V1_MANIFEST.version,
      updatedAt: Date.now(),
    });
    await metadataStore.saveVersion({
      modelId: FI_V1_MANIFEST.modelId,
      version: FI_V1_MANIFEST.version,
      manifest: FI_V1_MANIFEST,
      fileName: `${FI_V1_MANIFEST.version}.litertlm`,
      partialFileName: `${FI_V1_MANIFEST.version}.partial`,
      sizeBytes: FI_V1_MANIFEST.sizeBytes,
      sha256: FI_V1_MANIFEST.sha256,
      gcsGeneration: FI_V1_MANIFEST.gcsGeneration,
      downloadOffset: FI_V1_MANIFEST.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    await storage.writeChunk(
      FI_V1_MANIFEST.modelId,
      FI_V1_MANIFEST.version,
      new Uint8Array(FI_V1_MANIFEST.sizeBytes),
      0,
    );
    await storage.promotePartialToModel(
      FI_V1_MANIFEST.modelId,
      FI_V1_MANIFEST.version,
    );

    // 2. Fetch returning corrupted candidate bytes for V2
    const corruptBytes = new Uint8Array(FI_V2_MANIFEST.sizeBytes);
    corruptBytes.fill(99); // does not match FI_V2_MANIFEST.sha256

    const corruptFetch = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(corruptBytes);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {'Content-Length': String(corruptBytes.byteLength)},
      });
    }) as unknown as typeof fetch;

    const manager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator,
      apiClient: {
        getDefaultManifest: async () => FI_V2_MANIFEST,
        getSignedDownloadUrl: async () => createValidSignedUrl(FI_V2_MANIFEST),
      },
      customFetch: corruptFetch,
      webgpuChecker: async () => true,
    });

    await manager.initialize();
    await manager.downloadModel(FI_V2_MANIFEST);

    // Candidate rejected due to checksum mismatch
    expect(manager.getState()).toBe('error');
    expect(manager.getError()?.code).toBe('ERR_CHECKSUM_MISMATCH');

    // Active V1 model is still healthy and untouched
    const v1ModelExists = await storage.hasModel(
      FI_V1_MANIFEST.modelId,
      FI_V1_MANIFEST.version,
    );
    expect(v1ModelExists).toBeTrue();

    const activeRec = await metadataStore.getModel(FI_V1_MANIFEST.modelId);
    expect(activeRec?.activeVersion).toBe(FI_V1_MANIFEST.version);

    // Corrupted V2 candidate partial removed
    const v2PartialExists = await storage.hasPartial(
      FI_V2_MANIFEST.modelId,
      FI_V2_MANIFEST.version,
    );
    expect(v2PartialExists).toBeFalse();
  });

  it('reconciles IndexedDB and OPFS desynchronization without crashing', async () => {
    // Inconsistency Scenario: IndexedDB lists active verified model, but file is missing in OPFS
    await metadataStore.saveModel({
      modelId: FI_V1_MANIFEST.modelId,
      activeVersion: FI_V1_MANIFEST.version,
      lastKnownGoodVersion: FI_V1_MANIFEST.version,
      updatedAt: Date.now(),
    });
    await metadataStore.saveVersion({
      modelId: FI_V1_MANIFEST.modelId,
      version: FI_V1_MANIFEST.version,
      manifest: FI_V1_MANIFEST,
      fileName: `${FI_V1_MANIFEST.version}.litertlm`,
      partialFileName: `${FI_V1_MANIFEST.version}.partial`,
      sizeBytes: FI_V1_MANIFEST.sizeBytes,
      sha256: FI_V1_MANIFEST.sha256,
      gcsGeneration: FI_V1_MANIFEST.gcsGeneration,
      downloadOffset: FI_V1_MANIFEST.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    // Note: No file created in storage!

    const manager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator,
      apiClient: {
        getDefaultManifest: async () => FI_V1_MANIFEST,
        getSignedDownloadUrl: async () => createValidSignedUrl(FI_V1_MANIFEST),
      },
      webgpuChecker: async () => true,
    });

    // Startup reconciles: detects missing file, falls back to not_downloaded
    await manager.initialize();
    expect(manager.getState()).toBe('not_downloaded');
  });

  it('recovers cleanly from WebGPU device loss during inference without falling back to cloud', async () => {
    const fakeAdapter = new FakeModelRuntimeAdapter();
    fakeAdapter.isLoaded = true;

    const provider = new LocalSuggestionProvider(
      fakeAdapter,
      () => ({
        modelId: FI_V1_MANIFEST.modelId,
        modelVersion: FI_V1_MANIFEST.version,
      }),
      () => true,
    );

    // Simulate device loss during inference
    spyOn(fakeAdapter, 'generate').and.throwError(
      new Error('WebGPU device lost: device was removed or TDR occurred'),
    );

    await expectAsync(provider.suggest(SAMPLE_REQ)).toBeRejectedWithError(
      /WebGPU device lost/,
    );

    // Provider state is aborted and ready for retry/reload
    provider.abort();
    expect(fakeAdapter.isCancelled).toBeTrue();
  });
});
