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
  exportPrivacySafeDiagnostics,
  sanitizeDiagnosticText,
} from '../on-device/diagnostics-exporter.js';
import {ModelManager} from '../on-device/model-manager.js';
import {ModelManifest} from '../on-device/model-manifest.js';
import {InMemoryModelMetadataStore} from '../on-device/model-metadata.js';
import {InMemoryModelStorage} from '../on-device/model-storage.js';
import {
  LifecycleBroadcastMessage,
  TabCoordinator,
} from '../on-device/tab-coordinator.js';

class MockTabCoordinator implements TabCoordinator {
  async acquireDownloadLock<T>(
    _modelId: string,
    _version: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return await action();
  }
  broadcastProgress(_progress: LifecycleBroadcastMessage): void {
    void _progress;
  }
  broadcastStateChange(_change: LifecycleBroadcastMessage): void {
    void _change;
  }
  onMessage(_listener: (msg: LifecycleBroadcastMessage) => void): () => void {
    void _listener;
    return () => {};
  }
  close(): void {}
}

const DIAG_MANIFEST: ModelManifest = {
  schemaVersion: 1,
  modelId: 'gemma-diag-test',
  version: '2026-08-01',
  displayName: 'Gemma Diag Web',
  family: 'gemma',
  adapterId: 'litert-lm',
  format: 'litertlm',
  sizeBytes: 2008432640,
  sha256: '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5',
  gcsGeneration: '1700000000000001',
  capabilities: {
    textGeneration: true,
    languages: ['en'],
    maxInputTokens: 2048,
    maxOutputTokens: 256,
  },
  requirements: {
    webgpu: true,
    minimumDeviceMemoryGB: 8,
    minimumFreeStorageBytes: 2500000000,
  },
  generation: {
    temperature: 0,
    topP: 0.5,
    maxOutputTokens: 256,
  },
};

describe('Privacy-Safe Local Diagnostics Export', () => {
  let metadataStore: InMemoryModelMetadataStore;
  let storage: InMemoryModelStorage;
  let manager: ModelManager;

  beforeEach(async () => {
    metadataStore = new InMemoryModelMetadataStore();
    storage = new InMemoryModelStorage();

    await metadataStore.saveModel({
      modelId: DIAG_MANIFEST.modelId,
      activeVersion: DIAG_MANIFEST.version,
      lastKnownGoodVersion: DIAG_MANIFEST.version,
      updatedAt: Date.now(),
    });
    await metadataStore.saveVersion({
      modelId: DIAG_MANIFEST.modelId,
      version: DIAG_MANIFEST.version,
      manifest: DIAG_MANIFEST,
      fileName: `${DIAG_MANIFEST.version}.litertlm`,
      partialFileName: `${DIAG_MANIFEST.version}.partial`,
      sizeBytes: DIAG_MANIFEST.sizeBytes,
      sha256: DIAG_MANIFEST.sha256,
      gcsGeneration: DIAG_MANIFEST.gcsGeneration,
      downloadOffset: DIAG_MANIFEST.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    manager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator: new MockTabCoordinator(),
      apiClient: {
        getDefaultManifest: async () => DIAG_MANIFEST,
        getSignedDownloadUrl: async () => ({
          url: 'https://storage.googleapis.com/bucket/model.bin?generation=1&sig=SECRET_SIGNATURE_KEY',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: DIAG_MANIFEST.sizeBytes,
          sha256: DIAG_MANIFEST.sha256,
          gcsGeneration: DIAG_MANIFEST.gcsGeneration,
        }),
      },
      webgpuChecker: async () => true,
    });

    await manager.initialize();
  });

  it('sanitizes signed GCS URLs, query signatures, and auth tokens from error strings', () => {
    const rawError =
      'Download failed on url https://storage.googleapis.com/test-bucket/model.bin?generation=123&X-Goog-Signature=abcdef0123456789 with Bearer token_secret_12345';
    const sanitized = sanitizeDiagnosticText(rawError);

    expect(sanitized).not.toContain('X-Goog-Signature');
    expect(sanitized).not.toContain('token_secret_12345');
    expect(sanitized).toContain('[REDACTED_SIGNED_URL]');
    expect(sanitized).toContain('Bearer [REDACTED]');
  });

  it('generates a complete privacy-safe diagnostic report snapshot', async () => {
    const report = await exportPrivacySafeDiagnostics(manager);

    expect(report.schemaVersion).toBe(1);
    expect(report.exportedAt).toBeTruthy();
    expect(report.systemInfo.webgpuSupported).toBeTrue();
    expect(report.lifecycle.currentState).toBe('not_downloaded');
    expect(report.lifecycle.transitionHistory.length).toBeGreaterThanOrEqual(1);

    // Verify storage reporting
    expect(report.storage.installedVersions.length).toBe(1);
    expect(report.storage.installedVersions[0].modelId).toBe(
      DIAG_MANIFEST.modelId,
    );
    expect(report.storage.installedVersions[0].verificationState).toBe(
      'verified',
    );

    // Strict Privacy Verification
    expect(report.privacyVerification.userTextIncluded).toBeFalse();
    expect(report.privacyVerification.personaIncluded).toBeFalse();
    expect(report.privacyVerification.conversationHistoryIncluded).toBeFalse();
    expect(report.privacyVerification.signedUrlsIncluded).toBeFalse();

    const json = JSON.stringify(report);
    expect(json).not.toContain('SECRET_SIGNATURE_KEY');
  });
});
