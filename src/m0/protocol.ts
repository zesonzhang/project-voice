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

export const M0_PROTOCOL_VERSION = 1 as const;
export const LITERT_LM_VERSION = '0.15.0';
export const MODEL_STORAGE_PATH = ['project-voice', 'm0'];

export const CANDIDATE_MODEL = {
  id: 'gemma-4-e2b-it-web',
  filename: 'gemma-4-E2B-it-web.litertlm',
  byteSize: 2008432640,
  sha256: '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5',
  repository: 'litert-community/gemma-4-E2B-it-litert-lm',
  repositoryCommit: '6b78abd019e61a1ca4cbe3b212d2c9ce8ff38a94',
  license: 'Apache-2.0',
  url:
    'https://huggingface.co/litert-community/' +
    'gemma-4-E2B-it-litert-lm/resolve/' +
    '6b78abd019e61a1ca4cbe3b212d2c9ce8ff38a94/' +
    'gemma-4-E2B-it-web.litertlm',
} as const;

export type M0WorkerRequest =
  | BaseRequest<'GET_CAPABILITIES'>
  | BaseRequest<'GET_MODEL_INFO'>
  | (BaseRequest<'INSTALL_FILE'> & {file: File})
  | (BaseRequest<'INSTALL_URL'> & {url: string})
  | BaseRequest<'LOAD_MODEL'>
  | (BaseRequest<'GENERATE'> & {
      sequenceId: number;
      prompt: string;
      maxOutputTokens: number;
      temperature: number;
      topP: number;
    })
  | (BaseRequest<'CANCEL'> & {sequenceId: number})
  | BaseRequest<'UNLOAD_MODEL'>
  | BaseRequest<'REMOVE_MODEL'>;

interface BaseRequest<T extends string> {
  protocolVersion: typeof M0_PROTOCOL_VERSION;
  requestId: string;
  type: T;
}

export interface M0Capabilities {
  secureContext: boolean;
  worker: boolean;
  opfs: boolean;
  webGpu: boolean;
  adapterAvailable: boolean;
  deviceAvailable: boolean;
  crossOriginIsolated: boolean;
}

export interface M0ModelInfo {
  installed: boolean;
  byteSize: number;
  lastModified: number | null;
}

export interface M0GenerationMetrics {
  totalMs: number;
  firstTokenMs: number | null;
  firstParsedSuggestionMs: number | null;
  outputCharacters: number;
  parsedSuggestionCount: number;
  prefillTokensPerSecond: number | null;
  prefillTokenCount: number | null;
  decodeTokensPerSecond: number | null;
  decodeTokenCount: number | null;
  runtimeTimeToFirstTokenMs: number | null;
}

export type M0WorkerResponse =
  | (BaseResponse<'CAPABILITIES'> & {capabilities: M0Capabilities})
  | (BaseResponse<'MODEL_INFO'> & {model: M0ModelInfo})
  | (BaseResponse<'STATUS'> & {
      status: M0WorkerStatus;
      detail?: string;
    })
  | (BaseResponse<'INSTALL_PROGRESS'> & {
      loadedBytes: number;
      totalBytes: number;
    })
  | (BaseResponse<'MODEL_READY'> & {
      loadMs: number;
      source: 'opfs';
      modelBytes: number;
    })
  | (BaseResponse<'PARTIAL_OUTPUT'> & {
      sequenceId: number;
      text: string;
    })
  | (BaseResponse<'GENERATION_COMPLETE'> & {
      sequenceId: number;
      metrics: M0GenerationMetrics;
    })
  | (BaseResponse<'CANCELED'> & {sequenceId: number})
  | (BaseResponse<'DONE'> & {operation: string})
  | (BaseResponse<'ERROR'> & {error: M0WorkerError});

interface BaseResponse<T extends string> {
  protocolVersion: typeof M0_PROTOCOL_VERSION;
  requestId: string;
  type: T;
}

export type M0WorkerStatus =
  | 'idle'
  | 'downloading'
  | 'installing'
  | 'loading'
  | 'ready'
  | 'generating'
  | 'canceling'
  | 'disposing'
  | 'error';

export interface M0WorkerError {
  code:
    | 'INVALID_MESSAGE'
    | 'UNSUPPORTED'
    | 'MODEL_NOT_INSTALLED'
    | 'MODEL_MISMATCH'
    | 'DOWNLOAD_FAILED'
    | 'LOAD_FAILED'
    | 'GENERATION_FAILED'
    | 'CANCELED'
    | 'STORAGE_FAILED'
    | 'DISPOSE_FAILED'
    | 'UNKNOWN';
  message: string;
  phase: M0WorkerStatus;
  recoverable: boolean;
}

export function isM0WorkerRequest(value: unknown): value is M0WorkerRequest {
  if (!isObject(value)) return false;
  if (
    value.protocolVersion !== M0_PROTOCOL_VERSION ||
    typeof value.requestId !== 'string' ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  switch (value.type) {
    case 'GET_CAPABILITIES':
    case 'GET_MODEL_INFO':
    case 'LOAD_MODEL':
    case 'UNLOAD_MODEL':
    case 'REMOVE_MODEL':
      return true;
    case 'INSTALL_FILE':
      return value.file instanceof File;
    case 'INSTALL_URL':
      return typeof value.url === 'string';
    case 'GENERATE':
      return (
        Number.isInteger(value.sequenceId) &&
        (value.sequenceId as number) > 0 &&
        typeof value.prompt === 'string' &&
        value.prompt.length > 0 &&
        value.prompt.length <= 20000 &&
        Number.isInteger(value.maxOutputTokens) &&
        (value.maxOutputTokens as number) > 0 &&
        (value.maxOutputTokens as number) <= 512 &&
        isNumberInRange(value.temperature, 0, 2) &&
        isNumberInRange(value.topP, 0, 1)
      );
    case 'CANCEL':
      return (
        Number.isInteger(value.sequenceId) && (value.sequenceId as number) > 0
      );
    default:
      return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumberInRange(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}
