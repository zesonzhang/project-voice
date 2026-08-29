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

import {ModelManifest} from './model-manifest.js';
import {
  GenerationOptions,
  ModelRuntimeAdapter,
  ProbeResult,
  RuntimeMetrics,
  RuntimeStatusEvent,
} from './model-runtime-adapter.js';
import {
  GenerationMetrics,
  isWorkerResponse,
  WORKER_PROTOCOL_VERSION,
  WorkerCapabilities,
  WorkerError,
  WorkerRequest,
  WorkerResponse,
  WorkerStatus,
} from './worker-protocol.js';

export interface WorkerClientOptions {
  workerFactory?: () => Worker;
  workerUrl?: string;
  loadTimeoutMs?: number;
  generationTimeoutMs?: number;
}

const DEFAULT_WORKER_URL = '/static/inference-worker.js';
const DEFAULT_LOAD_TIMEOUT_MS = 60000;

export class InferenceWorkerError extends Error {
  constructor(readonly detail: WorkerError) {
    super(detail.message);
    this.name = 'InferenceWorkerError';
  }
}

type DistributiveOmit<T, K extends string | number | symbol> = T extends unknown
  ? Omit<T, K>
  : never;

type WorkerRequestPayload = DistributiveOmit<
  WorkerRequest,
  'protocolVersion' | 'requestId'
>;

export class InferenceWorkerClient implements ModelRuntimeAdapter {
  readonly adapterId = 'litert-lm';

  private worker: Worker | null = null;
  private status: WorkerStatus = 'idle';
  private requestCounter = 0;
  private pendingRequests = new Map<
    string,
    {
      resolve: (response: WorkerResponse) => void;
      reject: (error: Error) => void;
      timeoutId?: number;
    }
  >();
  private activeStreamHandler:
    | ((chunk: {text: string; delta: string; sequenceId: number}) => void)
    | null = null;
  private lastMetrics: GenerationMetrics | null = null;
  private recentGenerations: Array<{completedAt: number; totalMs: number}> = [];
  private cancelPromise: Promise<void> | null = null;
  private statusListeners = new Set<(event: RuntimeStatusEvent) => void>();

  constructor(private readonly options: WorkerClientOptions = {}) {}

  getStatus(): WorkerStatus {
    return this.status;
  }

  onStatusChange(listener: (event: RuntimeStatusEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(event: RuntimeStatusEvent): void {
    this.status = event.status;
    for (const listener of this.statusListeners) listener(event);
  }

  private nextRequestId(): string {
    return `req-${++this.requestCounter}-${Date.now()}`;
  }

  private getWorker(): Worker {
    if (!this.worker) {
      if (this.options.workerFactory) {
        this.worker = this.options.workerFactory();
      } else {
        const url = this.options.workerUrl ?? DEFAULT_WORKER_URL;
        // LiteRT-LM 0.15 loads its Wasm glue through importScripts(), which is
        // unavailable in module workers. The bundled worker is an IIFE and
        // must therefore run as a classic worker.
        this.worker = new Worker(url);
      }
      this.worker.addEventListener('message', event => {
        this.handleWorkerMessage(event.data);
      });
      this.worker.addEventListener('error', errorEvent => {
        this.handleWorkerError(errorEvent);
      });
    }
    return this.worker;
  }

  private handleWorkerMessage(data: unknown): void {
    if (!isWorkerResponse(data)) {
      return;
    }

    if (data.type === 'STATUS') {
      this.setStatus({status: data.status});
      return;
    }

    if (data.type === 'PARTIAL_OUTPUT') {
      this.activeStreamHandler?.({
        text: data.text,
        delta: data.delta,
        sequenceId: data.sequenceId,
      });
      return;
    }

    if (data.type === 'GENERATION_COMPLETE') {
      this.lastMetrics = data.metrics;
      this.recentGenerations.push({
        completedAt: performance.now(),
        totalMs: data.metrics.totalMs,
      });
      this.setStatus({status: 'ready'});
      const pending = this.pendingRequests.get(data.requestId);
      if (pending) {
        if (pending.timeoutId) window.clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(data.requestId);
        pending.resolve(data);
      }
      return;
    }

    if (data.type === 'METRICS') {
      if (data.metrics) this.lastMetrics = data.metrics;
    }

    const pending = this.pendingRequests.get(data.requestId);
    if (pending) {
      if (pending.timeoutId) window.clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(data.requestId);
      if (data.type === 'ERROR') {
        this.setStatus({
          status: 'error',
          errorCode: data.error.code,
          errorMessage: data.error.message,
          recoverable: data.error.recoverable,
        });
        pending.reject(new InferenceWorkerError(data.error));
      } else {
        pending.resolve(data);
      }
    } else if (data.type === 'ERROR') {
      this.handleRuntimeFailure(new InferenceWorkerError(data.error));
    }
  }

  private handleRuntimeFailure(error: InferenceWorkerError): void {
    this.setStatus({
      status: 'error',
      errorCode: error.detail.code,
      errorMessage: error.message,
      recoverable: error.detail.recoverable,
    });
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.activeStreamHandler = null;
  }

  private handleWorkerError(errorEvent: ErrorEvent): void {
    this.setStatus({
      status: 'error',
      errorCode: 'WORKER_CRASHED',
      errorMessage: errorEvent.message,
      recoverable: true,
    });
    const error = new Error(`Inference Worker crashed: ${errorEvent.message}`);
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.activeStreamHandler = null;
    this.worker?.terminate();
    this.worker = null;
  }

  private postRequest<R extends WorkerResponse>(
    request: WorkerRequestPayload,
    timeoutMs = 15000,
  ): Promise<R> {
    const worker = this.getWorker();
    const requestId = this.nextRequestId();
    const fullRequest = {
      ...request,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      requestId,
    } as WorkerRequest;

    return new Promise<R>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Worker request timed out (${request.type})`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (res: WorkerResponse) => void,
        reject,
        timeoutId,
      });

      try {
        worker.postMessage(fullRequest);
      } catch (error) {
        window.clearTimeout(timeoutId);
        this.pendingRequests.delete(requestId);
        reject(error as Error);
      }
    });
  }

  async getCapabilities(): Promise<WorkerCapabilities> {
    const response = await this.postRequest<
      Extract<WorkerResponse, {type: 'CAPABILITIES'}>
    >({type: 'GET_CAPABILITIES'});
    return response.capabilities;
  }

  async probe(manifest: ModelManifest, file: File): Promise<ProbeResult> {
    if (manifest.adapterId !== this.adapterId) {
      return {
        supported: false,
        adapterId: manifest.adapterId,
        errorMessage: `Unsupported adapter ${manifest.adapterId}. Expected ${this.adapterId}.`,
      };
    }
    if (!file || file.size !== manifest.sizeBytes) {
      return {
        supported: false,
        adapterId: manifest.adapterId,
        errorMessage: `Model file size mismatch (expected ${manifest.sizeBytes}, found ${file?.size}).`,
      };
    }
    try {
      const capabilities = await this.getCapabilities();
      if (
        !capabilities.webGpu ||
        !capabilities.deviceAvailable ||
        capabilities.fallbackAdapter ||
        !capabilities.crossOriginIsolated
      ) {
        return {
          supported: false,
          adapterId: this.adapterId,
          errorMessage:
            'WebGPU device is not available in the worker environment.',
        };
      }
      return {
        supported: true,
        adapterId: this.adapterId,
      };
    } catch (err) {
      return {
        supported: false,
        adapterId: this.adapterId,
        errorMessage: (err as Error).message,
      };
    }
  }

  async load(manifest: ModelManifest, file: File): Promise<void> {
    this.setStatus({status: 'loading'});
    const timeout = this.options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    await this.postRequest(
      {
        type: 'LOAD_MODEL',
        manifest,
        file,
      },
      timeout,
    );
    const smokeTest = await this.postRequest<
      Extract<WorkerResponse, {type: 'SMOKE_TEST_RESULT'}>
    >({type: 'SMOKE_TEST', manifest}, timeout);
    if (!smokeTest.success) {
      this.setStatus({status: 'error', errorMessage: smokeTest.error});
      throw new Error(smokeTest.error ?? 'Runtime smoke test failed.');
    }
    this.setStatus({status: 'ready'});
  }

  async *generate(
    prompt: string,
    options: GenerationOptions,
  ): AsyncIterable<string> {
    if (this.status !== 'ready') {
      throw new Error(
        `Cannot generate while worker status is '${this.status}'.`,
      );
    }

    this.setStatus({status: 'generating'});
    const queue: string[] = [];
    let resolveNext: (() => void) | null = null;
    let isDone = false;
    let streamError: Error | null = null;

    this.activeStreamHandler = chunk => {
      if (chunk.sequenceId === options.sequenceId) {
        if (chunk.delta) {
          queue.push(chunk.delta);
          resolveNext?.();
        }
      }
    };

    const requestId = this.nextRequestId();
    const worker = this.getWorker();

    const signal = options.signal;
    if (signal?.aborted) {
      this.setStatus({status: 'ready'});
      return;
    }
    const abortHandler = () => {
      void this.cancel();
    };
    signal?.addEventListener('abort', abortHandler, {once: true});

    const generationTimeout = this.options.generationTimeoutMs ?? 120000;
    const timeoutId = window.setTimeout(() => {
      this.pendingRequests.delete(requestId);
      isDone = true;
      streamError = new Error('Worker request timed out (GENERATE)');
      this.setStatus({status: 'error', errorMessage: streamError.message});
      this.activeStreamHandler = null;
      resolveNext?.();
    }, generationTimeout);
    this.pendingRequests.set(requestId, {
      resolve: () => {
        isDone = true;
        this.activeStreamHandler = null;
        resolveNext?.();
      },
      reject: err => {
        isDone = true;
        streamError = err;
        this.activeStreamHandler = null;
        resolveNext?.();
      },
      timeoutId,
    });

    try {
      worker.postMessage({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId,
        type: 'GENERATE',
        sequenceId: options.sequenceId,
        prompt,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        topP: options.topP,
      } as WorkerRequest);
    } catch (error) {
      window.clearTimeout(timeoutId);
      this.pendingRequests.delete(requestId);
      isDone = true;
      streamError = error as Error;
      this.setStatus({
        status: 'error',
        errorMessage: streamError.message,
      });
    }

    try {
      while (!isDone || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (!isDone) {
          await new Promise<void>(resolve => {
            resolveNext = resolve;
          });
        }
      }
      if (streamError) {
        throw streamError;
      }
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      this.activeStreamHandler = null;
    }
  }

  async cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    if (this.status !== 'generating' && this.status !== 'canceling') return;

    this.setStatus({status: 'canceling'});
    this.cancelPromise = (async () => {
      try {
        await this.postRequest({type: 'CANCEL'}, 3000);
      } finally {
        this.setStatus({status: 'ready'});
        this.cancelPromise = null;
      }
    })();
    return this.cancelPromise;
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      try {
        await this.postRequest({type: 'UNLOAD_MODEL'}, 3000);
      } catch {
        // Ignore unload error during disposal
      }
      this.worker.terminate();
      this.worker = null;
    }
    this.setStatus({status: 'idle'});
    this.cancelPromise = null;
  }

  getMetrics(): RuntimeMetrics {
    const now = performance.now();
    this.recentGenerations = this.recentGenerations.filter(
      sample => now - sample.completedAt <= 60000,
    );
    const dutyCyclePercent = Math.min(
      100,
      this.recentGenerations.reduce((sum, sample) => sum + sample.totalMs, 0) /
        600,
    );
    if (!this.lastMetrics) {
      return {
        totalMs: 0,
        firstTokenMs: null,
        firstParsedSuggestionMs: null,
        outputCharacters: 0,
        tokensPerSecond: null,
        prefillTokensPerSecond: null,
        decodeTokensPerSecond: null,
        dutyCyclePercent,
      };
    }
    return {
      totalMs: this.lastMetrics.totalMs,
      firstTokenMs: this.lastMetrics.firstTokenMs,
      firstParsedSuggestionMs: this.lastMetrics.firstParsedSuggestionMs,
      outputCharacters: this.lastMetrics.outputCharacters,
      tokensPerSecond: this.lastMetrics.tokensPerSecond,
      prefillTokensPerSecond: this.lastMetrics.prefillTokensPerSecond,
      decodeTokensPerSecond: this.lastMetrics.decodeTokensPerSecond,
      dutyCyclePercent,
    };
  }
}
