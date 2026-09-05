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

import {
  StreamingSha256,
  verifyArtifactDigest,
  verifyArtifactDigestInThread,
  verifyArtifactDigestInWorker,
} from '../on-device/hash-verifier.js';
import {InMemoryModelStorage} from '../on-device/model-storage.js';

describe('StreamingSha256 and Artifact Verification', () => {
  it('computes correct digest for empty string', () => {
    const hasher = new StreamingSha256();
    hasher.update(new Uint8Array(0));
    expect(hasher.digest()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('computes correct digest for "abc"', () => {
    const hasher = new StreamingSha256();
    const enc = new TextEncoder();
    hasher.update(enc.encode('abc'));
    expect(hasher.digest()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('computes correct digest across chunk boundaries', () => {
    const hasher = new StreamingSha256();
    const enc = new TextEncoder();
    hasher.update(enc.encode('a'));
    hasher.update(enc.encode('b'));
    hasher.update(enc.encode('c'));
    expect(hasher.digest()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('computes correct digest for standard multi-block NIST test vector', () => {
    // 448 bits (56 bytes) message
    const msg = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    const hasher = new StreamingSha256();
    const enc = new TextEncoder();
    hasher.update(enc.encode(msg));
    expect(hasher.digest()).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('verifies artifact file in storage and reports progress', async () => {
    const storage = new InMemoryModelStorage();
    const content = new TextEncoder().encode('abc');
    await storage.writeChunk('m1', 'v1', content, 0);

    const progressReports: number[] = [];
    const result = await verifyArtifactDigest(
      storage,
      'm1',
      'v1',
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      3,
      true,
      p => progressReports.push(p.percentage),
      1, // 1-byte chunks to test multi-chunk reads
    );

    expect(result.verified).toBeTrue();
    expect(result.actualSize).toBe(3);
    expect(progressReports.length).toBeGreaterThan(0);
    expect(progressReports[progressReports.length - 1]).toBe(100);
  });

  it('rejects corrupt artifact with checksum mismatch', async () => {
    const storage = new InMemoryModelStorage();
    const content = new TextEncoder().encode('corrupted bytes');
    await storage.writeChunk('m1', 'v1', content, 0);

    const result = await verifyArtifactDigest(
      storage,
      'm1',
      'v1',
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      content.byteLength,
      true,
    );

    expect(result.verified).toBeFalse();
    expect(result.errorMessage).toContain('Checksum mismatch');
  });

  it('rejects artifact with size mismatch', async () => {
    const storage = new InMemoryModelStorage();
    const content = new TextEncoder().encode('short');
    await storage.writeChunk('m1', 'v1', content, 0);

    const result = await verifyArtifactDigest(
      storage,
      'm1',
      'v1',
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      100, // expected 100 bytes, found 5
      true,
    );

    expect(result.verified).toBeFalse();
    expect(result.errorMessage).toContain('Size mismatch');
  });

  it('fails safely when storage returns a short read', async () => {
    class ShortReadStorage extends InMemoryModelStorage {
      override async readChunk(): Promise<Uint8Array> {
        return new Uint8Array(0);
      }
    }
    const storage = new ShortReadStorage();
    await storage.writeChunk('m1', 'v1', new Uint8Array([1]), 0);

    const result = await verifyArtifactDigest(
      storage,
      'm1',
      'v1',
      '00'.repeat(32),
      1,
      true,
    );

    expect(result.verified).toBeFalse();
    expect(result.errorMessage).toContain('read ended early');
  });

  if (typeof Worker !== 'undefined') {
    it('verifies artifact file using dedicated Web Worker', async () => {
      const storage = new InMemoryModelStorage();
      const content = new TextEncoder().encode('Hello Web Worker SHA-256');
      await storage.writeChunk('m1', 'v1', content, 0);

      // In-thread reference
      const inThread = await verifyArtifactDigestInThread(
        storage,
        'm1',
        'v1',
        '00'.repeat(32), // dummy hash to get actual hash
        content.byteLength,
        true,
      );

      const progressReports: number[] = [];
      const workerResult = await verifyArtifactDigestInWorker(
        storage,
        'm1',
        'v1',
        inThread.actualSha256,
        content.byteLength,
        true,
        p => progressReports.push(p.percentage),
        4, // 4-byte chunks
      );

      expect(workerResult.verified).toBeTrue();
      expect(workerResult.actualSha256).toBe(inThread.actualSha256);
      expect(progressReports.length).toBeGreaterThan(0);
      expect(progressReports[progressReports.length - 1]).toBe(100);
    });

    it('produces identical digest between in-thread and worker verification', async () => {
      const storage = new InMemoryModelStorage();
      // Generate 16KB of pseudo-random bytes
      const testBytes = new Uint8Array(16384);
      for (let i = 0; i < testBytes.length; i++) {
        testBytes[i] = (i * 37 + 13) & 0xff;
      }
      await storage.writeChunk('m2', 'v1', testBytes, 0);

      const threadResult = await verifyArtifactDigestInThread(
        storage,
        'm2',
        'v1',
        '00'.repeat(32),
        testBytes.byteLength,
        true,
        undefined,
        1024,
      );

      const workerResult = await verifyArtifactDigestInWorker(
        storage,
        'm2',
        'v1',
        threadResult.actualSha256,
        testBytes.byteLength,
        true,
        undefined,
        1024,
      );

      expect(workerResult.verified).toBeTrue();
      expect(workerResult.actualSha256).toBe(threadResult.actualSha256);
    });
  }
});
