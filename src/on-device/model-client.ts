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

import {ModelManifest, validateModelManifest} from './model-manifest.js';

export interface SignedDownloadUrlResponse {
  url: string;
  expiresAt: string;
  sizeBytes: number;
  sha256: string;
  gcsGeneration: string;
}

export interface ModelApiClient {
  getDefaultManifest(abortSignal?: AbortSignal): Promise<ModelManifest>;
  getSignedDownloadUrl(
    modelId: string,
    version: string,
    abortSignal?: AbortSignal,
  ): Promise<SignedDownloadUrlResponse>;
}

/**
 * Production ModelApiClient that communicates with Flask backend endpoints.
 */
export class HttpModelApiClient implements ModelApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private getCsrfToken(): string {
    if (typeof document !== 'undefined') {
      return document.body?.dataset?.csrfToken || '';
    }
    return '';
  }

  async getDefaultManifest(abortSignal?: AbortSignal): Promise<ModelManifest> {
    const url = `${this.baseUrl}/api/on-device-models/default`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: abortSignal,
    });

    if (!response.ok) {
      let errDetail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        if (body.error || body.message) {
          errDetail = `${body.error || ''}: ${body.message || ''}`.trim();
        }
      } catch {
        // Ignored
      }
      throw new Error(`Failed to fetch default model manifest: ${errDetail}`);
    }

    const data = await response.json();
    return validateModelManifest(data);
  }

  async getSignedDownloadUrl(
    modelId: string,
    version: string,
    abortSignal?: AbortSignal,
  ): Promise<SignedDownloadUrlResponse> {
    const url = `${this.baseUrl}/api/on-device-models/${encodeURIComponent(modelId)}/download-url`;
    const csrfToken = this.getCsrfToken();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (csrfToken) {
      headers['X-CSRFToken'] = csrfToken;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({version}),
      signal: abortSignal,
    });

    if (!response.ok) {
      let errDetail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        if (body.error || body.message) {
          errDetail = `${body.error || ''}: ${body.message || ''}`.trim();
        }
      } catch {
        // Ignored
      }
      throw new Error(`Failed to get signed download URL: ${errDetail}`);
    }

    const data = await response.json();
    if (
      typeof data.url !== 'string' ||
      typeof data.expiresAt !== 'string' ||
      typeof data.sizeBytes !== 'number' ||
      !Number.isSafeInteger(data.sizeBytes) ||
      data.sizeBytes <= 0 ||
      typeof data.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(data.sha256) ||
      typeof data.gcsGeneration !== 'string' ||
      !/^[0-9]+$/.test(data.gcsGeneration) ||
      !Number.isFinite(Date.parse(data.expiresAt))
    ) {
      throw new Error('Malformed signed download URL response from server');
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(data.url);
    } catch {
      throw new Error('Malformed signed download URL response from server');
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('Signed model download URL must use HTTPS');
    }

    return {
      url: data.url,
      expiresAt: data.expiresAt,
      sizeBytes: data.sizeBytes,
      sha256: data.sha256.toLowerCase(),
      gcsGeneration: data.gcsGeneration,
    };
  }
}
