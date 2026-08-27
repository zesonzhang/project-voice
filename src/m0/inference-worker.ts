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

import {OpfsModelStore} from './opfs-model-store.js';
import {parseNumberedSuggestions} from './parse-output.js';
import {
  CANDIDATE_MODEL,
  isM0WorkerRequest,
  M0_PROTOCOL_VERSION,
  M0Capabilities,
  M0GenerationMetrics,
  M0WorkerError,
  M0WorkerRequest,
  M0WorkerResponse,
  M0WorkerStatus,
} from './protocol.js';

const WASM_PATH = '/static/vendor/litert-lm/wasm/';
const store = new OpfsModelStore();
let engine: Engine | null = null;
let runtimeLoaded = false;
let status: M0WorkerStatus = 'idle';
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
  if (!isM0WorkerRequest(data)) {
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
      case 'GET_MODEL_INFO':
        post(data.requestId, 'MODEL_INFO', {model: await store.getInfo()});
        return;
      case 'INSTALL_FILE':
        await installFile(data);
        return;
      case 'INSTALL_URL':
        await installUrl(data);
        return;
      case 'LOAD_MODEL':
        await loadModel(data.requestId);
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
      case 'REMOVE_MODEL':
        await disposeEngine();
        await store.remove();
        post(data.requestId, 'DONE', {operation: 'remove'});
        return;
    }
  } catch (error) {
    status = 'error';
    postError(data.requestId, toWorkerError(error, data.type));
  }
}

async function getCapabilities(): Promise<M0Capabilities> {
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
            code: 'LOAD_FAILED',
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
    opfs: typeof navigator.storage?.getDirectory === 'function',
    webGpu: navigatorWithGpu.gpu !== undefined,
    adapterAvailable,
    deviceAvailable,
    crossOriginIsolated: self.crossOriginIsolated,
  };
}

async function installFile(
  request: Extract<M0WorkerRequest, {type: 'INSTALL_FILE'}>,
): Promise<void> {
  status = 'installing';
  post(request.requestId, 'STATUS', {status});
  await store.installFile(
    request.file,
    createProgressReporter(request.requestId, request.file.size),
  );
  status = 'idle';
  post(request.requestId, 'DONE', {operation: 'install-file'});
}

async function installUrl(
  request: Extract<M0WorkerRequest, {type: 'INSTALL_URL'}>,
): Promise<void> {
  if (request.url !== CANDIDATE_MODEL.url) {
    throw new Error('Only the frozen M0 candidate URL is accepted.');
  }
  status = 'downloading';
  post(request.requestId, 'STATUS', {status});
  await store.installUrl(
    request.url,
    createProgressReporter(request.requestId, CANDIDATE_MODEL.byteSize),
  );
  status = 'idle';
  post(request.requestId, 'DONE', {operation: 'install-url'});
}

async function loadModel(requestId: string): Promise<void> {
  await disposeEngine();
  const capabilities = await getCapabilities();
  if (!capabilities.secureContext || !capabilities.opfs) {
    throw new Error('A secure context with OPFS is required.');
  }
  if (!capabilities.deviceAvailable) {
    throw new Error('A working WebGPU adapter and device are required.');
  }
  const file = await store.open();
  if (file.size !== CANDIDATE_MODEL.byteSize) {
    throw new Error(
      `Installed model has ${file.size} bytes; expected ` +
        `${CANDIDATE_MODEL.byteSize}.`,
    );
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
    source: 'opfs',
    modelBytes: file.size,
  });
}

async function generate(
  request: Extract<M0WorkerRequest, {type: 'GENERATE'}>,
): Promise<void> {
  if (!engine) throw new Error('Load the model before generating.');
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
        maxOutputTokens: request.maxOutputTokens,
        samplerParams: {
          temperature: request.temperature,
          p: request.topP,
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
        if (
          firstParsedSuggestionMs === null &&
          parseNumberedSuggestions(text).length > 0
        ) {
          firstParsedSuggestionMs = elapsed;
        }
        post(request.requestId, 'PARTIAL_OUTPUT', {
          sequenceId: request.sequenceId,
          text,
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
    const metrics: M0GenerationMetrics = {
      totalMs: performance.now() - startedAt,
      firstTokenMs,
      firstParsedSuggestionMs,
      outputCharacters: text.length,
      parsedSuggestionCount: parseNumberedSuggestions(text).length,
      prefillTokensPerSecond: finiteOrNull(
        benchmark.lastPrefillTokensPerSecond,
      ),
      prefillTokenCount: finiteOrNull(benchmark.lastPrefillTokenCount),
      decodeTokensPerSecond: finiteOrNull(benchmark.lastDecodeTokensPerSecond),
      decodeTokenCount: finiteOrNull(benchmark.lastDecodeTokenCount),
      runtimeTimeToFirstTokenMs:
        finiteOrNull(benchmark.timeToFirstTokenInSecond) === null
          ? null
          : benchmark.timeToFirstTokenInSecond * 1000,
    };
    post(request.requestId, 'GENERATION_COMPLETE', {
      sequenceId: request.sequenceId,
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
  if (!activeGeneration || sequenceId !== activeGeneration.sequenceId) return;
  status = 'canceling';
  activeGeneration.canceled = true;
  activeGeneration.conversation?.cancel();
}

async function disposeEngine(): Promise<void> {
  const generation = activeGeneration;
  cancelGeneration(generation?.sequenceId);
  await generation?.done;
  if (!engine) return;
  status = 'disposing';
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

function createProgressReporter(
  requestId: string,
  totalBytes: number,
): (loadedBytes: number) => void {
  let lastReportAt = 0;
  return loadedBytes => {
    const now = performance.now();
    if (loadedBytes !== totalBytes && now - lastReportAt < 250) return;
    lastReportAt = now;
    post(requestId, 'INSTALL_PROGRESS', {loadedBytes, totalBytes});
  };
}

function post<T extends M0WorkerResponse['type']>(
  requestId: string,
  type: T,
  payload: Omit<Extract<M0WorkerResponse, {type: T}>, keyof BaseResponse>,
): void {
  self.postMessage({
    protocolVersion: M0_PROTOCOL_VERSION,
    requestId,
    type,
    ...payload,
  });
}

interface BaseResponse {
  protocolVersion: number;
  requestId: string;
  type: string;
}

function postError(requestId: string, error: M0WorkerError): void {
  self.postMessage({
    protocolVersion: M0_PROTOCOL_VERSION,
    requestId,
    type: 'ERROR',
    error,
  } satisfies M0WorkerResponse);
}

function toWorkerError(
  error: unknown,
  operation: M0WorkerRequest['type'],
): M0WorkerError {
  const message = error instanceof Error ? error.message : String(error);
  let code: M0WorkerError['code'] = 'UNKNOWN';
  if (message.includes('Expected') || message.includes('frozen')) {
    code = 'MODEL_MISMATCH';
  } else if (
    message.includes('not found') ||
    errorName(error) === 'NotFoundError'
  ) {
    code = 'MODEL_NOT_INSTALLED';
  } else if (operation === 'INSTALL_URL') {
    code = 'DOWNLOAD_FAILED';
  } else if (operation === 'INSTALL_FILE' || operation === 'REMOVE_MODEL') {
    code = 'STORAGE_FAILED';
  } else if (operation === 'LOAD_MODEL') {
    code = message.includes('required') ? 'UNSUPPORTED' : 'LOAD_FAILED';
  } else if (operation === 'GENERATE') {
    code = 'GENERATION_FAILED';
  } else if (operation === 'UNLOAD_MODEL') {
    code = 'DISPOSE_FAILED';
  }
  return {code, message, phase: status, recoverable: true};
}

function errorName(error: unknown): string | undefined {
  return error instanceof DOMException ? error.name : undefined;
}
