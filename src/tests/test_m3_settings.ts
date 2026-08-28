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
import {FakeModelRuntimeAdapter} from '../on-device/fake-runtime-adapter.js';
import {ModelManager} from '../on-device/model-manager.js';
import {ModelManifest} from '../on-device/model-manifest.js';
import {InMemoryModelMetadataStore} from '../on-device/model-metadata.js';
import {OpfsModelStorage} from '../on-device/model-storage.js';
import {PvSettingPanel} from '../pv-setting-panel.js';
import {State} from '../state.js';

const TEST_MANIFEST: ModelManifest = {
  schemaVersion: 1,
  modelId: 'gemma-4-e2b-it-web',
  version: '2026-08-01',
  displayName: 'Gemma 4 E2B Web',
  family: 'gemma',
  adapterId: 'litert-lm',
  format: 'litertlm',
  sizeBytes: 2008432640,
  sha256: '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5',
  gcsGeneration: '1700000000000001',
  capabilities: {
    textGeneration: true,
    languages: ['en', 'ja'],
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

describe('M3 Settings Panel & Model Card', () => {
  let panel: PvSettingPanel;
  let state: State;
  let modelManager: ModelManager;
  let runtimeAdapter: FakeModelRuntimeAdapter;

  beforeEach(() => {
    state = new State(new ConfigStorage('test-m3-settings', CONFIG_DEFAULT));
    runtimeAdapter = new FakeModelRuntimeAdapter();

    modelManager = new ModelManager({
      metadataStore: new InMemoryModelMetadataStore(),
      storage: new OpfsModelStorage(),
      apiClient: {
        getDefaultManifest: async () => TEST_MANIFEST,
        getSignedDownloadUrl: async () => ({
          url: 'https://storage.googleapis.com/test',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: TEST_MANIFEST.sizeBytes,
          sha256: TEST_MANIFEST.sha256,
          gcsGeneration: TEST_MANIFEST.gcsGeneration,
        }),
      },
      runtimeAdapter,
      webgpuChecker: async () => true,
    });

    panel = new PvSettingPanel();
    panel.state = state;
    panel.modelManager = modelManager;
    document.body.appendChild(panel);
  });

  afterEach(() => {
    panel.remove();
  });

  it('renders Cloud model selector when inferenceMode is cloud', async () => {
    state.inferenceMode = 'cloud';
    await panel.updateComplete;

    const content = (panel.renderRoot as HTMLElement).innerHTML;
    expect(content).toContain('Cloud AI Model');
    expect(content).toContain('Gemini 3.1 Flash Lite');
    expect(content).not.toContain('model-card');
  });

  it('renders On-Device Model Card when inferenceMode is local', async () => {
    state.inferenceMode = 'local';
    await panel.updateComplete;

    const content = (panel.renderRoot as HTMLElement).innerHTML;
    expect(content).not.toContain('Cloud AI Model');
    expect(content).toContain('model-card');
    expect(content).toContain('Gemma On-device');
    expect(content).toContain(
      'When On-device is selected, suggestion text is not sent to Gemini.',
    );
    expect(content).toContain('Resource &amp; Diagnostics');
    expect(content).not.toContain('Import Local Model');
  });

  it('shows local model import only when the debug feature is enabled', async () => {
    state.inferenceMode = 'local';
    panel.enableDebugModelImport = true;
    await panel.updateComplete;

    expect((panel.renderRoot as HTMLElement).innerHTML).toContain(
      'Import Local Model',
    );
  });

  it('displays Download button when model is not downloaded', async () => {
    state.inferenceMode = 'local';
    await panel.updateComplete;

    const content = (panel.renderRoot as HTMLElement).innerHTML;
    expect(content).toContain('Download Required');
    expect(content).toContain('Download');
  });

  it('updates state badge to Ready when model is loaded', async () => {
    state.inferenceMode = 'local';
    // Simulate model ready
    spyOn(modelManager, 'getState').and.returnValue('ready');
    spyOn(modelManager, 'getActiveManifest').and.returnValue(TEST_MANIFEST);
    panel.requestUpdate();
    await panel.updateComplete;

    const content = (panel.renderRoot as HTMLElement).innerHTML;
    expect(content).toContain('Ready (Active)');
    expect(content).toContain('Unload');
    expect(content).toContain('Remove');
  });

  it('displays actionable error message when modelManager reports an error', async () => {
    state.inferenceMode = 'local';
    spyOn(modelManager, 'getState').and.returnValue('error');
    spyOn(modelManager, 'getError').and.returnValue({
      code: 'ERR_INSUFFICIENT_STORAGE',
      message: 'Not enough disk space',
    });
    panel.requestUpdate();
    await panel.updateComplete;

    const content = (panel.renderRoot as HTMLElement).innerHTML;
    expect(content).toContain('Insufficient storage space to download model');
    expect(content).toContain('Retry');
  });

  it('shows confirmation dialog before removing model', async () => {
    state.inferenceMode = 'local';
    spyOn(modelManager, 'getState').and.returnValue('ready');
    spyOn(modelManager, 'getActiveManifest').and.returnValue(TEST_MANIFEST);
    panel.requestUpdate();
    await panel.updateComplete;

    const removeBtn = Array.from(
      panel.renderRoot.querySelectorAll('md-text-button'),
    ).find(btn => btn.textContent?.trim() === 'Remove');
    expect(removeBtn).toBeDefined();

    removeBtn?.click();
    await panel.updateComplete;

    const removeDialog = panel.renderRoot.querySelector(
      '#remove-confirm-dialog',
    );
    expect(removeDialog).not.toBeNull();
    expect(removeDialog?.innerHTML).toContain('Remove Local Model?');
  });
});
