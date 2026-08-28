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

import {Conversation, Engine, loadLiteRtLm, Message} from '@litert-lm/core';

import {
  GenerationMetrics,
  isWorkerRequest,
  WORKER_PROTOCOL_VERSION,
  WorkerCapabilities,
  WorkerError,
  WorkerRequest,
  WorkerResponse,
  WorkerStatus,
} from './worker-protocol.js';

const WASM_PATH = '/static/vendor/litert-lm/wasm/';

let engine: Engine | null = null;
let runtimeLoaded = false;
let status: WorkerStatus = 'idle';
let activeGeneration: ActiveGeneration | null = null;
let probeDevice: GpuDevice | null = null;

interface ActiveGeneration {
  sequenceId: number;
  requestId: string;
  conversation: Conversation | null;
  canceled: boolean;
  done: Promise<void>;
  finish: () => void;
}

interface GpuDevice {
  destroy(): void;
  lost: Promise<{message?: string}>;
}

interface GpuAdapter {
  requestDevice(): Promise<GpuDevice>;
}

interface NavigatorGpu {
  requestAdapter(): Promise<GpuAdapter | null>;
}

self.addEventListener('message', event => {
  void handleMessage(event.data);
});

async function handleMessage(data: unknown): Promise<void> {
  if (!isWorkerRequest(data)) {
    postError('unknown', {
      code: 'INVALID_MESSAGE',
      message: 'The Worker request did not match protocol version 1.',
      phase: status,
      recoverable: true,
    });
    return;
  }

  try {
    switch (data.type) {
      case 'GET_CAPABILITIES':
        post(data.requestId, 'CAPABILITIES', {
          capabilities: await getCapabilities(),
        });
        return;
      case 'LOAD_MODEL':
        await loadModel(data.requestId, data.file);
        return;
      case 'GENERATE':
        await generate(data);
        return;
      case 'CANCEL':
        cancelGeneration(data.sequenceId);
        post(data.requestId, 'DONE', {operation: 'cancel'});
        return;
      case 'UNLOAD_MODEL':
        await disposeEngine();
        post(data.requestId, 'DONE', {operation: 'unload'});
        return;
      case 'SMOKE_TEST':
        await runSmokeTest(data.requestId);
        return;
      case 'GET_METRICS':
        post(data.requestId, 'METRICS', {
          metrics: null,
        });
        return;
    }
  } catch (error) {
    status = 'error';
    postError(data.requestId, toWorkerError(error, data.type));
  }
}

async function getCapabilities(): Promise<WorkerCapabilities> {
  const navigatorWithGpu = navigator as Navigator & {gpu?: NavigatorGpu};
  let adapterAvailable = false;
  let deviceAvailable = false;
  if (navigatorWithGpu.gpu) {
    const adapter = await navigatorWithGpu.gpu.requestAdapter();
    adapterAvailable = adapter !== null;
    if (adapter) {
      try {
        probeDevice ??= await adapter.requestDevice();
        deviceAvailable = true;
        void probeDevice.lost.then(info => {
          cancelGeneration(activeGeneration?.sequenceId);
          status = 'error';
          postError('device-loss', {
            code: 'WEBGPU_DEVICE_LOST',
            message: `WebGPU device lost: ${info.message || 'unknown reason'}`,
            phase: 'error',
            recoverable: true,
          });
        });
      } catch {
        deviceAvailable = false;
      }
    }
  }
  return {
    secureContext: self.isSecureContext,
    worker: true,
    webGpu: navigatorWithGpu.gpu !== undefined,
    adapterAvailable,
    deviceAvailable,
    crossOriginIsolated: self.crossOriginIsolated,
  };
}

async function loadModel(requestId: string, file: File): Promise<void> {
  await disposeEngine();
  const capabilities = await getCapabilities();
  if (!capabilities.secureContext) {
    throw new Error('A secure context is required for on-device inference.');
  }
  if (!capabilities.deviceAvailable) {
    throw new Error('A working WebGPU adapter and device are required.');
  }
  if (!file || file.size <= 0) {
    throw new Error('Invalid or empty model file provided.');
  }

  status = 'loading';
  post(requestId, 'STATUS', {status});
  const startedAt = performance.now();
  if (!runtimeLoaded) {
    await loadLiteRtLm(WASM_PATH);
    runtimeLoaded = true;
  }
  engine = await Engine.create({
    model: file,
    benchmarkEnabled: true,
    mainExecutorSettings: {maxNumTokens: 2048},
  });
  status = 'ready';
  post(requestId, 'MODEL_READY', {
    loadMs: performance.now() - startedAt,
    modelBytes: file.size,
  });
}

async function runSmokeTest(requestId: string): Promise<void> {
  if (!engine) {
    post(requestId, 'SMOKE_TEST_RESULT', {
      success: false,
      error: 'Model is not loaded.',
    });
    return;
  }
  try {
    const conversation = await engine.createConversation({
      sessionConfig: {
        maxOutputTokens: 16,
        samplerParams: {temperature: 0, p: 0.1},
      },
    });
    const stream = conversation.sendMessageStreaming('hi');
    const reader = stream.getReader();
    try {
      let output = '';
      while (!output) {
        const result = await reader.read();
        if (result.done) break;
        output += extractText(result.value);
      }
      if (!output.trim()) {
        throw new Error('Model produced no text for the smoke prompt.');
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await conversation.delete().catch(() => undefined);
    }
    post(requestId, 'SMOKE_TEST_RESULT', {success: true});
  } catch (err) {
    post(requestId, 'SMOKE_TEST_RESULT', {
      success: false,
      error: (err as Error).message,
    });
  }
}

async function generate(
  request: Extract<WorkerRequest, {type: 'GENERATE'}>,
): Promise<void> {
  if (!engine) {
    throw new Error('Load the model before generating suggestions.');
  }
  const previousGeneration = activeGeneration;
  cancelGeneration(previousGeneration?.sequenceId);
  await previousGeneration?.done;

  let finishGeneration: () => void = () => {
    throw new Error('Generation completion callback was not initialized.');
  };
  const generationDone = new Promise<void>(resolve => {
    finishGeneration = resolve;
  });

  const generation: ActiveGeneration = {
    sequenceId: request.sequenceId,
    requestId: request.requestId,
    conversation: null,
    canceled: false,
    done: generationDone,
    finish: finishGeneration,
  };
  activeGeneration = generation;
  status = 'generating';
  post(request.requestId, 'STATUS', {status});

  const startedAt = performance.now();
  let firstTokenMs: number | null = null;
  let firstParsedSuggestionMs: number | null = null;
  let text = '';
  try {
    generation.conversation = await engine.createConversation({
      sessionConfig: {
        maxOutputTokens: request.maxOutputTokens ?? 256,
        samplerParams: {
          temperature: request.temperature ?? 0,
          p: request.topP ?? 0.5,
        },
      },
    });
    if (generation.canceled) return;

    const stream = generation.conversation.sendMessageStreaming(request.prompt);
    const reader = stream.getReader();
    try {
      let done = false;
      while (!done) {
        const readResult = await reader.read();
        if (readResult.done) {
          done = true;
          continue;
        }
        const chunk = readResult.value;
        if (generation.canceled || activeGeneration !== generation) break;
        const delta = extractText(chunk);
        if (!delta) continue;
        text += delta;
        const elapsed = performance.now() - startedAt;
        firstTokenMs ??= elapsed;
        if (firstParsedSuggestionMs === null && text.includes('1.')) {
          firstParsedSuggestionMs = elapsed;
        }
        post(request.requestId, 'PARTIAL_OUTPUT', {
          sequenceId: request.sequenceId,
          text,
          delta,
        });
      }
    } finally {
      reader.releaseLock();
    }

    if (generation.canceled || activeGeneration !== generation) {
      post(request.requestId, 'CANCELED', {
        sequenceId: request.sequenceId,
      });
      return;
    }

    const benchmark = await generation.conversation.getBenchmarkInfo();
    const metrics: GenerationMetrics = {
      totalMs: performance.now() - startedAt,
      firstTokenMs,
      firstParsedSuggestionMs,
      outputCharacters: text.length,
      tokensPerSecond: finiteOrNull(benchmark.lastDecodeTokensPerSecond),
      prefillTokensPerSecond: finiteOrNull(
        benchmark.lastPrefillTokensPerSecond,
      ),
      decodeTokensPerSecond: finiteOrNull(benchmark.lastDecodeTokensPerSecond),
    };
    post(request.requestId, 'GENERATION_COMPLETE', {
      sequenceId: request.sequenceId,
      text,
      metrics,
    });
  } catch (error) {
    if (generation.canceled) {
      post(request.requestId, 'CANCELED', {
        sequenceId: request.sequenceId,
      });
      return;
    }
    throw error;
  } finally {
    await generation.conversation?.delete().catch(() => undefined);
    if (activeGeneration === generation) {
      activeGeneration = null;
      status = engine ? 'ready' : 'idle';
    }
    generation.finish();
  }
}

function cancelGeneration(sequenceId: number | undefined): void {
  if (!activeGeneration) return;
  if (sequenceId !== undefined && sequenceId !== activeGeneration.sequenceId) {
    return;
  }
  status = 'canceling';
  activeGeneration.canceled = true;
  activeGeneration.conversation?.cancel();
}

async function disposeEngine(): Promise<void> {
  const generation = activeGeneration;
  cancelGeneration(generation?.sequenceId);
  await generation?.done;
  if (!engine) return;
  const current = engine;
  engine = null;
  await current.delete();
  status = 'idle';
}

function extractText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(item => item.type === 'text')
    .map(item => ('text' in item ? item.text : ''))
    .join('');
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function post<T extends WorkerResponse['type']>(
  requestId: string,
  type: T,
  payload: Omit<
    Extract<WorkerResponse, {type: T}>,
    'protocolVersion' | 'requestId' | 'type'
  >,
): void {
  self.postMessage({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    requestId,
    type,
    ...payload,
  });
}

function postError(requestId: string, error: WorkerError): void {
  self.postMessage({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    requestId,
    type: 'ERROR',
    error,
  } satisfies WorkerResponse);
}

function toWorkerError(
  error: unknown,
  operation: WorkerRequest['type'],
): WorkerError {
  const message = error instanceof Error ? error.message : String(error);
  let code: WorkerError['code'] = 'UNKNOWN';
  if (operation === 'LOAD_MODEL') {
    code = message.includes('required') ? 'UNSUPPORTED' : 'LOAD_FAILED';
  } else if (operation === 'GENERATE') {
    code = 'GENERATION_FAILED';
  }
  return {code, message, phase: status, recoverable: true};
}
