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

export type VerificationState =
  | 'unverified'
  | 'verifying'
  | 'verified'
  | 'corrupt';
export type ImportStatus = 'certified' | 'unverified_import';

export interface ModelRecord {
  modelId: string;
  activeVersion: string | null;
  lastKnownGoodVersion: string | null;
  updatedAt: number;
}

export interface ModelVersionRecord {
  modelId: string;
  version: string;
  manifest: ModelManifest;
  fileName: string;
  partialFileName: string;
  sizeBytes: number;
  sha256: string;
  gcsGeneration: string;
  downloadOffset: number;
  verificationState: VerificationState;
  importStatus: ImportStatus;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface ModelMetadataStore {
  getModel(modelId: string): Promise<ModelRecord | null>;
  listModels(): Promise<ModelRecord[]>;
  saveModel(record: ModelRecord): Promise<void>;
  getVersion(
    modelId: string,
    version: string,
  ): Promise<ModelVersionRecord | null>;
  saveVersion(record: ModelVersionRecord): Promise<void>;
  updateDownloadOffset(
    modelId: string,
    version: string,
    offset: number,
  ): Promise<void>;
  setVerificationState(
    modelId: string,
    version: string,
    state: VerificationState,
  ): Promise<void>;
  setActiveVersion(modelId: string, version: string): Promise<void>;
  markVersionVerifiedAndActive(modelId: string, version: string): Promise<void>;
  rollbackToLastKnownGood(modelId: string): Promise<string | null>;
  finalizeActiveVersion(modelId: string): Promise<string | null>;
  deleteVersion(modelId: string, version: string): Promise<void>;
  listVersions(modelId: string): Promise<ModelVersionRecord[]>;
  clearAll(): Promise<void>;
  close(): Promise<void>;
  recoverCorruptedDatabase?(): Promise<void>;
}

const DB_NAME = 'project-voice-model-store';
const DB_VERSION = 1;
const STORE_MODELS = 'models';
const STORE_VERSIONS = 'versions';

/**
 * IndexedDB implementation of the ModelMetadataStore.
 */
export class IndexedDbModelMetadataStore implements ModelMetadataStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly idbFactory: IDBFactory;
  private readonly dbName: string;
  private readonly dbVersion: number;

  constructor(
    idbFactory?: IDBFactory,
    dbName: string = DB_NAME,
    dbVersion: number = DB_VERSION,
  ) {
    this.idbFactory =
      idbFactory ||
      (typeof indexedDB !== 'undefined'
        ? indexedDB
        : (null as unknown as IDBFactory));
    this.dbName = dbName;
    this.dbVersion = dbVersion;
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    if (!this.idbFactory) {
      throw new Error('IndexedDB is not available in this environment');
    }

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.idbFactory.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_MODELS)) {
          db.createObjectStore(STORE_MODELS, {keyPath: 'modelId'});
        }
        if (!db.objectStoreNames.contains(STORE_VERSIONS)) {
          const store = db.createObjectStore(STORE_VERSIONS, {
            keyPath: ['modelId', 'version'],
          });
          store.createIndex('by_modelId', 'modelId', {unique: false});
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error);
      };
      request.onblocked = () => {
        // Blocked until other tabs close older DB version
      };
    });

    return this.dbPromise;
  }

  /**
   * Recovers from IndexedDB corruption by closing existing handles, deleting the
   * database, and resetting the connection promise for a clean recreate.
   */
  async recoverCorruptedDatabase(): Promise<void> {
    await this.close();
    if (
      this.idbFactory &&
      typeof this.idbFactory.deleteDatabase === 'function'
    ) {
      await new Promise<void>((resolve, reject) => {
        const req = this.idbFactory.deleteDatabase(this.dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve();
      });
    }
    this.dbPromise = null;
  }

  async getModel(modelId: string): Promise<ModelRecord | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MODELS, 'readonly');
      const store = tx.objectStore(STORE_MODELS);
      const req = store.get(modelId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async listModels(): Promise<ModelRecord[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MODELS, 'readonly');
      const req = tx.objectStore(STORE_MODELS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async saveModel(record: ModelRecord): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MODELS, 'readwrite');
      const store = tx.objectStore(STORE_MODELS);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getVersion(
    modelId: string,
    version: string,
  ): Promise<ModelVersionRecord | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VERSIONS, 'readonly');
      const store = tx.objectStore(STORE_VERSIONS);
      const req = store.get([modelId, version]);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async saveVersion(record: ModelVersionRecord): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VERSIONS, 'readwrite');
      const store = tx.objectStore(STORE_VERSIONS);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async updateDownloadOffset(
    modelId: string,
    version: string,
    offset: number,
  ): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VERSIONS, 'readwrite');
      const store = tx.objectStore(STORE_VERSIONS);
      const getReq = store.get([modelId, version]);

      getReq.onsuccess = () => {
        const record = getReq.result as ModelVersionRecord | undefined;
        if (!record) {
          reject(new Error(`Version [${modelId}, ${version}] not found`));
          return;
        }
        record.downloadOffset = offset;
        record.updatedAt = Date.now();
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async setVerificationState(
    modelId: string,
    version: string,
    state: VerificationState,
  ): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VERSIONS, 'readwrite');
      const store = tx.objectStore(STORE_VERSIONS);
      const getReq = store.get([modelId, version]);

      getReq.onsuccess = () => {
        const record = getReq.result as ModelVersionRecord | undefined;
        if (!record) {
          reject(new Error(`Version [${modelId}, ${version}] not found`));
          return;
        }
        record.verificationState = state;
        record.updatedAt = Date.now();
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async setActiveVersion(modelId: string, version: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_MODELS, STORE_VERSIONS], 'readwrite');
      const modelStore = tx.objectStore(STORE_MODELS);
      const versionStore = tx.objectStore(STORE_VERSIONS);

      const getVerReq = versionStore.get([modelId, version]);
      getVerReq.onsuccess = () => {
        const verRecord = getVerReq.result as ModelVersionRecord | undefined;
        if (!verRecord) {
          reject(new Error(`Cannot activate nonexistent version ${version}`));
          return;
        }
        const getModelReq = modelStore.get(modelId);
        getModelReq.onsuccess = () => {
          const now = Date.now();
          const existingModel = getModelReq.result as ModelRecord | undefined;
          const prevActive = existingModel?.activeVersion || null;

          const updatedModel: ModelRecord = {
            modelId,
            activeVersion: version,
            lastKnownGoodVersion:
              prevActive && prevActive !== version
                ? prevActive
                : existingModel?.lastKnownGoodVersion || null,
            updatedAt: now,
          };
          modelStore.put(updatedModel);
          verRecord.lastUsedAt = now;
          verRecord.updatedAt = now;
          versionStore.put(verRecord);
          resolve();
        };
        getModelReq.onerror = () => reject(getModelReq.error);
      };
      getVerReq.onerror = () => reject(getVerReq.error);
    });
  }

  async markVersionVerifiedAndActive(
    modelId: string,
    version: string,
  ): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_MODELS, STORE_VERSIONS], 'readwrite');
      const modelStore = tx.objectStore(STORE_MODELS);
      const versionStore = tx.objectStore(STORE_VERSIONS);

      const getVerReq = versionStore.get([modelId, version]);
      getVerReq.onsuccess = () => {
        const verRecord = getVerReq.result as ModelVersionRecord | undefined;
        if (!verRecord) {
          reject(new Error(`Version [${modelId}, ${version}] not found`));
          return;
        }
        const now = Date.now();
        verRecord.verificationState = 'verified';
        verRecord.downloadOffset = verRecord.sizeBytes;
        verRecord.lastUsedAt = now;
        verRecord.updatedAt = now;
        versionStore.put(verRecord);

        const getModelReq = modelStore.get(modelId);
        getModelReq.onsuccess = () => {
          const existingModel = getModelReq.result as ModelRecord | undefined;
          const prevActive = existingModel?.activeVersion || null;
          const updatedModel: ModelRecord = {
            modelId,
            activeVersion: version,
            lastKnownGoodVersion:
              prevActive && prevActive !== version
                ? prevActive
                : existingModel?.lastKnownGoodVersion || null,
            updatedAt: now,
          };
          modelStore.put(updatedModel);
          resolve();
        };
        getModelReq.onerror = () => reject(getModelReq.error);
      };
      getVerReq.onerror = () => reject(getVerReq.error);
    });
  }

  async rollbackToLastKnownGood(modelId: string): Promise<string | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MODELS, 'readwrite');
      const store = tx.objectStore(STORE_MODELS);
      const getReq = store.get(modelId);

      getReq.onsuccess = () => {
        const model = getReq.result as ModelRecord | undefined;
        if (!model || !model.lastKnownGoodVersion) {
          resolve(null);
          return;
        }
        const lkg = model.lastKnownGoodVersion;
        const previousActive = model.activeVersion;
        model.activeVersion = lkg;
        model.lastKnownGoodVersion = previousActive;
        model.updatedAt = Date.now();
        const putReq = store.put(model);
        putReq.onsuccess = () => resolve(lkg);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async finalizeActiveVersion(modelId: string): Promise<string | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MODELS, 'readwrite');
      const store = tx.objectStore(STORE_MODELS);
      const req = store.get(modelId);
      let supersededVersion: string | null = null;

      req.onsuccess = () => {
        const model = req.result as ModelRecord | undefined;
        if (!model || !model.lastKnownGoodVersion) return;
        supersededVersion = model.lastKnownGoodVersion;
        model.lastKnownGoodVersion = null;
        model.updatedAt = Date.now();
        store.put(model);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(supersededVersion);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async deleteVersion(modelId: string, version: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_MODELS, STORE_VERSIONS], 'readwrite');
      const modelStore = tx.objectStore(STORE_MODELS);
      const versionStore = tx.objectStore(STORE_VERSIONS);

      versionStore.delete([modelId, version]);

      const getModelReq = modelStore.get(modelId);
      getModelReq.onsuccess = () => {
        const model = getModelReq.result as ModelRecord | undefined;
        if (model) {
          let changed = false;
          if (model.activeVersion === version) {
            model.activeVersion = null;
            changed = true;
          }
          if (model.lastKnownGoodVersion === version) {
            model.lastKnownGoodVersion = null;
            changed = true;
          }
          if (changed) {
            model.updatedAt = Date.now();
            modelStore.put(model);
          }
        }
        resolve();
      };
      getModelReq.onerror = () => reject(getModelReq.error);
    });
  }

  async listVersions(modelId: string): Promise<ModelVersionRecord[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VERSIONS, 'readonly');
      const store = tx.objectStore(STORE_VERSIONS);
      const index = store.index('by_modelId');
      const req = index.getAll(modelId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async clearAll(): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_MODELS, STORE_VERSIONS], 'readwrite');
      tx.objectStore(STORE_MODELS).clear();
      tx.objectStore(STORE_VERSIONS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}

/**
 * In-memory fallback / testing implementation of ModelMetadataStore.
 */
export class InMemoryModelMetadataStore implements ModelMetadataStore {
  private models = new Map<string, ModelRecord>();
  private versions = new Map<string, ModelVersionRecord>();

  private vKey(modelId: string, version: string): string {
    return `${modelId}::${version}`;
  }

  async getModel(modelId: string): Promise<ModelRecord | null> {
    return this.models.get(modelId) || null;
  }

  async listModels(): Promise<ModelRecord[]> {
    return [...this.models.values()].map(record => ({...record}));
  }

  async saveModel(record: ModelRecord): Promise<void> {
    this.models.set(record.modelId, {...record});
  }

  async getVersion(
    modelId: string,
    version: string,
  ): Promise<ModelVersionRecord | null> {
    return this.versions.get(this.vKey(modelId, version)) || null;
  }

  async saveVersion(record: ModelVersionRecord): Promise<void> {
    this.versions.set(this.vKey(record.modelId, record.version), {...record});
  }

  async updateDownloadOffset(
    modelId: string,
    version: string,
    offset: number,
  ): Promise<void> {
    const record = await this.getVersion(modelId, version);
    if (!record) throw new Error(`Version [${modelId}, ${version}] not found`);
    record.downloadOffset = offset;
    record.updatedAt = Date.now();
    await this.saveVersion(record);
  }

  async setVerificationState(
    modelId: string,
    version: string,
    state: VerificationState,
  ): Promise<void> {
    const record = await this.getVersion(modelId, version);
    if (!record) throw new Error(`Version [${modelId}, ${version}] not found`);
    record.verificationState = state;
    record.updatedAt = Date.now();
    await this.saveVersion(record);
  }

  async setActiveVersion(modelId: string, version: string): Promise<void> {
    const ver = await this.getVersion(modelId, version);
    if (!ver) throw new Error(`Cannot activate nonexistent version ${version}`);
    const now = Date.now();
    const existing = await this.getModel(modelId);
    const prevActive = existing?.activeVersion || null;
    await this.saveModel({
      modelId,
      activeVersion: version,
      lastKnownGoodVersion:
        prevActive && prevActive !== version
          ? prevActive
          : existing?.lastKnownGoodVersion || null,
      updatedAt: now,
    });
    ver.lastUsedAt = now;
    ver.updatedAt = now;
    await this.saveVersion(ver);
  }

  async markVersionVerifiedAndActive(
    modelId: string,
    version: string,
  ): Promise<void> {
    const ver = await this.getVersion(modelId, version);
    if (!ver) throw new Error(`Version [${modelId}, ${version}] not found`);
    const now = Date.now();
    ver.verificationState = 'verified';
    ver.downloadOffset = ver.sizeBytes;
    ver.lastUsedAt = now;
    ver.updatedAt = now;
    await this.saveVersion(ver);

    const existing = await this.getModel(modelId);
    const prevActive = existing?.activeVersion || null;
    await this.saveModel({
      modelId,
      activeVersion: version,
      lastKnownGoodVersion:
        prevActive && prevActive !== version
          ? prevActive
          : existing?.lastKnownGoodVersion || null,
      updatedAt: now,
    });
  }

  async rollbackToLastKnownGood(modelId: string): Promise<string | null> {
    const model = await this.getModel(modelId);
    if (!model || !model.lastKnownGoodVersion) return null;
    const lkg = model.lastKnownGoodVersion;
    const previousActive = model.activeVersion;
    model.activeVersion = lkg;
    model.lastKnownGoodVersion = previousActive;
    model.updatedAt = Date.now();
    await this.saveModel(model);
    return lkg;
  }

  async finalizeActiveVersion(modelId: string): Promise<string | null> {
    const model = await this.getModel(modelId);
    if (!model?.lastKnownGoodVersion) return null;
    const supersededVersion = model.lastKnownGoodVersion;
    model.lastKnownGoodVersion = null;
    model.updatedAt = Date.now();
    await this.saveModel(model);
    return supersededVersion;
  }

  async deleteVersion(modelId: string, version: string): Promise<void> {
    this.versions.delete(this.vKey(modelId, version));
    const model = await this.getModel(modelId);
    if (model) {
      let changed = false;
      if (model.activeVersion === version) {
        model.activeVersion = null;
        changed = true;
      }
      if (model.lastKnownGoodVersion === version) {
        model.lastKnownGoodVersion = null;
        changed = true;
      }
      if (changed) {
        model.updatedAt = Date.now();
        await this.saveModel(model);
      }
    }
  }

  async listVersions(modelId: string): Promise<ModelVersionRecord[]> {
    const list: ModelVersionRecord[] = [];
    for (const record of this.versions.values()) {
      if (record.modelId === modelId) list.push({...record});
    }
    return list;
  }

  async clearAll(): Promise<void> {
    this.models.clear();
    this.versions.clear();
  }

  async recoverCorruptedDatabase(): Promise<void> {
    await this.clearAll();
  }

  async close(): Promise<void> {
    // No-op for in-memory
  }
}
