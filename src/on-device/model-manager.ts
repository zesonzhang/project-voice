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

import {StreamingSha256, verifyArtifactDigest} from './hash-verifier.js';
import {ModelApiClient, SignedDownloadUrlResponse} from './model-client.js';
import {ModelManifest} from './model-manifest.js';
import {ModelMetadataStore, ModelVersionRecord} from './model-metadata.js';
import {ModelRuntimeAdapter} from './model-runtime-adapter.js';
import {ModelStorage} from './model-storage.js';
import {BrowserTabCoordinator, TabCoordinator} from './tab-coordinator.js';

export type ModelLifecycleState =
  | 'unsupported'
  | 'not_downloaded'
  | 'downloading'
  | 'verifying'
  | 'downloaded'
  | 'loading'
  | 'ready'
  | 'generating'
  | 'update_available'
  | 'error';

export type ModelErrorCode =
  | 'ERR_WEBGPU_UNSUPPORTED'
  | 'ERR_ADAPTER_UNSUPPORTED'
  | 'ERR_STORAGE_UNSUPPORTED'
  | 'ERR_INSUFFICIENT_STORAGE'
  | 'ERR_PERSISTENCE_DENIED'
  | 'ERR_DOWNLOAD_FAILED'
  | 'ERR_URL_EXPIRED'
  | 'ERR_RANGE_NOT_SATISFIABLE'
  | 'ERR_GENERATION_MISMATCH'
  | 'ERR_CHECKSUM_MISMATCH'
  | 'ERR_LOAD_FAILED'
  | 'ERR_SMOKE_TEST_FAILED'
  | 'ERR_TAB_LOCKED';

export interface PreflightCheckResult {
  supported: boolean;
  webgpuSupported: boolean;
  opfsSupported: boolean;
  workerSupported: boolean;
  httpsOrLocal: boolean;
  persistenceGranted: boolean;
  quotaAvailableBytes: number;
  quotaTotalBytes: number;
  errorMessage?: string;
  errorCode?: ModelErrorCode;
}

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
  speedBps: number;
  isResumed: boolean;
}

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

class ModelManagerError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelManagerError';
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

  private downloadAbortController: AbortController | null = null;
  private currentSignedUrlInfo: SignedDownloadUrlResponse | null = null;
  private currentSignedUrlKey: string | null = null;

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
  private readonly adapterChecker: (
    adapterId: string,
  ) => boolean | Promise<boolean>;
  private readonly fetchImpl: typeof fetch;
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
    this.adapterChecker =
      options.adapterChecker || (adapterId => adapterId === 'litert-lm');
    this.fetchImpl =
      options.customFetch ||
      (typeof fetch !== 'undefined'
        ? fetch
        : (null as unknown as typeof fetch));

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
    this.state = newState;
    if (error) {
      this.currentErrorCode = error.code;
      this.currentErrorMessage = error.message;
    } else if (newState !== 'error') {
      this.currentErrorCode = null;
      this.currentErrorMessage = null;
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

  /**
   * M2.9 Preflight check for WebGPU, OPFS, Worker, storage quota, and persistent storage.
   */
  async checkCapabilities(
    requiredSizeBytes?: number,
    adapterId = 'litert-lm',
  ): Promise<PreflightCheckResult> {
    const isHttpsOrLocal =
      typeof window !== 'undefined'
        ? window.isSecureContext ||
          location.hostname === 'localhost' ||
          location.hostname === '127.0.0.1'
        : true;

    const opfsSupported =
      typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

    const workerSupported = typeof Worker !== 'undefined';

    let webgpuSupported = false;
    if (this.webgpuChecker) {
      try {
        webgpuSupported = await this.webgpuChecker();
      } catch {
        webgpuSupported = false;
      }
    } else if (
      typeof navigator !== 'undefined' &&
      'gpu' in navigator &&
      (navigator as {gpu?: {requestAdapter?: () => Promise<unknown>}}).gpu
    ) {
      try {
        const gpu = (
          navigator as {gpu?: {requestAdapter?: () => Promise<unknown>}}
        ).gpu;
        const adapter = await gpu?.requestAdapter?.();
        webgpuSupported = !!adapter;
      } catch {
        webgpuSupported = false;
      }
    }

    let quotaAvailable = Number.MAX_SAFE_INTEGER;
    let quotaTotal = Number.MAX_SAFE_INTEGER;
    if (this.quotaEstimator) {
      try {
        const est = await this.quotaEstimator();
        quotaTotal = est.quota || Number.MAX_SAFE_INTEGER;
        quotaAvailable = Math.max(0, (est.quota || 0) - (est.usage || 0));
      } catch {
        // Ignored
      }
    } else if (
      typeof navigator !== 'undefined' &&
      navigator.storage?.estimate
    ) {
      try {
        const est = await navigator.storage.estimate();
        quotaTotal = est.quota || Number.MAX_SAFE_INTEGER;
        quotaAvailable = Math.max(0, (est.quota || 0) - (est.usage || 0));
      } catch {
        // Ignored
      }
    }

    let persistenceGranted = false;
    if (typeof navigator !== 'undefined' && navigator.storage?.persisted) {
      try {
        persistenceGranted = await navigator.storage.persisted();
      } catch {
        persistenceGranted = false;
      }
    }

    let adapterSupported = false;
    try {
      adapterSupported = await this.adapterChecker(adapterId);
    } catch {
      adapterSupported = false;
    }

    if (
      !isHttpsOrLocal ||
      !opfsSupported ||
      !workerSupported ||
      !webgpuSupported ||
      !adapterSupported
    ) {
      const missing: string[] = [];
      if (!isHttpsOrLocal) missing.push('Secure context (HTTPS)');
      if (!opfsSupported) missing.push('Origin Private File System (OPFS)');
      if (!workerSupported) missing.push('Web Workers');
      if (!webgpuSupported) missing.push('WebGPU adapter');
      if (!adapterSupported) missing.push(`Runtime adapter (${adapterId})`);

      return {
        supported: false,
        webgpuSupported,
        opfsSupported,
        workerSupported,
        httpsOrLocal: isHttpsOrLocal,
        persistenceGranted,
        quotaAvailableBytes: quotaAvailable,
        quotaTotalBytes: quotaTotal,
        errorCode: !adapterSupported
          ? 'ERR_ADAPTER_UNSUPPORTED'
          : !webgpuSupported
            ? 'ERR_WEBGPU_UNSUPPORTED'
            : 'ERR_STORAGE_UNSUPPORTED',
        errorMessage: `Hardware/browser capabilities missing: ${missing.join(', ')}`,
      };
    }

    // Require model size + 20% headroom
    if (requiredSizeBytes) {
      const requiredWithHeadroom = requiredSizeBytes * 1.2;
      if (quotaAvailable < requiredWithHeadroom) {
        return {
          supported: false,
          webgpuSupported,
          opfsSupported,
          workerSupported,
          httpsOrLocal: isHttpsOrLocal,
          persistenceGranted,
          quotaAvailableBytes: quotaAvailable,
          quotaTotalBytes: quotaTotal,
          errorCode: 'ERR_INSUFFICIENT_STORAGE',
          errorMessage: `Insufficient disk quota. Required: ${Math.round(requiredWithHeadroom / 1e6)} MB, Available: ${Math.round(quotaAvailable / 1e6)} MB`,
        };
      }
    }

    return {
      supported: true,
      webgpuSupported,
      opfsSupported,
      workerSupported,
      httpsOrLocal: isHttpsOrLocal,
      persistenceGranted,
      quotaAvailableBytes: quotaAvailable,
      quotaTotalBytes: quotaTotal,
    };
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

      // Record initial metadata if missing
      let versionRecord = await this.metadataStore.getVersion(
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
        await this.metadataStore.saveVersion(versionRecord);
      } else if (
        versionRecord.sizeBytes !== manifest.sizeBytes ||
        versionRecord.sha256 !== manifest.sha256 ||
        versionRecord.gcsGeneration !== manifest.gcsGeneration
      ) {
        // A version label may never silently point at different bytes.
        await this.storage.deletePartial(manifest.modelId, manifest.version);
        throw new Error(
          'Stored metadata conflicts with the immutable model manifest',
        );
      }

      // Check current partial file size in OPFS
      let startOffset = await this.storage.getPartialSize(
        manifest.modelId,
        manifest.version,
      );
      if (startOffset > manifest.sizeBytes) {
        // Corrupted oversized partial; reset
        await this.storage.deletePartial(manifest.modelId, manifest.version);
        startOffset = 0;
        await this.metadataStore.updateDownloadOffset(
          manifest.modelId,
          manifest.version,
          0,
        );
      }

      // If already complete, jump straight to verification
      if (startOffset === manifest.sizeBytes) {
        await this.verifyAndPromote(manifest);
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
        await this.storage.deletePartial(manifest.modelId, manifest.version);
        startOffset = 0;
        await this.metadataStore.updateDownloadOffset(
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
        await this.storage.deletePartial(manifest.modelId, manifest.version);
        startOffset = 0;
        await this.metadataStore.updateDownloadOffset(
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
          await this.storage.writeChunk(
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
            currentSpeedBps = Math.round(
              (speedSampleBytes / speedElapsed) * 1000,
            );
            speedSampleBytes = 0;
            speedSampleTime = now;
          }

          // Persist offset to IndexedDB periodically (every 1MB or 500ms)
          if (
            now - lastPersistTime >= 500 ||
            bytesDownloaded - lastPersistedOffset >= 1024 * 1024 ||
            bytesDownloaded === manifest.sizeBytes
          ) {
            await this.metadataStore.updateDownloadOffset(
              manifest.modelId,
              manifest.version,
              bytesDownloaded,
            );
            lastPersistTime = now;
            lastPersistedOffset = bytesDownloaded;
          }

          const percentage = Math.min(
            100,
            Math.round((bytesDownloaded / manifest.sizeBytes) * 100),
          );

          const progressMsg: DownloadProgress = {
            bytesDownloaded,
            totalBytes: manifest.sizeBytes,
            percentage,
            speedBps: currentSpeedBps,
            isResumed: startOffset > 0,
          };

          for (const listener of this.progressListeners) {
            listener(progressMsg);
          }

          this.tabCoordinator.broadcastProgress({
            type: 'DOWNLOAD_PROGRESS',
            modelId: manifest.modelId,
            version: manifest.version,
            bytesDownloaded,
            totalBytes: manifest.sizeBytes,
            speedBps: currentSpeedBps,
            percentage,
          });
        }
      }

      if (bytesDownloaded !== manifest.sizeBytes) {
        throw new Error(
          `Download ended at ${bytesDownloaded} of ${manifest.sizeBytes} bytes`,
        );
      }

      // Download completed; proceed to verification
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

  private async getValidSignedUrl(
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
    const info = await this.apiClient.getSignedDownloadUrl(
      manifest.modelId,
      manifest.version,
      abortSignal,
    );
    this.validateSignedUrlResponse(info, manifest);
    this.currentSignedUrlInfo = info;
    this.currentSignedUrlKey = cacheKey;
    return info;
  }

  private validateSignedUrlResponse(
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

  private validateDownloadResponse(
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
    if (!this.activeManifest) {
      await this.downloadModel(newManifest);
      return;
    }

    // storage.estimate().usage already includes the active model, so available
    // quota only needs to fit the candidate plus its safety headroom.
    await this.downloadModel(newManifest);
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
    if (!file || file.size <= 0) {
      throw new ModelManagerError('ERR_LOAD_FAILED', 'Invalid model file');
    }
    if (!file.name.toLowerCase().endsWith('.litertlm')) {
      throw new ModelManagerError(
        'ERR_LOAD_FAILED',
        'Local model imports must use the .litertlm file extension.',
      );
    }
    const modelId = 'imported';
    const version = `v-${Date.now()}`;
    const chunkSize = 2 * 1024 * 1024;
    const hasher = new StreamingSha256();

    let offset = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, Math.min(file.size, offset + chunkSize));
      const arrayBuffer = await slice.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      hasher.update(bytes);
      await this.storage.writeChunk(modelId, version, bytes, offset);
      offset += bytes.byteLength;
    }
    await this.storage.promotePartialToModel(modelId, version);
    const sha256 = hasher.digest();

    const manifest: ModelManifest = {
      schemaVersion: 1,
      modelId,
      version,
      displayName: file.name.replace(/\.litertlm$/, ''),
      family: 'gemma',
      adapterId: 'litert-lm',
      format: 'litertlm',
      sizeBytes: file.size,
      sha256,
      gcsGeneration: '0',
      capabilities: {
        textGeneration: true,
        languages: ['en', 'ja', 'zh', 'fr', 'de', 'sv'],
        maxInputTokens: 2048,
        maxOutputTokens: 256,
      },
      requirements: {
        webgpu: true,
        minimumDeviceMemoryGB: 8,
        minimumFreeStorageBytes: Math.round(file.size * 1.2),
      },
      generation: {
        temperature: 0,
        topP: 0.5,
        maxOutputTokens: 256,
      },
    };

    await this.metadataStore.saveVersion({
      modelId,
      version,
      manifest,
      fileName: `${version}.litertlm`,
      partialFileName: `${version}.partial`,
      sizeBytes: file.size,
      sha256,
      gcsGeneration: '0',
      downloadOffset: file.size,
      verificationState: 'verified',
      importStatus: 'unverified_import',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    await this.activateCandidate(manifest);
  }
}
