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
  LocalSuggestionProvider,
  parseSuggestionResponse,
} from '../local-suggestion-provider.js';
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

const PERF_MANIFEST: ModelManifest = {
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

const SAMPLE_REQUEST: SuggestionRequest = {
  text: 'Hello, how can I help you today?',
  language: 'English',
  cloudModel: 'gemini',
  sentencePromptId: 'SentenceGeneric20260130',
  wordPromptId: 'WordGeneric20240628',
  persona: 'Assistant',
  lastOutputSpeech: '',
  lastInputSpeech: '',
  conversationHistory: '',
  sentenceEmotion: '',
};

describe('M4 synthetic runtime regressions (not release evidence)', () => {
  it('keeps the deterministic fake-provider path responsive in CI', async () => {
    const latencies: number[] = [];
    const firstWordLatencies: number[] = [];

    const adapter = new FakeModelRuntimeAdapter();
    adapter.isLoaded = true;

    const provider = new LocalSuggestionProvider(
      adapter,
      () => ({
        modelId: PERF_MANIFEST.modelId,
        modelVersion: PERF_MANIFEST.version,
      }),
      () => true,
    );

    // This protects asynchronous plumbing from gross regressions. Fake-runtime
    // timings must never be reported as production-model latency evidence.
    for (let i = 0; i < 30; i++) {
      let firstWordMs = 0;
      const start = performance.now();

      await provider.suggest(SAMPLE_REQUEST, () => {
        if (!firstWordMs) {
          firstWordMs = performance.now() - start;
        }
      });

      const totalMs = performance.now() - start;
      firstWordLatencies.push(firstWordMs || totalMs * 0.4);
      latencies.push(totalMs);
    }

    firstWordLatencies.sort((a, b) => a - b);
    latencies.sort((a, b) => a - b);

    const p95FirstWord =
      firstWordLatencies[Math.floor(firstWordLatencies.length * 0.95)];
    const p95Total = latencies[Math.floor(latencies.length * 0.95)];

    expect(p95FirstWord).toBeLessThanOrEqual(2000);
    expect(p95Total).toBeLessThanOrEqual(5000);
  });

  it('parses the deterministic multilingual numbered-output corpus', () => {
    const testOutputs = [
      '1. I will be there soon.\n2. Can you please wait a moment?\n3. Thank you for your help.',
      '1. 今日はいい天気ですね。\n2. お茶を飲みたいです。\n3. また明日会いましょう。',
      '1. *Certainly!* How can I assist?\n2. *Of course!* Let me check.\n3. *No problem!*',
      '1. §こんにちは§\n2. §さようなら§',
      '1. Option one\n2. Option two',
      '1. First choice\n2. Second choice\n3. Third choice\n4. Fourth choice',
      '1. Just one suggestion',
      '1. Hello* world\n2. Another phrase',
      '1. ありがとうございます\n2. どういたしまして\n3. すみません',
      '1. Valid line one\n2. Valid line two\nInvalid line\n3. Valid line three',
    ];

    let validCount = 0;
    for (const output of testOutputs) {
      const parsed = parseSuggestionResponse(output, 'English');
      if (parsed && parsed.length > 0) {
        validCount++;
      }
    }

    const parseRate = (validCount / testOutputs.length) * 100;
    expect(parseRate).toBeGreaterThanOrEqual(95);
  });

  it('keeps fake-provider asynchronous updates below a coarse CI timeout', async () => {
    const adapter = new FakeModelRuntimeAdapter();
    adapter.isLoaded = true;

    const provider = new LocalSuggestionProvider(
      adapter,
      () => ({
        modelId: PERF_MANIFEST.modelId,
        modelVersion: PERF_MANIFEST.version,
      }),
      () => true,
    );

    let maxMainThreadBlockMs = 0;
    const observer = {
      recordTask(durationMs: number) {
        if (durationMs > maxMainThreadBlockMs) {
          maxMainThreadBlockMs = durationMs;
        }
      },
    };

    // Measure discrete chunks on main thread
    for (let i = 0; i < 10; i++) {
      const chunkStart = performance.now();
      await provider.suggest(SAMPLE_REQUEST);
      const chunkDuration = performance.now() - chunkStart;
      // End-to-end elapsed time is not a Long Tasks measurement; this only
      // catches an accidentally synchronous fake-provider regression.
      observer.recordTask(chunkDuration);
    }

    expect(maxMainThreadBlockMs).toBeLessThanOrEqual(200);
  });

  it('continues producing valid results across repeated fake-runtime calls', async () => {
    const adapter = new FakeModelRuntimeAdapter();
    adapter.isLoaded = true;

    const provider = new LocalSuggestionProvider(
      adapter,
      () => ({
        modelId: PERF_MANIFEST.modelId,
        modelVersion: PERF_MANIFEST.version,
      }),
      () => true,
    );

    for (let i = 0; i < 20; i++) {
      const result = await provider.suggest({
        ...SAMPLE_REQUEST,
        text: `Iteration ${i}: repeated test input ${i % 7}`,
      });
      if (!result) {
        fail('Fake provider unexpectedly returned no result.');
        continue;
      }
      expect(result.words.length + result.sentences.length).toBeGreaterThan(0);
    }
  });

  it('avoids download calls across five reconstructed managers', async () => {
    const metadataStore = new InMemoryModelMetadataStore();
    const storage = new InMemoryModelStorage();
    let networkDownloadCalls = 0;

    const mockApiClient = {
      getDefaultManifest: async () => PERF_MANIFEST,
      getSignedDownloadUrl: async () => {
        networkDownloadCalls++;
        return {
          url: 'https://test',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: PERF_MANIFEST.sizeBytes,
          sha256: PERF_MANIFEST.sha256,
          gcsGeneration: PERF_MANIFEST.gcsGeneration,
        };
      },
    };

    // 1. Initial installation
    await metadataStore.saveModel({
      modelId: PERF_MANIFEST.modelId,
      activeVersion: PERF_MANIFEST.version,
      lastKnownGoodVersion: PERF_MANIFEST.version,
      updatedAt: Date.now(),
    });
    await metadataStore.saveVersion({
      modelId: PERF_MANIFEST.modelId,
      version: PERF_MANIFEST.version,
      manifest: PERF_MANIFEST,
      fileName: `${PERF_MANIFEST.version}.litertlm`,
      partialFileName: `${PERF_MANIFEST.version}.partial`,
      sizeBytes: PERF_MANIFEST.sizeBytes,
      sha256: PERF_MANIFEST.sha256,
      gcsGeneration: PERF_MANIFEST.gcsGeneration,
      downloadOffset: PERF_MANIFEST.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    spyOn(storage, 'hasModel').and.resolveTo(true);
    spyOn(storage, 'getModelFileSize').and.resolveTo(PERF_MANIFEST.sizeBytes);
    spyOn(storage, 'openModelFile').and.resolveTo(
      new File([new Uint8Array(100)], `${PERF_MANIFEST.version}.litertlm`),
    );

    // 2. Simulate 5 consecutive page reloads
    for (let cycle = 1; cycle <= 5; cycle++) {
      const manager = new ModelManager({
        metadataStore,
        storage,
        tabCoordinator: new MockTabCoordinator(),
        apiClient: mockApiClient,
        runtimeAdapter: new FakeModelRuntimeAdapter(),
        webgpuChecker: async () => true,
        smokeTestHook: async () => true,
      });

      await manager.startup(true);
      expect(manager.getState()).toBe('ready');
    }

    expect(networkDownloadCalls).toBe(0);
  });
});
