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
import {ModelManifest} from '../on-device/model-manifest.js';
import {InferenceWorkerClient} from '../on-device/worker-client.js';
import {
  isWorkerRequest,
  isWorkerResponse,
  WORKER_PROTOCOL_VERSION,
  WorkerRequest,
  WorkerResponse,
} from '../on-device/worker-protocol.js';
import {
  SuggestionProviderError,
  SuggestionRequest,
} from '../suggestion-provider.js';

const TEST_MANIFEST: ModelManifest = {
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

class ProtocolFakeWorker {
  readonly requests: WorkerRequest[] = [];
  terminated = false;
  private messageListeners: Array<(event: MessageEvent) => void> = [];
  private generationRequest: Extract<WorkerRequest, {type: 'GENERATE'}> | null =
    null;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === 'message') {
      this.messageListeners.push(
        listener as unknown as (event: MessageEvent) => void,
      );
    }
  }

  postMessage(request: WorkerRequest) {
    this.requests.push(request);
    if (request.type === 'LOAD_MODEL') {
      this.respond({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        type: 'MODEL_READY',
        loadMs: 1,
        modelBytes: request.file.size,
      });
    } else if (request.type === 'SMOKE_TEST') {
      this.respond({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        type: 'SMOKE_TEST_RESULT',
        success: true,
      });
    } else if (request.type === 'GENERATE') {
      this.generationRequest = request;
    } else if (request.type === 'CANCEL') {
      this.respond({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        type: 'DONE',
        operation: 'cancel',
      });
      if (this.generationRequest) {
        this.respond({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          requestId: this.generationRequest.requestId,
          type: 'CANCELED',
          sequenceId: this.generationRequest.sequenceId,
        });
        this.generationRequest = null;
      }
    } else if (request.type === 'UNLOAD_MODEL') {
      this.respond({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        type: 'DONE',
        operation: 'unload',
      });
    }
  }

  terminate() {
    this.terminated = true;
  }

  private respond(response: WorkerResponse) {
    const event = new MessageEvent('message', {data: response});
    for (const listener of this.messageListeners) listener(event);
  }
}

describe('M3 Runtime & Worker Protocol', () => {
  describe('Worker Protocol Validation', () => {
    it('validates legal WorkerRequest objects', () => {
      const validLoad: WorkerRequest = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId: 'req-1',
        type: 'LOAD_MODEL',
        manifest: TEST_MANIFEST,
        file: new File([new Uint8Array(10)], 'test.litertlm'),
      };
      expect(isWorkerRequest(validLoad)).toBeTrue();

      const validGenerate: WorkerRequest = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId: 'req-2',
        type: 'GENERATE',
        sequenceId: 1,
        prompt: 'test prompt',
      };
      expect(isWorkerRequest(validGenerate)).toBeTrue();

      const validCancel: WorkerRequest = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId: 'req-3',
        type: 'CANCEL',
        sequenceId: 1,
      };
      expect(isWorkerRequest(validCancel)).toBeTrue();
    });

    it('rejects malformed WorkerRequest objects', () => {
      expect(isWorkerRequest(null)).toBeFalse();
      expect(isWorkerRequest({})).toBeFalse();
      expect(
        isWorkerRequest({
          protocolVersion: 999,
          requestId: 'req-1',
          type: 'GET_CAPABILITIES',
        }),
      ).toBeFalse();
      expect(
        isWorkerRequest({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          requestId: 'req-1',
          type: 'GENERATE',
          sequenceId: -1, // Invalid sequenceId
          prompt: 'test',
        }),
      ).toBeFalse();
    });

    it('validates legal WorkerResponse objects', () => {
      const validStatus: WorkerResponse = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId: 'req-1',
        type: 'STATUS',
        status: 'ready',
      };
      expect(isWorkerResponse(validStatus)).toBeTrue();

      const validPartial: WorkerResponse = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId: 'req-2',
        type: 'PARTIAL_OUTPUT',
        sequenceId: 1,
        text: 'hello',
        delta: 'hello',
      };
      expect(isWorkerResponse(validPartial)).toBeTrue();
      expect(
        isWorkerResponse({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          requestId: 'req-3',
          type: 'GENERATION_COMPLETE',
        }),
      ).toBeFalse();
    });
  });

  describe('InferenceWorkerClient', () => {
    it('runs the real runtime smoke test after loading the model', async () => {
      const worker = new ProtocolFakeWorker();
      const client = new InferenceWorkerClient({
        workerFactory: () => worker as unknown as Worker,
      });
      const file = new File([new Uint8Array(16)], 'model.litertlm');
      const manifest = {...TEST_MANIFEST, sizeBytes: file.size};

      await client.load(manifest, file);

      expect(worker.requests.map(request => request.type)).toEqual([
        'LOAD_MODEL',
        'SMOKE_TEST',
      ]);
      expect(client.getStatus()).toBe('ready');
      await client.dispose();
      expect(worker.terminated).toBeTrue();
    });

    it('coalesces overlapping cancellation calls before new generation', async () => {
      const worker = new ProtocolFakeWorker();
      const client = new InferenceWorkerClient({
        workerFactory: () => worker as unknown as Worker,
      });
      const file = new File([new Uint8Array(16)], 'model.litertlm');
      const manifest = {...TEST_MANIFEST, sizeBytes: file.size};
      await client.load(manifest, file);

      const controller = new AbortController();
      const iterator = client
        .generate('first request', {sequenceId: 1, signal: controller.signal})
        [Symbol.asyncIterator]();
      const pendingRead = iterator.next();
      controller.abort();
      await client.cancel();

      expect((await pendingRead).done).toBeTrue();
      expect(client.getStatus()).toBe('ready');
      const cancelRequests = worker.requests.filter(
        request => request.type === 'CANCEL',
      );
      expect(cancelRequests.length).toBe(1);
    });
  });

  describe('FakeModelRuntimeAdapter', () => {
    it('probes, loads, and generates suggestions', async () => {
      const adapter = new FakeModelRuntimeAdapter();
      const fakeFile = new File(
        [new Uint8Array(TEST_MANIFEST.sizeBytes)],
        'model.litertlm',
      );

      const probeResult = await adapter.probe(TEST_MANIFEST, fakeFile);
      expect(probeResult.supported).toBeTrue();

      await adapter.load(TEST_MANIFEST, fakeFile);
      expect(adapter.isLoaded).toBeTrue();

      const chunks: string[] = [];
      for await (const chunk of adapter.generate('test word prompt', {
        sequenceId: 1,
      })) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join('')).toContain('localword');

      const metrics = adapter.getMetrics();
      expect(metrics.totalMs).toBeGreaterThan(0);
      expect(metrics.tokensPerSecond).toBeGreaterThan(0);
    });

    it('rejects generation when not loaded', async () => {
      const adapter = new FakeModelRuntimeAdapter();
      let error: Error | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of adapter.generate('prompt', {sequenceId: 1})) {
          // should not reach
        }
      } catch (err) {
        error = err as Error;
      }
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Model is not loaded');
    });

    it('handles cancellation signal during generation', async () => {
      const adapter = new FakeModelRuntimeAdapter({streamDelayMs: 20});
      const fakeFile = new File(
        [new Uint8Array(TEST_MANIFEST.sizeBytes)],
        'model.litertlm',
      );
      await adapter.load(TEST_MANIFEST, fakeFile);

      const controller = new AbortController();
      const generator = adapter.generate('test sentence prompt', {
        sequenceId: 1,
        signal: controller.signal,
      });

      const firstResult = await generator[Symbol.asyncIterator]().next();
      expect(firstResult.done).toBeFalse();

      controller.abort();
      const secondResult = await generator[Symbol.asyncIterator]().next();
      expect(secondResult.done).toBeTrue();
      expect(adapter.isCancelled).toBeTrue();
    });
  });

  describe('LocalSuggestionProvider with RuntimeAdapter', () => {
    const sampleRequest: SuggestionRequest = {
      text: 'hello',
      language: 'English',
      cloudModel: 'gemini_3_flash',
      sentencePromptId: 'SentenceGeneric20260130',
      wordPromptId: 'WordGeneric20240628',
      persona: 'friendly assistant',
      lastOutputSpeech: '',
      lastInputSpeech: '',
      conversationHistory: '',
      sentenceEmotion: '',
    };

    it('serializes generation: words first, sentences second', async () => {
      const generatedPrompts: string[] = [];
      const adapter = new FakeModelRuntimeAdapter({
        generateHandler: async (prompt: string) => {
          generatedPrompts.push(prompt);
          if (generatedPrompts.length === 1) {
            return '1. hi\n2. help\n3. here';
          }
          return '1. Hello how are you?\n2. Hello there.';
        },
      });
      await adapter.load(TEST_MANIFEST, new File([], 'model.litertlm'));

      const partialResults: string[][] = [];
      const provider = new LocalSuggestionProvider(
        adapter,
        () => ({modelId: 'gemma-4-e2b', modelVersion: '2026-08-01'}),
        () => true,
      );

      const result = await provider.suggest(sampleRequest, partial => {
        partialResults.push(partial.words);
      });

      expect(result).not.toBeNull();
      expect(result?.words).toEqual(['hi', 'help', 'here']);
      expect(result?.sentences).toEqual(['Hello how are you?', 'Hello there.']);
      expect(result?.provider).toBe('local');
      expect(partialResults.length).toBe(1);
      expect(partialResults[0]).toEqual(['hi', 'help', 'here']);

      // Assert words prompt ran before sentence prompt
      expect(generatedPrompts.length).toBe(2);
      expect(generatedPrompts[0]).toContain('words');
      expect(generatedPrompts[1]).toContain('sentences');
    });

    it('throws SuggestionProviderError when provider is not ready', async () => {
      const adapter = new FakeModelRuntimeAdapter();
      const provider = new LocalSuggestionProvider(
        adapter,
        () => ({modelId: 'gemma', modelVersion: '1'}),
        () => false, // Not ready
      );

      let error: SuggestionProviderError | null = null;
      try {
        await provider.suggest(sampleRequest);
      } catch (err) {
        error = err as SuggestionProviderError;
      }

      expect(error).not.toBeNull();
      expect(error?.code).toBe('local_unavailable');
      expect(error?.message).toContain('Local model is not loaded or ready');
    });

    it('cancels active generation when abort is called', async () => {
      const adapter = new FakeModelRuntimeAdapter({streamDelayMs: 50});
      await adapter.load(TEST_MANIFEST, new File([], 'model.litertlm'));
      const provider = new LocalSuggestionProvider(adapter);

      const suggestPromise = provider.suggest(sampleRequest);
      await new Promise(resolve => window.setTimeout(resolve, 10));

      provider.abort();
      const result = await suggestPromise;
      expect(result).toBeNull();
      expect(adapter.isCancelled).toBeTrue();
    });

    it('keeps only the latest request while cancellation is settling', async () => {
      const adapter = new FakeModelRuntimeAdapter({streamDelayMs: 20});
      await adapter.load(TEST_MANIFEST, new File([], 'model.litertlm'));
      const provider = new LocalSuggestionProvider(adapter);

      const first = provider.suggest(sampleRequest);
      await new Promise(resolve => window.setTimeout(resolve, 5));
      const second = provider.suggest({...sampleRequest, text: 'new input'});

      expect(await first).toBeNull();
      const latest = await second;
      expect(latest).not.toBeNull();
      expect(latest?.words).toContain('localword');
    });
  });
});
