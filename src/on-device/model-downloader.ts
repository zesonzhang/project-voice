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

import {ModelApiClient, SignedDownloadUrlResponse} from './model-client.js';
import {DownloadProgress, ModelManagerError} from './model-lifecycle.js';
import {ModelManifest} from './model-manifest.js';
import {ModelMetadataStore} from './model-metadata.js';
import {ModelStorage} from './model-storage.js';

export interface ModelDownloaderOptions {
  storage: ModelStorage;
  metadataStore: ModelMetadataStore;
  apiClient: ModelApiClient;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  onProgress?: (progress: DownloadProgress) => void;
}

export class ModelDownloader {
  private currentSignedUrlInfo: SignedDownloadUrlResponse | null = null;
  private currentSignedUrlKey = '';
  private readonly fetchImpl: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>;

  constructor(private readonly options: ModelDownloaderOptions) {
    this.fetchImpl =
      options.fetchImpl ||
      ((url: string, init?: RequestInit) => fetch(url, init));
  }

  async getValidSignedUrl(
    manifest: ModelManifest,
    abortSignal: AbortSignal,
    forceRefresh = false,
  ): Promise<SignedDownloadUrlResponse> {
    const now = Date.now();
    const cacheKey = `${manifest.modelId}:${manifest.version}:${manifest.gcsGeneration}`;
    if (
      !forceRefresh &&
      this.currentSignedUrlInfo &&
      this.currentSignedUrlKey === cacheKey &&
      Date.parse(this.currentSignedUrlInfo.expiresAt) - now > 60_000
    ) {
      return this.currentSignedUrlInfo;
    }
    const info = await this.options.apiClient.getSignedDownloadUrl(
      manifest.modelId,
      manifest.version,
      abortSignal,
    );
    this.validateSignedUrlResponse(info, manifest);
    this.currentSignedUrlInfo = info;
    this.currentSignedUrlKey = cacheKey;
    return info;
  }

  validateSignedUrlResponse(
    info: SignedDownloadUrlResponse,
    manifest: ModelManifest,
  ): void {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(info.url);
    } catch {
      throw new ModelManagerError(
        'ERR_GENERATION_MISMATCH',
        'Backend returned an invalid signed download URL',
      );
    }
    if (
      parsedUrl.protocol !== 'https:' ||
      info.gcsGeneration !== manifest.gcsGeneration ||
      info.sizeBytes !== manifest.sizeBytes ||
      info.sha256.toLowerCase() !== manifest.sha256.toLowerCase() ||
      parsedUrl.searchParams.get('generation') !== manifest.gcsGeneration ||
      !Number.isFinite(Date.parse(info.expiresAt)) ||
      Date.parse(info.expiresAt) <= Date.now()
    ) {
      throw new ModelManagerError(
        'ERR_GENERATION_MISMATCH',
        'Signed URL metadata does not match the model manifest',
      );
    }
  }

  validateDownloadResponse(
    response: Response,
    requestedOffset: number,
    expectedSize: number,
  ): void {
    if (!response.ok && response.status !== 206) {
      throw new Error(
        `Download HTTP failed with status ${response.status} ${response.statusText}`,
      );
    }
    if (response.status === 206) {
      const contentRange = response.headers.get('Content-Range');
      const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (
        !match ||
        Number(match[1]) !== requestedOffset ||
        Number(match[2]) < requestedOffset ||
        Number(match[2]) >= expectedSize ||
        Number(match[3]) !== expectedSize
      ) {
        throw new ModelManagerError(
          'ERR_RANGE_NOT_SATISFIABLE',
          `Invalid Content-Range response: ${contentRange}`,
        );
      }
      const contentLength = response.headers.get('Content-Length');
      const rangeLength = Number(match[2]) - Number(match[1]) + 1;
      if (contentLength !== null && Number(contentLength) !== rangeLength) {
        throw new ModelManagerError(
          'ERR_RANGE_NOT_SATISFIABLE',
          'Content-Length does not match Content-Range',
        );
      }
    } else if (requestedOffset !== 0) {
      throw new ModelManagerError(
        'ERR_RANGE_NOT_SATISFIABLE',
        'Server ignored a Range request without a safe restart',
      );
    }

    const contentLength = response.headers.get('Content-Length');
    if (
      response.status === 200 &&
      contentLength !== null &&
      Number(contentLength) !== expectedSize
    ) {
      throw new Error('Content-Length does not match the model manifest');
    }
  }

  async downloadArtifact(
    manifest: ModelManifest,
    abortSignal: AbortSignal,
  ): Promise<void> {
    // Record initial metadata if missing
    let versionRecord = await this.options.metadataStore.getVersion(
      manifest.modelId,
      manifest.version,
    );
    if (!versionRecord) {
      versionRecord = {
        modelId: manifest.modelId,
        version: manifest.version,
        manifest,
        fileName: `${manifest.version}.litertlm`,
        partialFileName: `${manifest.version}.partial`,
        sizeBytes: manifest.sizeBytes,
        sha256: manifest.sha256,
        gcsGeneration: manifest.gcsGeneration,
        downloadOffset: 0,
        verificationState: 'unverified',
        importStatus: 'certified',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastUsedAt: null,
      };
      await this.options.metadataStore.saveVersion(versionRecord);
    } else if (
      versionRecord.sizeBytes !== manifest.sizeBytes ||
      versionRecord.sha256 !== manifest.sha256 ||
      versionRecord.gcsGeneration !== manifest.gcsGeneration
    ) {
      // A version label may never silently point at different bytes.
      await this.options.storage.deletePartial(
        manifest.modelId,
        manifest.version,
      );
      throw new Error(
        'Stored metadata conflicts with the immutable model manifest',
      );
    }

    // Check current partial file size in OPFS
    let startOffset = await this.options.storage.getPartialSize(
      manifest.modelId,
      manifest.version,
    );
    if (startOffset > manifest.sizeBytes) {
      // Corrupted oversized partial; reset
      await this.options.storage.deletePartial(
        manifest.modelId,
        manifest.version,
      );
      startOffset = 0;
      await this.options.metadataStore.updateDownloadOffset(
        manifest.modelId,
        manifest.version,
        0,
      );
    }

    if (startOffset === manifest.sizeBytes) {
      return;
    }

    // Get or refresh signed URL
    let signedUrl = await this.getValidSignedUrl(manifest, abortSignal);

    // Perform Range request
    const headers: Record<string, string> = {};
    if (startOffset > 0) {
      headers['Range'] = `bytes=${startOffset}-`;
    }

    let response = await this.fetchImpl(signedUrl.url, {
      method: 'GET',
      headers,
      signal: abortSignal,
    });

    // Handle URL expiration or refresh requirement
    if (response.status === 403) {
      signedUrl = await this.getValidSignedUrl(manifest, abortSignal, true);
      response = await this.fetchImpl(signedUrl.url, {
        method: 'GET',
        headers,
        signal: abortSignal,
      });
    }

    // A stale local partial can be invalid after remote cleanup. Restart the
    // exact immutable generation from zero on a 416 response.
    if (startOffset > 0 && response.status === 416) {
      await this.options.storage.deletePartial(
        manifest.modelId,
        manifest.version,
      );
      startOffset = 0;
      await this.options.metadataStore.updateDownloadOffset(
        manifest.modelId,
        manifest.version,
        0,
      );
      response = await this.fetchImpl(signedUrl.url, {
        method: 'GET',
        signal: abortSignal,
      });
    }

    if (!response.ok && response.status !== 206) {
      throw new Error(
        `Download HTTP failed with status ${response.status} ${response.statusText}`,
      );
    }

    // Check if server ignored Range header (returned 200 instead of 206)
    if (startOffset > 0 && response.status === 200) {
      // Server does not support Range or restarted from 0; reset local offset
      await this.options.storage.deletePartial(
        manifest.modelId,
        manifest.version,
      );
      startOffset = 0;
      await this.options.metadataStore.updateDownloadOffset(
        manifest.modelId,
        manifest.version,
        0,
      );
    }

    this.validateDownloadResponse(response, startOffset, manifest.sizeBytes);

    if (!response.body) {
      throw new Error('Response body is null, cannot stream download');
    }

    const reader = response.body.getReader();
    let bytesDownloaded = startOffset;
    let lastPersistTime = Date.now();
    let lastPersistedOffset = startOffset;
    let speedSampleBytes = 0;
    let speedSampleTime = Date.now();
    let currentSpeedBps = 0;

    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;

      if (value && value.byteLength > 0) {
        if (bytesDownloaded + value.byteLength > manifest.sizeBytes) {
          throw new Error('Download exceeded the manifest size');
        }
        await this.options.storage.writeChunk(
          manifest.modelId,
          manifest.version,
          value,
          bytesDownloaded,
        );
        bytesDownloaded += value.byteLength;
        speedSampleBytes += value.byteLength;

        const now = Date.now();
        const speedElapsed = now - speedSampleTime;
        if (speedElapsed >= 1000) {
          currentSpeedBps = (speedSampleBytes / speedElapsed) * 1000;
          speedSampleBytes = 0;
          speedSampleTime = now;
        }

        const percentage = Math.floor(
          (bytesDownloaded / manifest.sizeBytes) * 100,
        );
        this.options.onProgress?.({
          bytesDownloaded,
          totalBytes: manifest.sizeBytes,
          percentage,
          speedBps: currentSpeedBps,
          isResumed: startOffset > 0,
        });

        // Persist offset every 500ms or when complete
        if (
          now - lastPersistTime >= 500 ||
          bytesDownloaded === manifest.sizeBytes
        ) {
          if (bytesDownloaded !== lastPersistedOffset) {
            await this.options.metadataStore.updateDownloadOffset(
              manifest.modelId,
              manifest.version,
              bytesDownloaded,
            );
            lastPersistedOffset = bytesDownloaded;
            lastPersistTime = now;
          }
        }
      }
    }
  }
}
