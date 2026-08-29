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

import {verifyArtifactDigest} from './hash-verifier.js';
import {checkCapabilities, PreflightCheckResult} from './model-capabilities.js';
import {ModelApiClient} from './model-client.js';
import {ModelDownloader} from './model-downloader.js';
import {importLocalModel} from './model-importer.js';
import {
  DownloadProgress,
  ModelErrorCode,
  ModelLifecycleState,
  ModelManagerError,
} from './model-lifecycle.js';
import {ModelManifest} from './model-manifest.js';
import {ModelMetadataStore, ModelVersionRecord} from './model-metadata.js';
import {ModelRuntimeAdapter} from './model-runtime-adapter.js';
import {ModelStorage} from './model-storage.js';
import {BrowserTabCoordinator, TabCoordinator} from './tab-coordinator.js';

export {PreflightCheckResult} from './model-capabilities.js';
export {
  DownloadProgress,
  ModelErrorCode,
  ModelLifecycleState,
  ModelManagerError,
} from './model-lifecycle.js';

export interface ModelManagerOptions {
  metadataStore: ModelMetadataStore;
  storage: ModelStorage;
  apiClient: ModelApiClient;
  runtimeAdapter?: ModelRuntimeAdapter;
  tabCoordinator?: TabCoordinator;
  smokeTestHook?: (file: File, manifest: ModelManifest) => Promise<boolean>;
  persistenceRequester?: () => Promise<boolean>;
  quotaEstimator?: () => Promise<{quota?: number; usage?: number}>;
  webgpuChecker?: () => Promise<boolean>;
  crossOriginIsolatedChecker?: () => boolean;
  deviceMemoryChecker?: () => number | undefined;
  adapterChecker?: (adapterId: string) => boolean | Promise<boolean>;
  customFetch?: typeof fetch;
}

/**
 * Production candidate model probe and smoke test hook.
 * Verifies candidate file readability, non-empty size matching manifest,
 * and valid adapter identity.
 */
export async function defaultModelCandidateProbe(
  file: File,
  manifest: ModelManifest,
): Promise<boolean> {
  if (!file || file.size !== manifest.sizeBytes) {
    return false;
  }
  if (manifest.adapterId !== 'litert-lm') {
    return false;
  }
  try {
    const slice = file.slice(0, Math.min(1024, file.size));
    const buffer = await slice.arrayBuffer();
    return !(buffer.byteLength === 0 && manifest.sizeBytes > 0);
  } catch {
    return false;
  }
}

const LEGAL_STATE_TRANSITIONS: Record<
  ModelLifecycleState,
  ReadonlySet<ModelLifecycleState>
> = {
  unsupported: new Set(['not_downloaded', 'error']),
  not_downloaded: new Set([
    'unsupported',
    'downloading',
    'downloaded',
    'update_available',
    'error',
  ]),
  downloading: new Set([
    'not_downloaded',
    'verifying',
    'loading',
    'ready',
    'error',
  ]),
  verifying: new Set(['loading', 'error']),
  downloaded: new Set(['loading', 'downloading', 'update_available', 'error']),
  loading: new Set(['ready', 'error']),
  ready: new Set([
    'generating',
    'downloading',
    'downloaded',
    'update_available',
    'not_downloaded',
    'error',
  ]),
  generating: new Set(['ready', 'error']),
  update_available: new Set([
    'downloading',
    'ready',
    'not_downloaded',
    'error',
  ]),
  error: new Set([
    'unsupported',
    'not_downloaded',
    'downloading',
    'downloaded',
    'loading',
    'ready',
    'update_available',
  ]),
};

export interface StateTransitionRecord {
  timestamp: number;
  from: ModelLifecycleState;
  to: ModelLifecycleState;
  modelId?: string;
  version?: string;
  errorCode?: ModelErrorCode;
}

/**
 * ModelManager orchestrates the complete on-device model lifecycle:
 * Preflight capabilities, resumable Range downloads, streaming SHA-256 verification,
 * IndexedDB/OPFS reconciliation, atomic updates, and rollback.
 */
export class ModelManager {
  private state: ModelLifecycleState = 'not_downloaded';
  private activeManifest: ModelManifest | null = null;
  private currentErrorCode: ModelErrorCode | null = null;
  private currentErrorMessage: string | null = null;
  private transitionHistory: StateTransitionRecord[] = [];

  private downloadAbortController: AbortController | null = null;
  private readonly metadataStore: ModelMetadataStore;
  private readonly storage: ModelStorage;
  private readonly apiClient: ModelApiClient;
  private readonly tabCoordinator: TabCoordinator;
  private readonly smokeTestHook: (
    file: File,
    manifest: ModelManifest,
  ) => Promise<boolean>;
  private readonly persistenceRequester?: () => Promise<boolean>;
  private readonly quotaEstimator?: () => Promise<{
    quota?: number;
    usage?: number;
  }>;
  private readonly webgpuChecker?: () => Promise<boolean>;
  private readonly crossOriginIsolatedChecker?: () => boolean;
  private readonly deviceMemoryChecker?: () => number | undefined;
  private readonly adapterChecker: (
    adapterId: string,
  ) => boolean | Promise<boolean>;
  private readonly downloader: ModelDownloader;
  private runtimeAdapter?: ModelRuntimeAdapter;
  private startupTask: Promise<void> | null = null;
  private startupAutoLoadRequested = false;

  private stateListeners = new Set<
    (
      state: ModelLifecycleState,
      error?: {code: ModelErrorCode; message: string},
    ) => void
  >();
  private progressListeners = new Set<(progress: DownloadProgress) => void>();
  private verificationListeners = new Set<(percentage: number) => void>();

  constructor(options: ModelManagerOptions) {
    this.metadataStore = options.metadataStore;
    this.storage = options.storage;
    this.apiClient = options.apiClient;
    this.runtimeAdapter = options.runtimeAdapter;
    this.tabCoordinator = options.tabCoordinator || new BrowserTabCoordinator();
    this.smokeTestHook = options.smokeTestHook || defaultModelCandidateProbe;
    this.persistenceRequester = options.persistenceRequester;
    this.quotaEstimator = options.quotaEstimator;
    this.webgpuChecker = options.webgpuChecker;
    this.crossOriginIsolatedChecker = options.crossOriginIsolatedChecker;
    this.deviceMemoryChecker = options.deviceMemoryChecker;
    this.adapterChecker =
      options.adapterChecker || (adapterId => adapterId === 'litert-lm');
    this.downloader = new ModelDownloader({
      storage: this.storage,
      metadataStore: this.metadataStore,
      apiClient: this.apiClient,
      fetchImpl: options.customFetch,
      onProgress: progress => this.reportDownloadProgress(progress),
    });

    this.tabCoordinator.onMessage(msg => {
      if (
        msg.type === 'DOWNLOAD_PROGRESS' &&
        this.activeManifest?.modelId === msg.modelId
      ) {
        for (const listener of this.progressListeners) {
          listener({
            bytesDownloaded: msg.bytesDownloaded,
            totalBytes: msg.totalBytes,
            percentage: msg.percentage,
            speedBps: msg.speedBps,
            isResumed: true,
          });
        }
      } else if (
        msg.type === 'STATE_CHANGE' &&
        this.activeManifest?.modelId === msg.modelId
      ) {
        if (msg.state !== this.state) {
          this.transitionTo(msg.state as ModelLifecycleState);
        }
      }
    });
  }

  private reportDownloadProgress(progress: DownloadProgress): void {
    for (const listener of this.progressListeners) {
      listener(progress);
    }
    const manifest = this.activeManifest;
    if (!manifest) return;
    this.tabCoordinator.broadcastProgress({
      type: 'DOWNLOAD_PROGRESS',
      modelId: manifest.modelId,
      version: manifest.version,
      bytesDownloaded: progress.bytesDownloaded,
      totalBytes: progress.totalBytes,
      speedBps: progress.speedBps,
      percentage: progress.percentage,
    });
  }

  setRuntimeAdapter(adapter: ModelRuntimeAdapter): void {
    this.runtimeAdapter = adapter;
  }

  getRuntimeAdapter(): ModelRuntimeAdapter | undefined {
    return this.runtimeAdapter;
  }

  /**
   * M3.3 Loads active OPFS candidate model into runtime adapter and runs smoke verification.
   */
  async loadActiveModel(): Promise<void> {
    if (this.state === 'ready') return;
    if (!this.activeManifest) {
      throw new ModelManagerError(
        'ERR_LOAD_FAILED',
        'No active model manifest configured to load.',
      );
    }
    const modelId = this.activeManifest.modelId;
    const activeRecord = await this.metadataStore.getModel(modelId);
    const version = activeRecord?.activeVersion ?? this.activeManifest.version;
    const file = await this.storage.openModelFile(modelId, version);

    this.transitionTo('loading');
    try {
      if (this.runtimeAdapter) {
        await this.runtimeAdapter.load(this.activeManifest, file);
        const smokePassed = await this.smokeTestHook(file, this.activeManifest);
        if (!smokePassed) {
          throw new ModelManagerError(
            'ERR_SMOKE_TEST_FAILED',
            'Model activation smoke test failed.',
          );
        }
      }
      this.transitionTo('ready');
    } catch (err: unknown) {
      const code =
        err instanceof ModelManagerError ? err.code : 'ERR_LOAD_FAILED';
      const message = err instanceof Error ? err.message : String(err);
      this.transitionTo('error', {
        code,
        message: `Failed to load model: ${message}`,
      });
      throw err;
    }
  }

  /**
   * Unloads active model from runtime adapter, freeing GPU/RAM.
   */
  async unloadActiveModel(): Promise<void> {
    if (this.runtimeAdapter) {
      await this.runtimeAdapter.dispose();
    }
    if (this.state === 'ready' || this.state === 'loading') {
      this.transitionTo('downloaded');
    }
  }

  /**
   * M3.3 Startup reconciliation and optional automatic load.
   */
  async startup(autoLoad = false): Promise<void> {
    this.startupAutoLoadRequested ||= autoLoad;
    if (this.state === 'ready') return;
    if (this.startupTask) return this.startupTask;

    this.startupTask = (async () => {
      if (this.state !== 'downloaded') {
        await this.initialize();
      }
      if (this.startupAutoLoadRequested && this.state === 'downloaded') {
        await this.loadActiveModel();
      }
    })().finally(() => {
      this.startupTask = null;
      this.startupAutoLoadRequested = false;
    });
    return this.startupTask;
  }

  getState(): ModelLifecycleState {
    return this.state;
  }

  getActiveManifest(): ModelManifest | null {
    return this.activeManifest;
  }

  async getActiveVersionMetadata(): Promise<ModelVersionRecord | null> {
    const manifest = this.activeManifest;
    if (!manifest) return null;
    const model = await this.metadataStore.getModel(manifest.modelId);
    const version = model?.activeVersion ?? manifest.version;
    return this.metadataStore.getVersion(manifest.modelId, version);
  }

  getError(): {code: ModelErrorCode; message: string} | null {
    if (!this.currentErrorCode) return null;
    return {
      code: this.currentErrorCode,
      message: this.currentErrorMessage || '',
    };
  }

  onStateChange(
    listener: (
      state: ModelLifecycleState,
      error?: {code: ModelErrorCode; message: string},
    ) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onDownloadProgress(
    listener: (progress: DownloadProgress) => void,
  ): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onVerificationProgress(listener: (percentage: number) => void): () => void {
    this.verificationListeners.add(listener);
    return () => this.verificationListeners.delete(listener);
  }

  private transitionTo(
    newState: ModelLifecycleState,
    error?: {code: ModelErrorCode; message: string},
  ): void {
    if (
      newState !== this.state &&
      !LEGAL_STATE_TRANSITIONS[this.state].has(newState)
    ) {
      throw new Error(
        `Illegal model lifecycle transition: ${this.state} -> ${newState}`,
      );
    }
    const oldState = this.state;
    this.state = newState;
    if (error) {
      this.currentErrorCode = error.code;
      this.currentErrorMessage = error.message;
    } else if (newState !== 'error') {
      this.currentErrorCode = null;
      this.currentErrorMessage = null;
    }

    this.transitionHistory.push({
      timestamp: Date.now(),
      from: oldState,
      to: newState,
      modelId: this.activeManifest?.modelId,
      version: this.activeManifest?.version,
      errorCode: error?.code,
    });
    if (this.transitionHistory.length > 50) {
      this.transitionHistory.shift();
    }

    if (this.activeManifest) {
      this.tabCoordinator.broadcastStateChange({
        type: 'STATE_CHANGE',
        modelId: this.activeManifest.modelId,
        version: this.activeManifest.version,
        state: newState,
        error: error?.message,
      });
    }

    for (const listener of this.stateListeners) {
      try {
        listener(newState, error);
      } catch (err) {
        console.error('Error in state listener:', err);
      }
    }
  }

  getTransitionHistory(): StateTransitionRecord[] {
    return [...this.transitionHistory];
  }

  getStorage(): ModelStorage {
    return this.storage;
  }

  getMetadataStore(): ModelMetadataStore {
    return this.metadataStore;
  }

  /**
   * M2.9 Preflight check for WebGPU, OPFS, Worker, storage quota, and persistent storage.
   */
  async checkCapabilities(
    requiredSizeBytes?: number,
    adapterId = 'litert-lm',
    requirements: {
      minimumDeviceMemoryGB?: number;
      minimumFreeStorageBytes?: number;
    } = {},
  ): Promise<PreflightCheckResult> {
    return checkCapabilities(
      requiredSizeBytes,
      adapterId,
      {
        webgpuChecker: this.webgpuChecker,
        crossOriginIsolatedChecker: this.crossOriginIsolatedChecker,
        deviceMemoryChecker: this.deviceMemoryChecker,
        quotaEstimator: this.quotaEstimator,
        adapterChecker: this.adapterChecker,
      },
      requirements,
    );
  }

  /**
   * M2.13 Startup initialization and reconciliation.
   * Reconciles IndexedDB and OPFS with zero network calls for already installed models.
   */
  async initialize(): Promise<void> {
    const preflight = await this.checkCapabilities();
    if (!preflight.supported) {
      this.transitionTo('unsupported', {
        code: preflight.errorCode || 'ERR_WEBGPU_UNSUPPORTED',
        message: preflight.errorMessage || 'System does not meet requirements',
      });
      return;
    }

    // Restore local state before touching the catalog. This keeps startup
    // independent of a hard-coded model ID and works while offline.
    const modelRecords = await this.metadataStore.listModels();
    for (const modelRecord of modelRecords) {
      if (!modelRecord.activeVersion) continue;
      const versionRecord = await this.metadataStore.getVersion(
        modelRecord.modelId,
        modelRecord.activeVersion,
      );

      if (versionRecord && versionRecord.verificationState === 'verified') {
        const fileExists = await this.storage.hasModel(
          modelRecord.modelId,
          versionRecord.version,
        );
        if (fileExists) {
          const fileSize = await this.storage.getModelFileSize(
            modelRecord.modelId,
            versionRecord.version,
          );
          if (fileSize === versionRecord.sizeBytes) {
            // Valid active verified model found in OPFS! Zero network re-download needed.
            this.activeManifest = versionRecord.manifest;
            this.transitionTo('downloaded');
            return;
          }
        }
      }
    }

    try {
      this.activeManifest = await this.apiClient.getDefaultManifest();
    } catch {
      // Offline or default manifest unavailable.
    }

    this.transitionTo('not_downloaded');
  }

  /** Check catalog metadata explicitly without downloading model bytes. */
  async checkForUpdate(): Promise<ModelManifest | null> {
    const remoteManifest = await this.apiClient.getDefaultManifest();
    const modelRecord = await this.metadataStore.getModel(
      remoteManifest.modelId,
    );
    if (modelRecord?.activeVersion) {
      const installed = await this.metadataStore.getVersion(
        remoteManifest.modelId,
        modelRecord.activeVersion,
      );
      if (installed) this.activeManifest = installed.manifest;
    } else {
      this.activeManifest = remoteManifest;
    }
    if (
      modelRecord?.activeVersion &&
      modelRecord.activeVersion !== remoteManifest.version
    ) {
      this.transitionTo('update_available');
      return remoteManifest;
    }
    return null;
  }

  /**
   * M2.10 & M2.11 Resumable, streaming download with Range requests, URL refresh, and Web Locks.
   */
  async downloadModel(targetManifest?: ModelManifest): Promise<void> {
    const manifest = targetManifest || this.activeManifest;
    if (!manifest) {
      throw new Error('No model manifest provided for download');
    }
    this.activeManifest = manifest;

    // 1. Preflight capabilities & storage quota (model size + 20% headroom)
    const preflight = await this.checkCapabilities(
      manifest.sizeBytes,
      manifest.adapterId,
      manifest.requirements,
    );
    if (!preflight.supported) {
      this.transitionTo('error', {
        code: preflight.errorCode || 'ERR_INSUFFICIENT_STORAGE',
        message: preflight.errorMessage || 'Preflight check failed',
      });
      return;
    }

    // 2. Request persistent storage on user action
    if (this.persistenceRequester) {
      try {
        await this.persistenceRequester();
      } catch {
        // Warning only, do not block
      }
    } else if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      try {
        await navigator.storage.persist();
      } catch {
        // Warning only
      }
    }

    // 3. Acquire download lock across tabs
    await this.tabCoordinator.acquireDownloadLock(
      manifest.modelId,
      manifest.version,
      async () => {
        await this.executeDownload(manifest);
      },
      () => {
        // Lock contended by another tab
        this.transitionTo('downloading');
      },
    );
  }

  private async executeDownload(manifest: ModelManifest): Promise<void> {
    this.transitionTo('downloading');
    this.downloadAbortController = new AbortController();
    const abortSignal = this.downloadAbortController.signal;

    try {
      // Another tab may have completed the same version while this tab waited
      // for the Web Lock. Reconcile instead of downloading it a second time.
      const completedRecord = await this.metadataStore.getVersion(
        manifest.modelId,
        manifest.version,
      );
      const completedModel = await this.metadataStore.getModel(
        manifest.modelId,
      );
      if (
        completedRecord?.verificationState === 'verified' &&
        completedRecord.sizeBytes === manifest.sizeBytes &&
        completedRecord.sha256 === manifest.sha256 &&
        completedRecord.gcsGeneration === manifest.gcsGeneration &&
        (await this.storage.hasModel(manifest.modelId, manifest.version)) &&
        (await this.storage.getModelFileSize(
          manifest.modelId,
          manifest.version,
        )) === manifest.sizeBytes
      ) {
        if (completedModel?.activeVersion === manifest.version) {
          this.activeManifest = completedRecord.manifest;
          this.transitionTo('ready');
        } else {
          await this.activateCandidate(manifest);
        }
        return;
      }

      await this.downloader.downloadArtifact(manifest, abortSignal);
      await this.verifyAndPromote(manifest);
    } catch (err: unknown) {
      if (abortSignal.aborted) {
        this.transitionTo('not_downloaded');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.transitionTo('error', {
        code:
          err instanceof ModelManagerError ? err.code : 'ERR_DOWNLOAD_FAILED',
        message: `Download failed: ${message}`,
      });
    }
  }

  /**
   * M2.12 Streaming SHA-256 verification and atomic promotion.
   */
  private async verifyAndPromote(manifest: ModelManifest): Promise<void> {
    this.transitionTo('verifying');
    await this.metadataStore.setVerificationState(
      manifest.modelId,
      manifest.version,
      'verifying',
    );

    const verification = await verifyArtifactDigest(
      this.storage,
      manifest.modelId,
      manifest.version,
      manifest.sha256,
      manifest.sizeBytes,
      true, // isPartial
      progress => {
        for (const listener of this.verificationListeners) {
          listener(progress.percentage);
        }
      },
    );

    if (!verification.verified) {
      // Checksum mismatch! Immediately delete corrupted candidate file (M2.12)
      await this.storage.deletePartial(manifest.modelId, manifest.version);
      await this.metadataStore.setVerificationState(
        manifest.modelId,
        manifest.version,
        'corrupt',
      );
      this.transitionTo('error', {
        code: 'ERR_CHECKSUM_MISMATCH',
        message:
          verification.errorMessage ||
          'Candidate model checksum does not match manifest',
      });
      return;
    }

    // Checksum verified! Promote partial file to model artifact
    await this.storage.promotePartialToModel(
      manifest.modelId,
      manifest.version,
    );
    await this.metadataStore.setVerificationState(
      manifest.modelId,
      manifest.version,
      'verified',
    );

    // M2.13 Activate candidate model through smoke test hook
    await this.activateCandidate(manifest);
  }

  /**
   * M2.13 Probe and smoke test hook integration before marking active.
   */
  async activateCandidate(manifest: ModelManifest): Promise<void> {
    this.transitionTo('loading');
    let activationPhase: 'load' | 'smoke' = 'load';
    try {
      const file = await this.storage.openModelFile(
        manifest.modelId,
        manifest.version,
      );
      if (this.runtimeAdapter) {
        await this.runtimeAdapter.load(manifest, file);
      }
      activationPhase = 'smoke';
      const smokeTestPassed = await this.smokeTestHook(file, manifest);
      if (!smokeTestPassed) {
        throw new Error('Smoke test failed for model candidate');
      }

      // Atomically mark verified and active in IndexedDB
      await this.metadataStore.markVersionVerifiedAndActive(
        manifest.modelId,
        manifest.version,
      );
      this.activeManifest = manifest;
      this.transitionTo('ready');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.transitionTo('error', {
        code:
          activationPhase === 'load'
            ? 'ERR_LOAD_FAILED'
            : 'ERR_SMOKE_TEST_FAILED',
        message: `Model activation ${activationPhase} failed: ${message}`,
      });
    }
  }

  /**
   * M2.10 Pause/Cancel download, retaining partial file and offset in IndexedDB.
   */
  pauseDownload(): void {
    if (this.downloadAbortController) {
      this.downloadAbortController.abort();
      this.downloadAbortController = null;
    }
    this.transitionTo('not_downloaded');
  }

  /**
   * M2.14 Manual update: Download new candidate beside active model,
   * activate after smoke test, retain LKG, and clean up superseded version.
   */
  async updateModel(newManifest: ModelManifest): Promise<void> {
    const previousManifest = this.activeManifest;
    if (!previousManifest) {
      await this.downloadModel(newManifest);
      return;
    }

    // storage.estimate().usage already includes the active model, so available
    // quota only needs to fit the candidate plus its safety headroom.
    await this.downloadModel(newManifest);
    if (this.state !== 'error') return;

    const updateError = this.getError();
    try {
      if (this.runtimeAdapter) {
        const previousFile = await this.storage.openModelFile(
          previousManifest.modelId,
          previousManifest.version,
        );
        await this.runtimeAdapter.load(previousManifest, previousFile);
      }
      this.activeManifest = previousManifest;
      this.transitionTo('ready');
    } catch (error) {
      this.transitionTo('error', {
        code: 'ERR_LOAD_FAILED',
        message: `Update failed and the previous model could not be restored: ${(error as Error).message}`,
      });
      return;
    }

    if (updateError) {
      throw new ModelManagerError(updateError.code, updateError.message);
    }
  }

  /**
   * Commit an activated update after its first successful real suggestion.
   * Until this boundary, the exact last-known-good artifact remains available
   * for rollback.
   */
  async confirmActiveVersionHealthy(): Promise<void> {
    if (!this.activeManifest || this.state !== 'ready') return;
    const supersededVersion = await this.metadataStore.finalizeActiveVersion(
      this.activeManifest.modelId,
    );
    if (!supersededVersion) return;
    await this.storage.deleteModel(
      this.activeManifest.modelId,
      supersededVersion,
    );
    await this.metadataStore.deleteVersion(
      this.activeManifest.modelId,
      supersededVersion,
    );
  }

  /**
   * M2.14 Rollback to last known good version.
   */
  async rollback(): Promise<boolean> {
    if (!this.activeManifest) return false;
    const modelRecord = await this.metadataStore.getModel(
      this.activeManifest.modelId,
    );
    const rolledBackVersion = modelRecord?.lastKnownGoodVersion;
    if (!rolledBackVersion) return false;
    const versionRecord = await this.metadataStore.getVersion(
      this.activeManifest.modelId,
      rolledBackVersion,
    );
    if (
      versionRecord?.verificationState === 'verified' &&
      (await this.storage.hasModel(
        this.activeManifest.modelId,
        rolledBackVersion,
      )) &&
      (await this.storage.getModelFileSize(
        this.activeManifest.modelId,
        rolledBackVersion,
      )) === versionRecord.sizeBytes
    ) {
      if (this.runtimeAdapter) {
        try {
          const file = await this.storage.openModelFile(
            this.activeManifest.modelId,
            rolledBackVersion,
          );
          await this.runtimeAdapter.load(versionRecord.manifest, file);
        } catch (error) {
          this.transitionTo('error', {
            code: 'ERR_LOAD_FAILED',
            message: `Failed to load rollback model: ${(error as Error).message}`,
          });
          return false;
        }
      }
      await this.metadataStore.rollbackToLastKnownGood(
        this.activeManifest.modelId,
      );
      this.activeManifest = versionRecord.manifest;
      this.transitionTo('ready');
      return true;
    }
    return false;
  }

  /**
   * Remove model and clean up storage and metadata.
   */
  async removeModel(modelId: string, version: string): Promise<void> {
    const removingActiveModel =
      this.activeManifest?.modelId === modelId &&
      this.activeManifest.version === version;
    if (removingActiveModel && this.runtimeAdapter) {
      await this.runtimeAdapter.dispose();
    }
    await this.storage.deleteModel(modelId, version);
    await this.storage.deletePartial(modelId, version);
    await this.metadataStore.deleteVersion(modelId, version);
    if (removingActiveModel) {
      this.transitionTo('not_downloaded');
      this.activeManifest = null;
    }
  }

  /**
   * M2.16 Cleans up orphaned or incomplete partial files and unreferenced models from storage.
   */
  async cleanupOrphanPartials(modelId: string): Promise<string[]> {
    const cleaned: string[] = [];
    const versions = await this.metadataStore.listVersions(modelId);
    for (const ver of versions) {
      if (
        ver.verificationState === 'corrupt' ||
        ver.verificationState === 'unverified'
      ) {
        if (await this.storage.hasPartial(modelId, ver.version)) {
          await this.storage.deletePartial(modelId, ver.version);
          cleaned.push(`${ver.version}.partial`);
        }
      }
    }
    return cleaned;
  }

  /**
   * M3.10 Development/debug model import.
   * Copies .litertlm file into OPFS, computes SHA-256, records unverified candidate,
   * probes and loads model, and marks active.
   */
  async importLocalModel(file: File): Promise<void> {
    await importLocalModel(file, {
      storage: this.storage,
      metadataStore: this.metadataStore,
      activateCandidate: manifest => this.activateCandidate(manifest),
    });
  }
}
