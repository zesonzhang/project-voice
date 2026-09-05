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

export const WORKER_PROTOCOL_VERSION = 1 as const;
export const LITERT_LM_VERSION = '0.15.0';

export type WorkerStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'generating'
  | 'canceling'
  | 'error';

export type WorkerErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNSUPPORTED'
  | 'MODEL_NOT_LOADED'
  | 'LOAD_FAILED'
  | 'GENERATION_FAILED'
  | 'CANCELED'
  | 'WEBGPU_DEVICE_LOST'
  | 'UNKNOWN';

export interface WorkerError {
  code: WorkerErrorCode;
  message: string;
  phase: WorkerStatus;
  recoverable: boolean;
}

export interface WorkerCapabilities {
  secureContext: boolean;
  worker: boolean;
  webGpu: boolean;
  adapterAvailable: boolean;
  fallbackAdapter: boolean;
  deviceAvailable: boolean;
  crossOriginIsolated: boolean;
}

export interface GenerationMetrics {
  totalMs: number;
  firstTokenMs: number | null;
  firstParsedSuggestionMs: number | null;
  outputCharacters: number;
  tokensPerSecond: number | null;
  prefillTokensPerSecond: number | null;
  decodeTokensPerSecond: number | null;
}

interface BaseRequest<T extends string> {
  protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  requestId: string;
  type: T;
}

export type WorkerRequest =
  | BaseRequest<'GET_CAPABILITIES'>
  | (BaseRequest<'LOAD_MODEL'> & {
      file: File;
      manifest: ModelManifest;
    })
  | BaseRequest<'UNLOAD_MODEL'>
  | (BaseRequest<'GENERATE'> & {
      sequenceId: number;
      prompt: string;
      maxOutputTokens?: number;
      temperature?: number;
      topP?: number;
    })
  | (BaseRequest<'CANCEL'> & {
      sequenceId?: number;
    })
  | (BaseRequest<'SMOKE_TEST'> & {
      manifest?: ModelManifest;
    })
  | BaseRequest<'GET_METRICS'>;

interface BaseResponse<T extends string> {
  protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  requestId: string;
  type: T;
}

export type WorkerResponse =
  | (BaseResponse<'CAPABILITIES'> & {capabilities: WorkerCapabilities})
  | (BaseResponse<'STATUS'> & {status: WorkerStatus; detail?: string})
  | (BaseResponse<'MODEL_READY'> & {loadMs: number; modelBytes: number})
  | (BaseResponse<'PARTIAL_OUTPUT'> & {
      sequenceId: number;
      text: string;
      delta: string;
    })
  | (BaseResponse<'GENERATION_COMPLETE'> & {
      sequenceId: number;
      text: string;
      metrics: GenerationMetrics;
    })
  | (BaseResponse<'CANCELED'> & {sequenceId: number})
  | (BaseResponse<'SMOKE_TEST_RESULT'> & {success: boolean; error?: string})
  | (BaseResponse<'METRICS'> & {metrics: GenerationMetrics | null})
  | (BaseResponse<'DONE'> & {operation: string})
  | (BaseResponse<'ERROR'> & {error: WorkerError});

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isObject(value)) return false;
  if (
    value.protocolVersion !== WORKER_PROTOCOL_VERSION ||
    typeof value.requestId !== 'string' ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  switch (value.type) {
    case 'GET_CAPABILITIES':
    case 'UNLOAD_MODEL':
    case 'GET_METRICS':
      return true;
    case 'LOAD_MODEL':
      return value.file instanceof File && isObject(value.manifest);
    case 'GENERATE':
      return (
        Number.isInteger(value.sequenceId) &&
        (value.sequenceId as number) > 0 &&
        typeof value.prompt === 'string' &&
        value.prompt.length > 0
      );
    case 'CANCEL':
      return (
        value.sequenceId === undefined ||
        (Number.isInteger(value.sequenceId) && (value.sequenceId as number) > 0)
      );
    case 'SMOKE_TEST':
      return true;
    default:
      return false;
  }
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isObject(value)) return false;
  if (
    value.protocolVersion !== WORKER_PROTOCOL_VERSION ||
    typeof value.requestId !== 'string' ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  switch (value.type) {
    case 'CAPABILITIES':
      return isObject(value.capabilities);
    case 'STATUS':
      return isWorkerStatus(value.status);
    case 'MODEL_READY':
      return (
        typeof value.loadMs === 'number' && typeof value.modelBytes === 'number'
      );
    case 'PARTIAL_OUTPUT':
      return (
        Number.isInteger(value.sequenceId) &&
        typeof value.text === 'string' &&
        typeof value.delta === 'string'
      );
    case 'GENERATION_COMPLETE':
      return (
        Number.isInteger(value.sequenceId) &&
        typeof value.text === 'string' &&
        isObject(value.metrics)
      );
    case 'CANCELED':
      return Number.isInteger(value.sequenceId);
    case 'SMOKE_TEST_RESULT':
      return typeof value.success === 'boolean';
    case 'METRICS':
      return value.metrics === null || isObject(value.metrics);
    case 'DONE':
      return typeof value.operation === 'string';
    case 'ERROR':
      return (
        isObject(value.error) &&
        typeof value.error.code === 'string' &&
        typeof value.error.message === 'string' &&
        isWorkerStatus(value.error.phase) &&
        typeof value.error.recoverable === 'boolean'
      );
    default:
      return false;
  }
}

function isWorkerStatus(value: unknown): value is WorkerStatus {
  return (
    typeof value === 'string' &&
    ['idle', 'loading', 'ready', 'generating', 'canceling', 'error'].includes(
      value,
    )
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
