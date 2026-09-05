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

import {InMemoryModelStorage} from '../on-device/model-storage.js';

describe('ModelStorage', () => {
  let storage: InMemoryModelStorage;

  beforeEach(() => {
    storage = new InMemoryModelStorage();
  });

  it('writes and reads partial chunks at specified offsets', async () => {
    const chunk1 = new Uint8Array([1, 2, 3, 4]);
    const chunk2 = new Uint8Array([5, 6, 7, 8]);

    await storage.writeChunk('m1', 'v1', chunk1, 0);
    await storage.writeChunk('m1', 'v1', chunk2, 4);

    expect(await storage.getPartialSize('m1', 'v1')).toBe(8);

    const read = await storage.readChunk('m1', 'v1', 2, 4, true);
    expect(Array.from(read)).toEqual([3, 4, 5, 6]);
  });

  it('appends chunks sequentially', async () => {
    const chunk1 = new Uint8Array([10, 20]);
    const chunk2 = new Uint8Array([30, 40]);

    await storage.appendChunk('m1', 'v1', chunk1);
    const size = await storage.appendChunk('m1', 'v1', chunk2);

    expect(size).toBe(4);
    expect(await storage.getPartialSize('m1', 'v1')).toBe(4);

    const read = await storage.readChunk('m1', 'v1', 0, 4, true);
    expect(Array.from(read)).toEqual([10, 20, 30, 40]);
  });

  it('promotes partial to certified model artifact and deletes partial', async () => {
    const data = new Uint8Array([100, 101, 102, 103]);
    await storage.writeChunk('m1', 'v1', data, 0);

    expect(await storage.hasPartial('m1', 'v1')).toBeTrue();
    expect(await storage.hasModel('m1', 'v1')).toBeFalse();

    await storage.promotePartialToModel('m1', 'v1');

    expect(await storage.hasPartial('m1', 'v1')).toBeFalse();
    expect(await storage.hasModel('m1', 'v1')).toBeTrue();
    expect(await storage.getModelFileSize('m1', 'v1')).toBe(4);

    const read = await storage.readChunk('m1', 'v1', 0, 4, false);
    expect(Array.from(read)).toEqual([100, 101, 102, 103]);
  });

  it('deletes model without affecting other models or versions', async () => {
    await storage.writeChunk('m1', 'v1', new Uint8Array([1]), 0);
    await storage.promotePartialToModel('m1', 'v1');

    await storage.writeChunk('m1', 'v2', new Uint8Array([2]), 0);
    await storage.promotePartialToModel('m1', 'v2');

    await storage.deleteModel('m1', 'v1');

    expect(await storage.hasModel('m1', 'v1')).toBeFalse();
    expect(await storage.hasModel('m1', 'v2')).toBeTrue();
  });

  it('opens model file as standard File object', async () => {
    const bytes = new Uint8Array([65, 66, 67]); // "ABC"
    await storage.writeChunk('m1', 'v1', bytes, 0);
    await storage.promotePartialToModel('m1', 'v1');

    const file = await storage.openModelFile('m1', 'v1');
    expect(file.name).toBe('v1.litertlm');
    expect(file.size).toBe(3);

    const buffer = await file.arrayBuffer();
    expect(Array.from(new Uint8Array(buffer))).toEqual([65, 66, 67]);
  });

  it('rejects unsafe model and version path segments', async () => {
    await expectAsync(
      storage.writeChunk('../other', 'v1', new Uint8Array([1]), 0),
    ).toBeRejectedWithError(/Invalid model storage ID/);
    await expectAsync(
      storage.writeChunk('m1', '../v1', new Uint8Array([1]), 0),
    ).toBeRejectedWithError(/Invalid model storage version/);
  });
});
