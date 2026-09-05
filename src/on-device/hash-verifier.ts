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

import {ModelStorage} from './model-storage.js';

export interface HashVerificationProgress {
  bytesProcessed: number;
  totalBytes: number;
  percentage: number;
}

export interface VerificationResult {
  verified: boolean;
  actualSha256: string;
  actualSize: number;
  expectedSha256: string;
  expectedSize: number;
  errorMessage?: string;
}

/**
 * Standard incremental SHA-256 implementation (FIPS 180-4).
 * Processes data in 64-byte blocks with constant memory footprint.
 */
export class StreamingSha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;

  private block = new Uint8Array(64);
  private blockLen = 0;
  private totalBytes = 0;
  private readonly w = new Int32Array(64);

  private static readonly K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  update(chunk: Uint8Array): void {
    let offset = 0;
    const len = chunk.length;
    this.totalBytes += len;

    if (this.blockLen > 0) {
      const needed = 64 - this.blockLen;
      if (len < needed) {
        this.block.set(chunk, this.blockLen);
        this.blockLen += len;
        return;
      }
      this.block.set(chunk.subarray(0, needed), this.blockLen);
      this.transformBlock(this.block, 0);
      offset += needed;
      this.blockLen = 0;
    }

    while (offset + 64 <= len) {
      this.transformBlock(chunk, offset);
      offset += 64;
    }

    if (offset < len) {
      const remaining = chunk.subarray(offset);
      this.block.set(remaining, 0);
      this.blockLen = remaining.length;
    }
  }

  digest(): string {
    const totalBits = this.totalBytes * 8;
    const pad = new Uint8Array(64);
    pad[0] = 0x80;

    const padLen =
      this.blockLen < 56 ? 56 - this.blockLen : 120 - this.blockLen;
    this.update(pad.subarray(0, padLen));

    const lenBytes = new Uint8Array(8);
    const view = new DataView(lenBytes.buffer);
    // Write 64-bit big-endian bit count
    const high = Math.floor(totalBits / 0x100000000);
    const low = totalBits >>> 0;
    view.setUint32(0, high, false);
    view.setUint32(4, low, false);
    this.update(lenBytes);

    const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
    return (
      toHex(this.h0) +
      toHex(this.h1) +
      toHex(this.h2) +
      toHex(this.h3) +
      toHex(this.h4) +
      toHex(this.h5) +
      toHex(this.h6) +
      toHex(this.h7)
    );
  }

  private transformBlock(bytes: Uint8Array, offset: number): void {
    const w = this.w;
    const k = StreamingSha256.K;

    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 4;
      w[i] =
        (bytes[idx] << 24) |
        (bytes[idx + 1] << 16) |
        (bytes[idx + 2] << 8) |
        bytes[idx + 3];
    }

    for (let i = 16; i < 64; i++) {
      const s0 =
        (this.rotr(w[i - 15], 7) ^
          this.rotr(w[i - 15], 18) ^
          (w[i - 15] >>> 3)) |
        0;
      const s1 =
        (this.rotr(w[i - 2], 17) ^
          this.rotr(w[i - 2], 19) ^
          (w[i - 2] >>> 10)) |
        0;
      w[i] = (((w[i - 16] + s0) | 0) + ((w[i - 7] + s1) | 0)) | 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;

    for (let i = 0; i < 64; i++) {
      const s1 = (this.rotr(e, 6) ^ this.rotr(e, 11) ^ this.rotr(e, 25)) | 0;
      const ch = ((e & f) ^ (~e & g)) | 0;
      const temp1 = (((((h + s1) | 0) + ch) | 0) + ((k[i] + w[i]) | 0)) | 0;
      const s0 = (this.rotr(a, 2) ^ this.rotr(a, 13) ^ this.rotr(a, 22)) | 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) | 0;
      const temp2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
    this.h5 = (this.h5 + f) | 0;
    this.h6 = (this.h6 + g) | 0;
    this.h7 = (this.h7 + h) | 0;
  }

  private rotr(x: number, n: number): number {
    return (x >>> n) | (x << (32 - n));
  }
}

const HASH_WORKER_SCRIPT = `
class StreamingSha256 {
  constructor() {
    this.h0 = 0x6a09e667;
    this.h1 = 0xbb67ae85;
    this.h2 = 0x3c6ef372;
    this.h3 = 0xa54ff53a;
    this.h4 = 0x510e527f;
    this.h5 = 0x9b05688c;
    this.h6 = 0x1f83d9ab;
    this.h7 = 0x5be0cd19;
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.totalBytes = 0;
    this.w = new Int32Array(64);
  }

  static K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  update(chunk) {
    let offset = 0;
    const len = chunk.length;
    this.totalBytes += len;

    if (this.blockLen > 0) {
      const needed = 64 - this.blockLen;
      if (len < needed) {
        this.block.set(chunk, this.blockLen);
        this.blockLen += len;
        return;
      }
      this.block.set(chunk.subarray(0, needed), this.blockLen);
      this.transformBlock(this.block, 0);
      offset += needed;
      this.blockLen = 0;
    }

    while (offset + 64 <= len) {
      this.transformBlock(chunk, offset);
      offset += 64;
    }

    if (offset < len) {
      const remaining = chunk.subarray(offset);
      this.block.set(remaining, 0);
      this.blockLen = remaining.length;
    }
  }

  digest() {
    const totalBits = this.totalBytes * 8;
    const pad = new Uint8Array(64);
    pad[0] = 0x80;

    const padLen =
      this.blockLen < 56 ? 56 - this.blockLen : 120 - this.blockLen;
    this.update(pad.subarray(0, padLen));

    const lenBytes = new Uint8Array(8);
    const view = new DataView(lenBytes.buffer);
    const high = Math.floor(totalBits / 0x100000000);
    const low = totalBits >>> 0;
    view.setUint32(0, high, false);
    view.setUint32(4, low, false);
    this.update(lenBytes);

    const toHex = n => (n >>> 0).toString(16).padStart(8, '0');
    return (
      toHex(this.h0) +
      toHex(this.h1) +
      toHex(this.h2) +
      toHex(this.h3) +
      toHex(this.h4) +
      toHex(this.h5) +
      toHex(this.h6) +
      toHex(this.h7)
    );
  }

  transformBlock(bytes, offset) {
    const w = this.w;
    const k = StreamingSha256.K;

    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 4;
      w[i] =
        (bytes[idx] << 24) |
        (bytes[idx + 1] << 16) |
        (bytes[idx + 2] << 8) |
        bytes[idx + 3];
    }

    for (let i = 16; i < 64; i++) {
      const s0 =
        (this.rotr(w[i - 15], 7) ^
          this.rotr(w[i - 15], 18) ^
          (w[i - 15] >>> 3)) |
        0;
      const s1 =
        (this.rotr(w[i - 2], 17) ^
          this.rotr(w[i - 2], 19) ^
          (w[i - 2] >>> 10)) |
        0;
      w[i] = (((w[i - 16] + s0) | 0) + ((w[i - 7] + s1) | 0)) | 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;

    for (let i = 0; i < 64; i++) {
      const s1 = (this.rotr(e, 6) ^ this.rotr(e, 11) ^ this.rotr(e, 25)) | 0;
      const ch = ((e & f) ^ (~e & g)) | 0;
      const temp1 = (((((h + s1) | 0) + ch) | 0) + ((k[i] + w[i]) | 0)) | 0;
      const s0 = (this.rotr(a, 2) ^ this.rotr(a, 13) ^ this.rotr(a, 22)) | 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) | 0;
      const temp2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
    this.h5 = (this.h5 + f) | 0;
    this.h6 = (this.h6 + g) | 0;
    this.h7 = (this.h7 + h) | 0;
  }

  rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }
}

let hasher = null;
let processed = 0;
let total = 0;

self.onmessage = function(e) {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'INIT') {
    hasher = new StreamingSha256();
    processed = 0;
    total = msg.totalBytes || 0;
    self.postMessage({type: 'READY'});
  } else if (msg.type === 'CHUNK') {
    if (!hasher) hasher = new StreamingSha256();
    const chunk = new Uint8Array(msg.buffer);
    hasher.update(chunk);
    processed += chunk.byteLength;
    self.postMessage({
      type: 'PROGRESS',
      bytesProcessed: processed,
      totalBytes: total,
      percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
    });
  } else if (msg.type === 'FINALIZE') {
    if (!hasher) hasher = new StreamingSha256();
    const sha256 = hasher.digest();
    self.postMessage({
      type: 'COMPLETE',
      sha256: sha256,
      totalBytes: processed,
    });
  }
};
`;

/**
 * Executes streaming SHA-256 verification inside a dedicated Web Worker.
 */
export async function verifyArtifactDigestInWorker(
  storage: ModelStorage,
  modelId: string,
  version: string,
  expectedSha256: string,
  expectedSizeBytes: number,
  isPartial = true,
  onProgress?: (progress: HashVerificationProgress) => void,
  chunkSize = 2 * 1024 * 1024,
): Promise<VerificationResult> {
  const actualSize = isPartial
    ? await storage.getPartialSize(modelId, version)
    : await storage.getModelFileSize(modelId, version);

  if (actualSize !== expectedSizeBytes) {
    return {
      verified: false,
      actualSha256: '',
      actualSize,
      expectedSha256: expectedSha256.toLowerCase(),
      expectedSize: expectedSizeBytes,
      errorMessage: `Size mismatch: expected ${expectedSizeBytes} bytes, found ${actualSize} bytes`,
    };
  }

  const blob = new Blob([HASH_WORKER_SCRIPT], {type: 'application/javascript'});
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl);

  try {
    const sendAndWait = <T extends {type: string}>(
      message: object,
      expectedType: T['type'],
      transfer: Transferable[] = [],
    ): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        worker.onerror = err => {
          reject(new Error(`Hash worker error: ${err.message || 'unknown'}`));
        };
        worker.onmessage = event => {
          const response = event.data as T & {message?: string};
          if (response?.type === 'ERROR') {
            reject(new Error(response.message || 'Hash worker failed'));
          } else if (response?.type === expectedType) {
            resolve(response);
          }
        };
        worker.postMessage(message, transfer);
      });

    await sendAndWait<{type: 'READY'}>(
      {type: 'INIT', totalBytes: actualSize},
      'READY',
    );

    let processed = 0;
    while (processed < actualSize) {
      const toRead = Math.min(chunkSize, actualSize - processed);
      const chunk = await storage.readChunk(
        modelId,
        version,
        processed,
        toRead,
        isPartial,
      );
      if (chunk.byteLength !== toRead) {
        throw new Error(`Artifact read ended early at byte ${processed}`);
      }

      // Wait for the Worker to acknowledge each transferred chunk before
      // reading the next one. Without this backpressure a multi-GB artifact can
      // accumulate in the Worker's message queue and defeat bounded-memory
      // streaming even though each individual chunk is transferred zero-copy.
      const progress = await sendAndWait<{
        type: 'PROGRESS';
        bytesProcessed: number;
        totalBytes: number;
        percentage: number;
      }>({type: 'CHUNK', buffer: chunk.buffer}, 'PROGRESS', [
        chunk.buffer as ArrayBuffer,
      ]);
      processed += toRead;
      onProgress?.({
        bytesProcessed: progress.bytesProcessed,
        totalBytes: progress.totalBytes,
        percentage: progress.percentage,
      });
    }

    const completed = await sendAndWait<{
      type: 'COMPLETE';
      sha256: string;
      totalBytes: number;
    }>({type: 'FINALIZE'}, 'COMPLETE');
    const computedSha256 = completed.sha256;

    const targetSha256 = expectedSha256.toLowerCase();
    const matched = computedSha256 === targetSha256;

    return {
      verified: matched,
      actualSha256: computedSha256,
      actualSize,
      expectedSha256: targetSha256,
      expectedSize: expectedSizeBytes,
      errorMessage: matched
        ? undefined
        : `Checksum mismatch: expected ${targetSha256}, calculated ${computedSha256}`,
    };
  } finally {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
}

/**
 * In-thread execution of streaming SHA-256.
 */
export async function verifyArtifactDigestInThread(
  storage: ModelStorage,
  modelId: string,
  version: string,
  expectedSha256: string,
  expectedSizeBytes: number,
  isPartial = true,
  onProgress?: (progress: HashVerificationProgress) => void,
  chunkSize = 2 * 1024 * 1024,
): Promise<VerificationResult> {
  const actualSize = isPartial
    ? await storage.getPartialSize(modelId, version)
    : await storage.getModelFileSize(modelId, version);

  if (actualSize !== expectedSizeBytes) {
    return {
      verified: false,
      actualSha256: '',
      actualSize,
      expectedSha256: expectedSha256.toLowerCase(),
      expectedSize: expectedSizeBytes,
      errorMessage: `Size mismatch: expected ${expectedSizeBytes} bytes, found ${actualSize} bytes`,
    };
  }

  const hasher = new StreamingSha256();
  let processed = 0;

  while (processed < actualSize) {
    const toRead = Math.min(chunkSize, actualSize - processed);
    const chunk = await storage.readChunk(
      modelId,
      version,
      processed,
      toRead,
      isPartial,
    );
    if (chunk.byteLength !== toRead) {
      return {
        verified: false,
        actualSha256: '',
        actualSize,
        expectedSha256: expectedSha256.toLowerCase(),
        expectedSize: expectedSizeBytes,
        errorMessage: `Artifact read ended early at byte ${processed}`,
      };
    }
    hasher.update(chunk);
    processed += chunk.byteLength;

    if (onProgress) {
      onProgress({
        bytesProcessed: processed,
        totalBytes: actualSize,
        percentage: Math.round((processed / actualSize) * 100),
      });
    }
  }

  const computedSha256 = hasher.digest();
  const targetSha256 = expectedSha256.toLowerCase();
  const matched = computedSha256 === targetSha256;

  return {
    verified: matched,
    actualSha256: computedSha256,
    actualSize,
    expectedSha256: targetSha256,
    expectedSize: expectedSizeBytes,
    errorMessage: matched
      ? undefined
      : `Checksum mismatch: expected ${targetSha256}, calculated ${computedSha256}`,
  };
}

/**
 * Streams chunks of a stored candidate model file through SHA-256 verification.
 * Runs in a dedicated Web Worker by default to keep the main thread responsive,
 * with graceful in-thread fallback if Worker is not available.
 */
export async function verifyArtifactDigest(
  storage: ModelStorage,
  modelId: string,
  version: string,
  expectedSha256: string,
  expectedSizeBytes: number,
  isPartial = true,
  onProgress?: (progress: HashVerificationProgress) => void,
  chunkSize = 2 * 1024 * 1024,
  useWorker = typeof Worker !== 'undefined' && typeof Blob !== 'undefined',
): Promise<VerificationResult> {
  if (useWorker) {
    try {
      return await verifyArtifactDigestInWorker(
        storage,
        modelId,
        version,
        expectedSha256,
        expectedSizeBytes,
        isPartial,
        onProgress,
        chunkSize,
      );
    } catch {
      // Fall back to in-thread calculation if worker creation fails
    }
  }

  return await verifyArtifactDigestInThread(
    storage,
    modelId,
    version,
    expectedSha256,
    expectedSizeBytes,
    isPartial,
    onProgress,
    chunkSize,
  );
}
