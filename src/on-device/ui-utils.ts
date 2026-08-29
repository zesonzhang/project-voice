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

import {msg} from '@lit/localize';

import {ModelErrorCode, ModelLifecycleState} from './model-lifecycle.js';

/** Formats byte counts into human-readable strings (B, KB, MB, GB, TB). */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 2 : 0)} ${units[i]}`;
}

/** Formats transfer speeds into MB/s. */
export function formatSpeed(bps: number): string {
  if (!bps || bps <= 0) return '0 MB/s';
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

/** Formats a ModelLifecycleState into a localized user-facing status label. */
export function formatLifecycleState(state: ModelLifecycleState): string {
  switch (state) {
    case 'unsupported':
      return msg('Hardware Unsupported');
    case 'not_downloaded':
      return msg('Download Required');
    case 'downloading':
      return msg('Downloading...');
    case 'verifying':
      return msg('Verifying Checksum...');
    case 'downloaded':
      return msg('Ready to Load');
    case 'loading':
      return msg('Loading into WebGPU...');
    case 'ready':
      return msg('Ready (Active)');
    case 'generating':
      return msg('Generating...');
    case 'update_available':
      return msg('Update Available');
    case 'error':
      return msg('Error');
    default:
      return state;
  }
}

/** Resolves the CSS badge style class for a model lifecycle state. */
export function getBadgeClass(state: ModelLifecycleState): string {
  switch (state) {
    case 'ready':
    case 'generating':
      return 'badge-ready';
    case 'downloading':
    case 'verifying':
    case 'loading':
    case 'update_available':
      return 'badge-active';
    case 'error':
    case 'unsupported':
      return 'badge-error';
    default:
      return 'badge-neutral';
  }
}

/** Translates structured ModelErrorCode into an actionable user-facing message. */
export function getActionableErrorMessage(code?: ModelErrorCode): string {
  switch (code) {
    case 'ERR_WEBGPU_UNSUPPORTED':
      return msg('WebGPU is not supported or device was lost on this system.');
    case 'ERR_ADAPTER_UNSUPPORTED':
      return msg(
        'This model format is not compatible with the installed runtime.',
      );
    case 'ERR_STORAGE_UNSUPPORTED':
      return msg(
        'Persistent browser storage is unavailable. Check site permissions.',
      );
    case 'ERR_INSUFFICIENT_STORAGE':
      return msg(
        'Insufficient storage space to download model. Please free up disk space.',
      );
    case 'ERR_PERSISTENCE_DENIED':
      return msg(
        'Persistent storage was denied. Free space or update site permissions, then retry.',
      );
    case 'ERR_DOWNLOAD_FAILED':
      return msg(
        'Failed to download model artifact. Check your network connection.',
      );
    case 'ERR_URL_EXPIRED':
      return msg('The download link expired. Retry to request a new link.');
    case 'ERR_RANGE_NOT_SATISFIABLE':
      return msg(
        'The partial download cannot be resumed safely. Retry the download.',
      );
    case 'ERR_GENERATION_MISMATCH':
      return msg('The downloaded model version changed. Check for updates.');
    case 'ERR_CHECKSUM_MISMATCH':
      return msg(
        'Model integrity check failed. The downloaded file may be corrupted.',
      );
    case 'ERR_LOAD_FAILED':
      return msg('Failed to load model into WebGPU runtime.');
    case 'ERR_SMOKE_TEST_FAILED':
      return msg(
        'Activation smoke test failed. Model output could not be verified.',
      );
    case 'ERR_TAB_LOCKED':
      return msg(
        'Model is currently in use or downloading in another browser tab.',
      );
    default:
      return msg('An error occurred with on-device inference.');
  }
}
