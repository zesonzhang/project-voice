/**
 * Shared contracts for the on-device model lifecycle.
 *
 * Keep these definitions independent from ModelManager so domain services can
 * report lifecycle errors and progress without importing the coordinator.
 */
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

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
  speedBps: number;
  isResumed: boolean;
}

export class ModelManagerError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelManagerError';
  }
}
