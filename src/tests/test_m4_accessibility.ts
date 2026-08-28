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

import {ConfigStorage} from '../config-storage.js';
import {CONFIG_DEFAULT} from '../constants.js';
import {ModelManager} from '../on-device/model-manager.js';
import {ModelManifest} from '../on-device/model-manifest.js';
import {InMemoryModelMetadataStore} from '../on-device/model-metadata.js';
import {InMemoryModelStorage} from '../on-device/model-storage.js';
import {
  LifecycleBroadcastMessage,
  TabCoordinator,
} from '../on-device/tab-coordinator.js';
import {PvSettingPanel} from '../pv-setting-panel.js';
import {State} from '../state.js';

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

const A11Y_MANIFEST: ModelManifest = {
  schemaVersion: 1,
  modelId: 'gemma-a11y-test',
  version: '2026-08-01',
  displayName: 'Gemma A11y Web',
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

describe('M4.9 Accessibility Review & Remediation', () => {
  let panel: PvSettingPanel;
  let state: State;
  let modelManager: ModelManager;

  beforeEach(async () => {
    state = new State(new ConfigStorage('test-m4-a11y', CONFIG_DEFAULT));
    state.inferenceMode = 'local';

    const metadataStore = new InMemoryModelMetadataStore();
    const storage = new InMemoryModelStorage();

    modelManager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator: new MockTabCoordinator(),
      apiClient: {
        getDefaultManifest: async () => A11Y_MANIFEST,
        getSignedDownloadUrl: async () => ({
          url: 'https://test',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: A11Y_MANIFEST.sizeBytes,
          sha256: A11Y_MANIFEST.sha256,
          gcsGeneration: A11Y_MANIFEST.gcsGeneration,
        }),
      },
      webgpuChecker: async () => true,
    });

    panel = new PvSettingPanel();
    panel.state = state;
    panel.modelManager = modelManager;
    document.body.appendChild(panel);
    await panel.updateComplete;
  });

  afterEach(() => {
    if (panel && panel.parentNode) {
      panel.remove();
    }
  });

  it('renders download progress bar with complete ARIA progressbar semantics and live region', async () => {
    // Simulate downloading state with progress
    (
      panel as unknown as {activeSettingsTabIndex: number}
    ).activeSettingsTabIndex = 0;
    (panel as unknown as {downloadProgress: unknown}).downloadProgress = {
      bytesDownloaded: 1004216320,
      totalBytes: 2008432640,
      percentage: 50,
      speedBps: 25000000,
      isResumed: false,
    };
    // Force transition to downloading
    (modelManager as unknown as {state: string}).state = 'downloading';
    panel.requestUpdate();
    await panel.updateComplete;

    const shadowRoot = panel.shadowRoot!;
    const progressContainer = shadowRoot.querySelector(
      '.model-progress-container',
    );
    expect(progressContainer).not.toBeNull();
    expect(progressContainer?.getAttribute('role')).toBe('progressbar');
    expect(progressContainer?.getAttribute('aria-valuenow')).toBe('50');
    expect(progressContainer?.getAttribute('aria-valuemin')).toBe('0');
    expect(progressContainer?.getAttribute('aria-valuemax')).toBe('100');
    expect(progressContainer?.getAttribute('aria-label')).toBeTruthy();

    const progressText = shadowRoot.querySelector(
      '.model-progress-container .progress-text',
    );
    expect(progressText).not.toBeNull();
    expect(progressText?.getAttribute('role')).toBe('status');
    expect(progressText?.getAttribute('aria-live')).toBe('polite');
  });

  it('provides assertive live region alert for actionable on-device errors', async () => {
    (panel as unknown as {actionError: string}).actionError =
      'GPU memory allocation failed';
    panel.requestUpdate();
    await panel.updateComplete;

    const shadowRoot = panel.shadowRoot!;
    const errorNotice = shadowRoot.querySelector('.error-notice');
    expect(errorNotice).not.toBeNull();
    expect(errorNotice?.getAttribute('role')).toBe('alert');
    expect(errorNotice?.getAttribute('aria-live')).toBe('assertive');
    expect(errorNotice?.textContent).toContain('GPU memory allocation failed');
  });

  it('provides polite status live region for privacy notices', async () => {
    const shadowRoot = panel.shadowRoot!;
    const privacyNotice = shadowRoot.querySelector('.privacy-notice');
    expect(privacyNotice).not.toBeNull();
    expect(privacyNotice?.getAttribute('role')).toBe('status');
    expect(privacyNotice?.getAttribute('aria-live')).toBe('polite');
    expect(privacyNotice?.textContent).toContain('not sent to Gemini');
  });

  it('configures remove confirmation dialog with alertdialog role and label associations', async () => {
    const shadowRoot = panel.shadowRoot!;
    const removeDialog = shadowRoot.querySelector('#remove-confirm-dialog');
    expect(removeDialog).not.toBeNull();
    expect(removeDialog?.getAttribute('role')).toBe('alertdialog');
    expect(removeDialog?.getAttribute('aria-labelledby')).toBe(
      'remove-confirm-headline',
    );
    expect(removeDialog?.getAttribute('aria-describedby')).toBe(
      'remove-confirm-content',
    );
  });

  it('restores focus to trigger button after remove confirmation dialog closes', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    // Trigger dialog open with mock event
    (
      panel as unknown as {onConfirmRemoveClick: (e: unknown) => void}
    ).onConfirmRemoveClick({
      currentTarget: button,
    });
    expect(
      (panel as unknown as {showRemoveConfirm: boolean}).showRemoveConfirm,
    ).toBeTrue();

    // Close dialog
    (
      panel as unknown as {onRemoveDialogClosed: () => void}
    ).onRemoveDialogClosed();
    expect(
      (panel as unknown as {showRemoveConfirm: boolean}).showRemoveConfirm,
    ).toBeFalse();

    // Focus restored to button
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});
