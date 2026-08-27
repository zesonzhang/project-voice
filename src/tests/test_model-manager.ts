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

import {
  ModelApiClient,
  SignedDownloadUrlResponse,
} from '../on-device/model-client.js';
import {
  defaultModelCandidateProbe,
  ModelLifecycleState,
  ModelManager,
  ModelManagerOptions,
} from '../on-device/model-manager.js';
import {ModelManifest} from '../on-device/model-manifest.js';
import {
  InMemoryModelMetadataStore,
  ModelMetadataStore,
} from '../on-device/model-metadata.js';
import {
  InMemoryModelStorage,
  ModelStorage,
} from '../on-device/model-storage.js';
import {
  LifecycleBroadcastMessage,
  TabCoordinator,
} from '../on-device/tab-coordinator.js';

class MockApiClient implements ModelApiClient {
  manifest: ModelManifest;
  signedUrlResponse: SignedDownloadUrlResponse;
  getSignedUrlCallCount = 0;
  getDefaultManifestCallCount = 0;

  constructor(
    manifest: ModelManifest,
    signedUrlResponse: SignedDownloadUrlResponse,
  ) {
    this.manifest = manifest;
    this.signedUrlResponse = signedUrlResponse;
  }

  async getDefaultManifest(): Promise<ModelManifest> {
    this.getDefaultManifestCallCount++;
    return JSON.parse(JSON.stringify(this.manifest));
  }

  async getSignedDownloadUrl(): Promise<SignedDownloadUrlResponse> {
    this.getSignedUrlCallCount++;
    return JSON.parse(JSON.stringify(this.signedUrlResponse));
  }
}

class MockTabCoordinator implements TabCoordinator {
  broadcastMessages: LifecycleBroadcastMessage[] = [];
  private listeners: Set<(msg: LifecycleBroadcastMessage) => void> = new Set();

  async acquireDownloadLock<T>(
    modelId: string,
    version: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return await action();
  }

  broadcastProgress(progress: LifecycleBroadcastMessage): void {
    this.broadcastMessages.push(progress);
    for (const listener of this.listeners) listener(progress);
  }

  broadcastStateChange(change: LifecycleBroadcastMessage): void {
    this.broadcastMessages.push(change);
    for (const listener of this.listeners) listener(change);
  }

  onMessage(listener: (msg: LifecycleBroadcastMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }
}

describe('ModelManager Lifecycle and Failure Injection', () => {
  let metadataStore: ModelMetadataStore;
  let storage: ModelStorage;
  let tabCoordinator: MockTabCoordinator;
  let mockApiClient: MockApiClient;
  let modelPayload: Uint8Array;
  let testManifest: ModelManifest;
  let testSignedUrl: SignedDownloadUrlResponse;

  beforeEach(() => {
    metadataStore = new InMemoryModelMetadataStore();
    storage = new InMemoryModelStorage();
    tabCoordinator = new MockTabCoordinator();

    // "Hello World" payload: sha256 = a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e
    modelPayload = new TextEncoder().encode('Hello World');

    testManifest = {
      schemaVersion: 1,
      modelId: 'gemma-web-default',
      version: '2026-08-01',
      displayName: 'Gemma 4 E2B IT Web',
      family: 'gemma',
      adapterId: 'litert-lm',
      format: 'litertlm',
      sizeBytes: modelPayload.byteLength,
      sha256:
        'a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e',
      gcsGeneration: '1738700000000000',
      capabilities: {
        textGeneration: true,
        languages: ['en', 'ja'],
        maxInputTokens: 1024,
        maxOutputTokens: 128,
      },
      requirements: {
        webgpu: true,
        minimumDeviceMemoryGB: 8,
        minimumFreeStorageBytes: 100000,
      },
      generation: {
        temperature: 0,
        topP: 0.5,
        maxOutputTokens: 128,
      },
    };

    testSignedUrl = {
      url: `https://storage.googleapis.com/test-bucket/model.litertlm?generation=${testManifest.gcsGeneration}&X-Goog-Signature=123`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      sizeBytes: modelPayload.byteLength,
      sha256: testManifest.sha256,
      gcsGeneration: testManifest.gcsGeneration,
    };

    mockApiClient = new MockApiClient(testManifest, testSignedUrl);
  });

  function createTestManager(
    overrides: Partial<ModelManagerOptions> = {},
  ): ModelManager {
    return new ModelManager({
      metadataStore,
      storage,
      apiClient: mockApiClient,
      tabCoordinator,
      webgpuChecker: async () => true,
      quotaEstimator: async () => ({quota: 10_000_000, usage: 100_000}),
      ...overrides,
    });
  }

  function createMockFetch(
    payload: Uint8Array,
    options?: {
      failWith403Times?: number;
      ignoreRangeHeader?: boolean;
    },
  ): typeof fetch {
    let fail403Remaining = options?.failWith403Times || 0;

    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (fail403Remaining > 0) {
        fail403Remaining--;
        return new Response(null, {
          status: 403,
          statusText: 'Forbidden (Expired URL)',
        });
      }

      const headers = (init?.headers as Record<string, string>) || {};
      const rangeHeader = headers['Range'];

      let offset = 0;
      let isPartial = false;
      if (rangeHeader && !options?.ignoreRangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-/);
        if (match) {
          offset = parseInt(match[1], 10);
          isPartial = true;
        }
      }

      const sliced = payload.subarray(offset);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(sliced);
          controller.close();
        },
      });

      return new Response(stream, {
        status: isPartial ? 206 : 200,
        statusText: isPartial ? 'Partial Content' : 'OK',
        headers: {
          'Content-Length': String(sliced.byteLength),
          'Content-Range': `bytes ${offset}-${payload.byteLength - 1}/${payload.byteLength}`,
        },
      });
    }) as unknown as typeof fetch;
  }

  it('transitions to unsupported when WebGPU is missing', async () => {
    const manager = createTestManager({
      webgpuChecker: async () => false,
    });
    await manager.initialize();
    expect(manager.getState()).toBe('unsupported');
    expect(manager.getError()?.code).toBe('ERR_WEBGPU_UNSUPPORTED');
  });

  it('initializes to not_downloaded when no local model is present', async () => {
    const manager = createTestManager();
    await manager.initialize();
    expect(manager.getState()).toBe('not_downloaded');
  });

  it('restores already verified model on startup without downloading bytes', async () => {
    // Pre-populate storage and metadata with verified model
    await storage.writeChunk(
      testManifest.modelId,
      testManifest.version,
      modelPayload,
      0,
    );
    await storage.promotePartialToModel(
      testManifest.modelId,
      testManifest.version,
    );

    await metadataStore.saveVersion({
      modelId: testManifest.modelId,
      version: testManifest.version,
      manifest: testManifest,
      fileName: `${testManifest.version}.litertlm`,
      partialFileName: `${testManifest.version}.partial`,
      sizeBytes: testManifest.sizeBytes,
      sha256: testManifest.sha256,
      gcsGeneration: testManifest.gcsGeneration,
      downloadOffset: testManifest.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: null,
    });
    await metadataStore.setActiveVersion(
      testManifest.modelId,
      testManifest.version,
    );

    const manager = createTestManager();
    await manager.initialize();
    // Reconciled directly to downloaded with 0 download network calls
    expect(manager.getState()).toBe('downloaded');
    expect(mockApiClient.getDefaultManifestCallCount).toBe(0);
    expect(mockApiClient.getSignedUrlCallCount).toBe(0);
  });

  it('detects update_available when remote version is newer than active version', async () => {
    await metadataStore.saveModel({
      modelId: testManifest.modelId,
      activeVersion: 'older-version',
      lastKnownGoodVersion: null,
      updatedAt: Date.now(),
    });

    const manager = createTestManager();
    await manager.initialize();
    await manager.checkForUpdate();
    expect(manager.getState()).toBe('update_available');
  });

  it('completes download, streaming verification, and activation', async () => {
    const states: ModelLifecycleState[] = [];
    const manager = createTestManager({
      customFetch: createMockFetch(modelPayload),
      smokeTestHook: async (file, manifest) => {
        expect(file.size).toBe(manifest.sizeBytes);
        return true;
      },
    });

    manager.onStateChange(s => states.push(s));
    await manager.downloadModel(testManifest);

    expect(states).toContain('downloading');
    expect(states).toContain('verifying');
    expect(states).toContain('loading');
    expect(manager.getState()).toBe('ready');

    // Model artifact exists in storage
    expect(
      await storage.hasModel(testManifest.modelId, testManifest.version),
    ).toBeTrue();
    // Partial file was cleaned up
    expect(
      await storage.hasPartial(testManifest.modelId, testManifest.version),
    ).toBeFalse();

    // Metadata is active and verified
    const modelRecord = await metadataStore.getModel(testManifest.modelId);
    expect(modelRecord?.activeVersion).toBe(testManifest.version);
  });

  it('pauses and resumes download with Range header', async () => {
    // Simulate partial download (first 5 bytes)
    await storage.writeChunk(
      testManifest.modelId,
      testManifest.version,
      modelPayload.subarray(0, 5),
      0,
    );
    await metadataStore.saveVersion({
      modelId: testManifest.modelId,
      version: testManifest.version,
      manifest: testManifest,
      fileName: `${testManifest.version}.litertlm`,
      partialFileName: `${testManifest.version}.partial`,
      sizeBytes: testManifest.sizeBytes,
      sha256: testManifest.sha256,
      gcsGeneration: testManifest.gcsGeneration,
      downloadOffset: 5,
      verificationState: 'unverified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: null,
    });

    let observedRangeHeader = '';
    const customFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const headers = (init?.headers as Record<string, string>) || {};
      observedRangeHeader = headers['Range'] || '';
      const offset = 5;
      const sliced = modelPayload.subarray(offset);
      return new Response(sliced as unknown as BodyInit, {
        status: 206,
        headers: {
          'Content-Length': String(sliced.byteLength),
          'Content-Range': `bytes ${offset}-${modelPayload.byteLength - 1}/${modelPayload.byteLength}`,
        },
      });
    }) as unknown as typeof fetch;

    const manager = createTestManager({customFetch});
    await manager.downloadModel(testManifest);

    expect(observedRangeHeader).toBe('bytes=5-');
    expect(manager.getState()).toBe('ready');
  });

  it('restarts safely from 0 if server returns 200 instead of 206 on Range request', async () => {
    // Existing partial offset
    await storage.writeChunk(
      testManifest.modelId,
      testManifest.version,
      modelPayload.subarray(0, 5),
      0,
    );

    const manager = createTestManager({
      customFetch: createMockFetch(modelPayload, {ignoreRangeHeader: true}),
    });

    await manager.downloadModel(testManifest);
    expect(manager.getState()).toBe('ready');
  });

  it('refreshes expired signed URL on 403 Forbidden and resumes', async () => {
    const manager = createTestManager({
      customFetch: createMockFetch(modelPayload, {failWith403Times: 1}),
    });

    await manager.downloadModel(testManifest);
    expect(mockApiClient.getSignedUrlCallCount).toBe(2);
    expect(manager.getState()).toBe('ready');
  });

  it('rejects signed URL metadata that is not pinned to the manifest', async () => {
    mockApiClient.signedUrlResponse.gcsGeneration = '999';
    const manager = createTestManager({
      customFetch: createMockFetch(modelPayload),
    });

    await manager.downloadModel(testManifest);

    expect(manager.getState()).toBe('error');
    expect(manager.getError()?.message).toContain('does not match');
  });

  it('rejects a resumed response with a mismatched Content-Range', async () => {
    await storage.writeChunk(
      testManifest.modelId,
      testManifest.version,
      modelPayload.subarray(0, 5),
      0,
    );
    const customFetch = (async () =>
      new Response(modelPayload.subarray(5) as unknown as BodyInit, {
        status: 206,
        headers: {
          'Content-Length': String(modelPayload.byteLength - 5),
          'Content-Range': `bytes 4-${modelPayload.byteLength - 1}/${modelPayload.byteLength}`,
        },
      })) as unknown as typeof fetch;
    const manager = createTestManager({customFetch});

    await manager.downloadModel(testManifest);

    expect(manager.getState()).toBe('error');
    expect(manager.getError()?.message).toContain('Invalid Content-Range');
  });

  it('deletes corrupt candidate file on checksum mismatch', async () => {
    const corruptPayload = new TextEncoder().encode('Jello World');
    const manager = createTestManager({
      customFetch: createMockFetch(corruptPayload),
    });

    await manager.downloadModel(testManifest);

    expect(manager.getState()).toBe('error');
    expect(manager.getError()?.code).toBe('ERR_CHECKSUM_MISMATCH');

    // Corrupt candidate was purged from storage (M2.12)
    expect(
      await storage.hasPartial(testManifest.modelId, testManifest.version),
    ).toBeFalse();
    expect(
      await storage.hasModel(testManifest.modelId, testManifest.version),
    ).toBeFalse();

    const verRecord = await metadataStore.getVersion(
      testManifest.modelId,
      testManifest.version,
    );
    expect(verRecord?.verificationState).toBe('corrupt');
  });

  it('rejects download when disk quota is insufficient (headroom check)', async () => {
    const manager = createTestManager({
      // Provide less quota than model size * 1.2
      quotaEstimator: async () => ({quota: 10, usage: 5}),
      customFetch: createMockFetch(modelPayload),
    });

    await manager.downloadModel(testManifest);

    expect(manager.getState()).toBe('error');
    expect(manager.getError()?.code).toBe('ERR_INSUFFICIENT_STORAGE');
  });

  it('handles smoke test failure and transitions to error', async () => {
    const manager = createTestManager({
      customFetch: createMockFetch(modelPayload),
      smokeTestHook: async () => false, // Smoke test rejects model
    });

    await manager.downloadModel(testManifest);

    expect(manager.getState()).toBe('error');
    expect(manager.getError()?.code).toBe('ERR_SMOKE_TEST_FAILED');
  });

  it('supports rollback to lastKnownGoodVersion', async () => {
    // Initial active version v1
    await storage.writeChunk(testManifest.modelId, 'v1', modelPayload, 0);
    await storage.promotePartialToModel(testManifest.modelId, 'v1');

    await metadataStore.saveVersion({
      modelId: testManifest.modelId,
      version: 'v1',
      manifest: {...testManifest, version: 'v1'},
      fileName: 'v1.litertlm',
      partialFileName: 'v1.partial',
      sizeBytes: testManifest.sizeBytes,
      sha256: testManifest.sha256,
      gcsGeneration: '1',
      downloadOffset: testManifest.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: null,
    });
    await metadataStore.setActiveVersion(testManifest.modelId, 'v1');

    const v2Manifest: ModelManifest = {
      ...testManifest,
      version: 'v2',
      sha256: testManifest.sha256,
      gcsGeneration: '2',
    };
    mockApiClient.manifest = v2Manifest;
    mockApiClient.signedUrlResponse.gcsGeneration = '2';
    mockApiClient.signedUrlResponse.url =
      'https://storage.googleapis.com/test-bucket/model.litertlm?generation=2&X-Goog-Signature=v2';

    const manager = createTestManager({
      customFetch: createMockFetch(modelPayload),
    });

    await manager.initialize();
    // Update to v2
    await manager.updateModel(v2Manifest);
    expect(manager.getActiveManifest()?.version).toBe('v2');
    expect(await storage.hasModel(testManifest.modelId, 'v1')).toBeTrue();

    // Rollback to v1
    const rolledBack = await manager.rollback();
    expect(rolledBack).toBeTrue();
    expect(manager.getActiveManifest()?.version).toBe('v1');
    expect(manager.getState()).toBe('ready');
  });

  it('removes the superseded version only after a successful suggestion boundary', async () => {
    await storage.writeChunk(testManifest.modelId, 'v1', modelPayload, 0);
    await storage.promotePartialToModel(testManifest.modelId, 'v1');
    await metadataStore.saveVersion({
      modelId: testManifest.modelId,
      version: 'v1',
      manifest: {...testManifest, version: 'v1'},
      fileName: 'v1.litertlm',
      partialFileName: 'v1.partial',
      sizeBytes: testManifest.sizeBytes,
      sha256: testManifest.sha256,
      gcsGeneration: '1',
      downloadOffset: testManifest.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: null,
    });
    await metadataStore.setActiveVersion(testManifest.modelId, 'v1');

    const v2Manifest = {...testManifest, version: 'v2', gcsGeneration: '2'};
    mockApiClient.signedUrlResponse = {
      ...testSignedUrl,
      gcsGeneration: '2',
      url: 'https://storage.googleapis.com/test-bucket/model.litertlm?generation=2&X-Goog-Signature=v2',
    };
    const manager = createTestManager({
      customFetch: createMockFetch(modelPayload),
    });
    await manager.initialize();
    await manager.updateModel(v2Manifest);

    expect(await storage.hasModel(testManifest.modelId, 'v1')).toBeTrue();
    expect(
      (await metadataStore.getModel(testManifest.modelId))
        ?.lastKnownGoodVersion,
    ).toBe('v1');

    await manager.confirmActiveVersionHealthy();

    expect(await storage.hasModel(testManifest.modelId, 'v1')).toBeFalse();
    expect(
      await metadataStore.getVersion(testManifest.modelId, 'v1'),
    ).toBeNull();
  });

  it('handles site-data loss gracefully without throwing and allows fresh installation', async () => {
    const manager = createTestManager({
      customFetch: createMockFetch(modelPayload),
    });
    await manager.initialize();
    await manager.downloadModel(testManifest);
    expect(manager.getState()).toBe('ready');

    // Simulate site-data loss: IndexedDB cleared by browser/user
    await metadataStore.clearAll();

    // Re-initialize manager: should transition cleanly to not_downloaded
    const freshCoordinator = new MockTabCoordinator();
    const freshManager = createTestManager({
      tabCoordinator: freshCoordinator,
      customFetch: createMockFetch(modelPayload),
    });
    await freshManager.initialize();
    expect(freshManager.getState()).toBe('not_downloaded');
    expect(freshManager.getActiveManifest()?.modelId).toBe(
      testManifest.modelId,
    );

    // Can reinstall model cleanly
    await freshManager.downloadModel(testManifest);
    expect(freshManager.getState()).toBe('ready');
  });

  it('recovers from interrupted activation / failed smoke test without corrupting existing active model', async () => {
    // 1. Establish active v1
    await storage.writeChunk(testManifest.modelId, 'v1', modelPayload, 0);
    await storage.promotePartialToModel(testManifest.modelId, 'v1');
    await metadataStore.saveVersion({
      modelId: testManifest.modelId,
      version: 'v1',
      manifest: {...testManifest, version: 'v1'},
      fileName: 'v1.litertlm',
      partialFileName: 'v1.partial',
      sizeBytes: testManifest.sizeBytes,
      sha256: testManifest.sha256,
      gcsGeneration: '1',
      downloadOffset: testManifest.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: null,
    });
    await metadataStore.setActiveVersion(testManifest.modelId, 'v1');

    // 2. Candidate v2 download with a smoke test hook that fails
    const v2Manifest = {...testManifest, version: 'v2', gcsGeneration: '2'};
    mockApiClient.manifest = v2Manifest;
    mockApiClient.signedUrlResponse = {
      ...testSignedUrl,
      gcsGeneration: '2',
      url: 'https://storage.googleapis.com/test-bucket/model.litertlm?generation=2&X-Goog-Signature=v2',
    };

    const manager = createTestManager({
      customFetch: createMockFetch(modelPayload),
      smokeTestHook: async () => false, // Simulate probe / smoke test failure
    });
    await manager.initialize();
    await manager.updateModel(v2Manifest);

    // State must be error, and v1 must still be active
    expect(manager.getState()).toBe('error');
    expect(manager.getError()?.code).toBe('ERR_SMOKE_TEST_FAILED');
    expect(await storage.hasModel(testManifest.modelId, 'v1')).toBeTrue();
    const model = await metadataStore.getModel(testManifest.modelId);
    expect(model?.activeVersion).toBe('v1');
  });

  it('cleans up orphan partial files left behind by aborted or corrupted downloads', async () => {
    // Write an unverified/corrupted partial file
    await storage.writeChunk(
      testManifest.modelId,
      'orphan-v1',
      new Uint8Array([1, 2, 3]),
      0,
    );
    await metadataStore.saveVersion({
      modelId: testManifest.modelId,
      version: 'orphan-v1',
      manifest: {...testManifest, version: 'orphan-v1'},
      fileName: 'orphan-v1.litertlm',
      partialFileName: 'orphan-v1.partial',
      sizeBytes: 3,
      sha256: 'fake',
      gcsGeneration: '1',
      downloadOffset: 3,
      verificationState: 'corrupt',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: null,
    });

    const manager = createTestManager();
    const cleaned = await manager.cleanupOrphanPartials(testManifest.modelId);
    expect(cleaned).toContain('orphan-v1.partial');
    expect(
      await storage.hasPartial(testManifest.modelId, 'orphan-v1'),
    ).toBeFalse();
  });

  it('restores verified model upon startup with zero network requests', async () => {
    const manager = createTestManager({
      customFetch: createMockFetch(modelPayload),
    });
    await manager.initialize();
    await manager.downloadModel(testManifest);
    expect(manager.getState()).toBe('ready');

    const manifestCallsBefore = mockApiClient.getDefaultManifestCallCount;
    const signedUrlCallsBefore = mockApiClient.getSignedUrlCallCount;

    // Simulate browser restart by constructing a fresh manager on the same storage
    const restartCoordinator = new MockTabCoordinator();
    const restartManager = createTestManager({
      tabCoordinator: restartCoordinator,
      customFetch: () => {
        throw new Error('No network should be used during startup restoration');
      },
    });
    await restartManager.initialize();

    expect(restartManager.getState()).toBe('downloaded');
    expect(restartManager.getActiveManifest()?.version).toBe(
      testManifest.version,
    );
    expect(mockApiClient.getDefaultManifestCallCount).toBe(manifestCallsBefore);
    expect(mockApiClient.getSignedUrlCallCount).toBe(signedUrlCallsBefore);

    // Can load model into ready state without network
    await restartManager.activateCandidate(testManifest);
    expect(restartManager.getState()).toBe('ready');
  });

  it('defaultModelCandidateProbe validates candidate file properties and adapter', async () => {
    const dummyFile = new File(
      [modelPayload.buffer as ArrayBuffer],
      'model.litertlm',
    );
    const valid = await defaultModelCandidateProbe(dummyFile, testManifest);
    expect(valid).toBeTrue();

    // Size mismatch
    const sizeMismatchManifest: ModelManifest = {
      ...testManifest,
      sizeBytes: 99999,
    };
    const invalidSize = await defaultModelCandidateProbe(
      dummyFile,
      sizeMismatchManifest,
    );
    expect(invalidSize).toBeFalse();

    // Unsupported adapter
    const unsupportedAdapterManifest: ModelManifest = {
      ...testManifest,
      adapterId: 'unsupported-adapter' as unknown as ModelManifest['adapterId'],
    };
    const invalidAdapter = await defaultModelCandidateProbe(
      dummyFile,
      unsupportedAdapterManifest,
    );
    expect(invalidAdapter).toBeFalse();
  });
});
