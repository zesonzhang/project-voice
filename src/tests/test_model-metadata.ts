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

import {ModelManifest} from '../on-device/model-manifest.js';
import {
  IndexedDbModelMetadataStore,
  InMemoryModelMetadataStore,
  ModelMetadataStore,
  ModelVersionRecord,
} from '../on-device/model-metadata.js';

describe('ModelMetadataStore', () => {
  const mockManifest: ModelManifest = {
    schemaVersion: 1,
    modelId: 'test-model',
    version: 'v1.0.0',
    displayName: 'Test Model',
    family: 'gemma',
    adapterId: 'litert-lm',
    format: 'litertlm',
    sizeBytes: 1000,
    sha256: '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5',
    gcsGeneration: '12345',
    capabilities: {
      textGeneration: true,
      languages: ['en'],
      maxInputTokens: 1024,
      maxOutputTokens: 128,
    },
    requirements: {
      webgpu: true,
      minimumDeviceMemoryGB: 4,
      minimumFreeStorageBytes: 2000,
    },
    generation: {
      temperature: 0,
      topP: 0.5,
      maxOutputTokens: 128,
    },
  };

  function runContractSuite(
    suiteName: string,
    createStore: () => Promise<ModelMetadataStore>,
    cleanup?: (store: ModelMetadataStore) => Promise<void>,
  ) {
    describe(suiteName, () => {
      let store: ModelMetadataStore;

      beforeEach(async () => {
        store = await createStore();
      });

      afterEach(async () => {
        if (cleanup) {
          await cleanup(store);
        } else {
          await store.close();
        }
      });

      it('saves and retrieves model and version records', async () => {
        const versionRecord: ModelVersionRecord = {
          modelId: 'test-model',
          version: 'v1.0.0',
          manifest: mockManifest,
          fileName: 'v1.0.0.litertlm',
          partialFileName: 'v1.0.0.partial',
          sizeBytes: 1000,
          sha256: mockManifest.sha256,
          gcsGeneration: '12345',
          downloadOffset: 0,
          verificationState: 'unverified',
          importStatus: 'certified',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastUsedAt: null,
        };

        await store.saveVersion(versionRecord);
        const retrieved = await store.getVersion('test-model', 'v1.0.0');
        expect(retrieved).not.toBeNull();
        expect(retrieved?.version).toBe('v1.0.0');
        expect(retrieved?.verificationState).toBe('unverified');
      });

      it('updates download offset atomically', async () => {
        const versionRecord: ModelVersionRecord = {
          modelId: 'test-model',
          version: 'v1.0.0',
          manifest: mockManifest,
          fileName: 'v1.0.0.litertlm',
          partialFileName: 'v1.0.0.partial',
          sizeBytes: 1000,
          sha256: mockManifest.sha256,
          gcsGeneration: '12345',
          downloadOffset: 0,
          verificationState: 'unverified',
          importStatus: 'certified',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastUsedAt: null,
        };
        await store.saveVersion(versionRecord);
        await store.updateDownloadOffset('test-model', 'v1.0.0', 500);

        const retrieved = await store.getVersion('test-model', 'v1.0.0');
        expect(retrieved?.downloadOffset).toBe(500);
      });

      it('sets verification state', async () => {
        const versionRecord: ModelVersionRecord = {
          modelId: 'test-model',
          version: 'v1.0.0',
          manifest: mockManifest,
          fileName: 'v1.0.0.litertlm',
          partialFileName: 'v1.0.0.partial',
          sizeBytes: 1000,
          sha256: mockManifest.sha256,
          gcsGeneration: '12345',
          downloadOffset: 1000,
          verificationState: 'verifying',
          importStatus: 'certified',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastUsedAt: null,
        };
        await store.saveVersion(versionRecord);
        await store.setVerificationState('test-model', 'v1.0.0', 'verified');

        const retrieved = await store.getVersion('test-model', 'v1.0.0');
        expect(retrieved?.verificationState).toBe('verified');
      });

      it('atomically tracks active version and lastKnownGoodVersion during updates', async () => {
        const v1: ModelVersionRecord = {
          modelId: 'test-model',
          version: 'v1',
          manifest: {...mockManifest, version: 'v1'},
          fileName: 'v1.litertlm',
          partialFileName: 'v1.partial',
          sizeBytes: 1000,
          sha256: mockManifest.sha256,
          gcsGeneration: '1',
          downloadOffset: 1000,
          verificationState: 'verified',
          importStatus: 'certified',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastUsedAt: null,
        };
        const v2: ModelVersionRecord = {
          ...v1,
          version: 'v2',
          manifest: {...mockManifest, version: 'v2'},
          fileName: 'v2.litertlm',
          partialFileName: 'v2.partial',
        };

        await store.saveVersion(v1);
        await store.saveVersion(v2);

        await store.setActiveVersion('test-model', 'v1');
        let model = await store.getModel('test-model');
        expect(model?.activeVersion).toBe('v1');
        expect(model?.lastKnownGoodVersion).toBeNull();

        // Now activate v2: v1 becomes lastKnownGoodVersion
        await store.setActiveVersion('test-model', 'v2');
        model = await store.getModel('test-model');
        expect(model?.activeVersion).toBe('v2');
        expect(model?.lastKnownGoodVersion).toBe('v1');

        // Rollback to LKG
        const rolledBack = await store.rollbackToLastKnownGood('test-model');
        expect(rolledBack).toBe('v1');
        model = await store.getModel('test-model');
        expect(model?.activeVersion).toBe('v1');
        expect(model?.lastKnownGoodVersion).toBe('v2');

        const superseded = await store.finalizeActiveVersion('test-model');
        expect(superseded).toBe('v2');
        model = await store.getModel('test-model');
        expect(model?.lastKnownGoodVersion).toBeNull();
      });

      it('deletes version and cleans up model references', async () => {
        const v1: ModelVersionRecord = {
          modelId: 'test-model',
          version: 'v1',
          manifest: mockManifest,
          fileName: 'v1.litertlm',
          partialFileName: 'v1.partial',
          sizeBytes: 1000,
          sha256: mockManifest.sha256,
          gcsGeneration: '1',
          downloadOffset: 1000,
          verificationState: 'verified',
          importStatus: 'certified',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastUsedAt: null,
        };
        await store.saveVersion(v1);
        await store.setActiveVersion('test-model', 'v1');

        await store.deleteVersion('test-model', 'v1');
        const version = await store.getVersion('test-model', 'v1');
        expect(version).toBeNull();

        const model = await store.getModel('test-model');
        expect(model?.activeVersion).toBeNull();
      });
    });
  }

  // 1. In-memory implementation test
  runContractSuite('InMemoryModelMetadataStore', async () => {
    return new InMemoryModelMetadataStore();
  });

  // 2. Real browser IndexedDB implementation test
  if (typeof indexedDB !== 'undefined') {
    let testDbCounter = 0;
    runContractSuite(
      'IndexedDbModelMetadataStore',
      async () => {
        testDbCounter++;
        return new IndexedDbModelMetadataStore(
          indexedDB,
          `test-pv-store-${Date.now()}-${testDbCounter}`,
        );
      },
      async store => {
        if (store.recoverCorruptedDatabase) {
          await store.recoverCorruptedDatabase();
        } else {
          await store.close();
        }
      },
    );

    describe('IndexedDbModelMetadataStore advanced features', () => {
      let dbName: string;

      beforeEach(() => {
        testDbCounter++;
        dbName = `test-pv-advanced-${Date.now()}-${testDbCounter}`;
      });

      afterEach(async () => {
        const store = new IndexedDbModelMetadataStore(indexedDB, dbName);
        await store.recoverCorruptedDatabase();
      });

      it('preserves data across fresh instances opening the same database', async () => {
        const store1 = new IndexedDbModelMetadataStore(indexedDB, dbName);
        const record: ModelVersionRecord = {
          modelId: 'test-model',
          version: 'v1.0.0',
          manifest: mockManifest,
          fileName: 'v1.0.0.litertlm',
          partialFileName: 'v1.0.0.partial',
          sizeBytes: 1000,
          sha256: mockManifest.sha256,
          gcsGeneration: '12345',
          downloadOffset: 100,
          verificationState: 'verifying',
          importStatus: 'certified',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastUsedAt: null,
        };
        await store1.saveVersion(record);
        await store1.setActiveVersion('test-model', 'v1.0.0');
        await store1.close();

        // Open new store instance with the same dbName
        const store2 = new IndexedDbModelMetadataStore(indexedDB, dbName);
        const retrieved = await store2.getVersion('test-model', 'v1.0.0');
        expect(retrieved).not.toBeNull();
        expect(retrieved?.version).toBe('v1.0.0');
        expect(retrieved?.downloadOffset).toBe(100);

        const model = await store2.getModel('test-model');
        expect(model?.activeVersion).toBe('v1.0.0');
        await store2.close();
      });

      it('handles schema upgrade and preserves existing data', async () => {
        // Step 1: Open at DB version 1 and write data
        const storeV1 = new IndexedDbModelMetadataStore(indexedDB, dbName, 1);
        const record: ModelVersionRecord = {
          modelId: 'test-model',
          version: 'v1.0.0',
          manifest: mockManifest,
          fileName: 'v1.0.0.litertlm',
          partialFileName: 'v1.0.0.partial',
          sizeBytes: 1000,
          sha256: mockManifest.sha256,
          gcsGeneration: '12345',
          downloadOffset: 500,
          verificationState: 'verified',
          importStatus: 'certified',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastUsedAt: null,
        };
        await storeV1.saveVersion(record);
        await storeV1.close();

        // Step 2: Open at DB version 2 (simulating upgrade)
        const storeV2 = new IndexedDbModelMetadataStore(indexedDB, dbName, 2);
        const retrieved = await storeV2.getVersion('test-model', 'v1.0.0');
        expect(retrieved).not.toBeNull();
        expect(retrieved?.version).toBe('v1.0.0');
        expect(retrieved?.downloadOffset).toBe(500);

        // Step 3: Write new data on upgraded store
        await storeV2.setActiveVersion('test-model', 'v1.0.0');
        const model = await storeV2.getModel('test-model');
        expect(model?.activeVersion).toBe('v1.0.0');
        await storeV2.close();
      });

      it('recovers cleanly from corrupted database via recoverCorruptedDatabase()', async () => {
        const store = new IndexedDbModelMetadataStore(indexedDB, dbName);
        await store.saveModel({
          modelId: 'test-model',
          activeVersion: 'v1',
          lastKnownGoodVersion: null,
          updatedAt: Date.now(),
        });

        // Trigger explicit corruption recovery
        await store.recoverCorruptedDatabase();

        // After recovery, database is recreated clean
        const model = await store.getModel('test-model');
        expect(model).toBeNull();

        // Verify new writes succeed on recovered store
        await store.saveModel({
          modelId: 'test-model',
          activeVersion: 'v2',
          lastKnownGoodVersion: null,
          updatedAt: Date.now(),
        });
        const recoveredModel = await store.getModel('test-model');
        expect(recoveredModel?.activeVersion).toBe('v2');
        await store.close();
      });
    });
  }
});
