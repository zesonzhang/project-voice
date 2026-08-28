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
import {LANGUAGES} from '../language.js';
import {LocalSuggestionProvider} from '../local-suggestion-provider.js';
import {FakeModelRuntimeAdapter} from '../on-device/fake-runtime-adapter.js';
import {ModelManager} from '../on-device/model-manager.js';
import {ModelManifest} from '../on-device/model-manifest.js';
import {InMemoryModelMetadataStore} from '../on-device/model-metadata.js';
import {OpfsModelStorage} from '../on-device/model-storage.js';
import {TEST_ONLY} from '../pv-app.js';
import {State} from '../state.js';
import {SuggestionProviderRouter} from '../suggestion-provider-router.js';

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

describe('M3 End-to-End CUJ & Privacy Verification', () => {
  let state: State;
  let fakeAdapter: FakeModelRuntimeAdapter;
  let modelManager: ModelManager;
  let metadataStore: InMemoryModelMetadataStore;
  let storage: OpfsModelStorage;
  let router: SuggestionProviderRouter;
  let appElement: InstanceType<typeof TEST_ONLY.PvAppElement>;
  let fetchSpy: jasmine.Spy;

  beforeEach(async () => {
    state = new State(new ConfigStorage('test-m3-e2e', CONFIG_DEFAULT));
    state.lang = LANGUAGES['englishWithSingleRowKeyboard'];
    state.inferenceMode = 'cloud';

    fakeAdapter = new FakeModelRuntimeAdapter();
    metadataStore = new InMemoryModelMetadataStore();
    storage = new OpfsModelStorage();

    // Prepare installed model in storage & metadata
    await metadataStore.saveModel({
      modelId: TEST_MANIFEST.modelId,
      activeVersion: TEST_MANIFEST.version,
      lastKnownGoodVersion: TEST_MANIFEST.version,
      updatedAt: Date.now(),
    });
    await metadataStore.saveVersion({
      modelId: TEST_MANIFEST.modelId,
      version: TEST_MANIFEST.version,
      manifest: TEST_MANIFEST,
      fileName: `${TEST_MANIFEST.version}.litertlm`,
      partialFileName: `${TEST_MANIFEST.version}.partial`,
      sizeBytes: TEST_MANIFEST.sizeBytes,
      sha256: TEST_MANIFEST.sha256,
      gcsGeneration: TEST_MANIFEST.gcsGeneration,
      downloadOffset: TEST_MANIFEST.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    spyOn(storage, 'hasModel').and.returnValue(Promise.resolve(true));
    spyOn(storage, 'getModelFileSize').and.returnValue(
      Promise.resolve(TEST_MANIFEST.sizeBytes),
    );
    spyOn(storage, 'openModelFile').and.returnValue(
      Promise.resolve(
        new File([new Uint8Array(TEST_MANIFEST.sizeBytes)], 'model.litertlm'),
      ),
    );

    modelManager = new ModelManager({
      metadataStore,
      storage,
      apiClient: {
        getDefaultManifest: async () => TEST_MANIFEST,
        getSignedDownloadUrl: async () => ({
          url: 'https://test',
          expiresAt: '2026-08-28T00:00:00Z',
          sizeBytes: TEST_MANIFEST.sizeBytes,
          sha256: TEST_MANIFEST.sha256,
          gcsGeneration: TEST_MANIFEST.gcsGeneration,
        }),
      },
      runtimeAdapter: fakeAdapter,
      smokeTestHook: async () => true,
      webgpuChecker: async () => true,
    });

    // Mock fetch to track network calls
    fetchSpy = spyOn(window, 'fetch').and.callFake(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/run-macro')) {
          return new Response(
            JSON.stringify({
              response: ['1. Cloud sentence 1', '2. Cloud sentence 2'],
            }),
            {status: 200, headers: {'Content-Type': 'application/json'}},
          );
        }
        return new Response('{}', {status: 200});
      },
    );

    const localProvider = new LocalSuggestionProvider(
      fakeAdapter,
      () => ({
        modelId: TEST_MANIFEST.modelId,
        modelVersion: TEST_MANIFEST.version,
      }),
      () => modelManager.getState() === 'ready',
    );

    router = new SuggestionProviderRouter(
      () => ({
        mode: 'cloud',
        abort: () => {},
        getIdentity: () => ({modelId: 'gemini', modelVersion: '1'}),
        suggest: async () => {
          await window.fetch('/run-macro', {method: 'POST'});
          return {
            sentences: ['Cloud result'],
            words: ['cloudword'],
            provider: 'cloud',
          };
        },
      }),
      localProvider,
    );

    appElement = new TEST_ONLY.PvAppElement(state, router, modelManager);
  });

  afterEach(() => {
    if (appElement) {
      window.clearTimeout(
        (appElement as unknown as {timeoutId?: number}).timeoutId,
      );
      (
        appElement as unknown as {providers?: {abort(): void}}
      ).providers?.abort();
    }
  });

  it('verifies complete CUJ: mode switch, auto-load, local inference, and zero network calls', async () => {
    // 1. Cloud mode initially
    state.text = 'help';
    await appElement.updateSuggestions();
    await new Promise(resolve => window.setTimeout(resolve, 350));

    expect(fetchSpy).toHaveBeenCalled();
    const cloudCalls = fetchSpy.calls
      .allArgs()
      .filter(args => String(args[0]).includes('/run-macro'));
    expect(cloudCalls.length).toBeGreaterThan(0);

    fetchSpy.calls.reset();

    // 2. Switch to Local mode
    state.inferenceMode = 'local';
    // Initialize and load active model
    await modelManager.startup(true);
    expect(modelManager.getState()).toBe('ready');
    expect(fakeAdapter.isLoaded).toBeTrue();
    // Re-selecting Local mode must be idempotent and must not demote a loaded
    // runtime back to the downloaded state.
    await modelManager.startup(true);
    expect(modelManager.getState()).toBe('ready');

    // 3. User types in Local mode
    state.text = 'hello world';
    await appElement.updateSuggestions();
    await new Promise(resolve => window.setTimeout(resolve, 250));

    // 4. Assert suggestions are populated by Local provider
    expect(appElement.suggestions.length).toBeGreaterThan(0);
    expect(appElement.words.length).toBeGreaterThan(0);
    expect(appElement.words).toContain('localword');

    // 5. CRITICAL PRIVACY CHECK: Zero calls to /run-macro or network while in local mode
    const macroNetworkCalls = fetchSpy.calls
      .allArgs()
      .filter(args => String(args[0]).includes('/run-macro'));
    expect(macroNetworkCalls.length).toBe(0);
  });

  it('enforces strict zero-fallback: retains local mode and does not silently call Cloud when local model is unloaded', async () => {
    state.inferenceMode = 'local';
    fetchSpy.calls.reset();
    const alertSpy = spyOn(window, 'alert');

    // Initialize modelManager so it discovers the verified model
    await modelManager.initialize();
    // Ensure model is unloaded
    await modelManager.unloadActiveModel();
    expect(modelManager.getState()).toBe('downloaded');

    state.text = 'private message';
    await appElement.updateSuggestions();
    await new Promise(resolve => window.setTimeout(resolve, 350));

    // Must NOT call Cloud
    const macroNetworkCalls = fetchSpy.calls
      .allArgs()
      .filter(args => String(args[0]).includes('/run-macro'));
    expect(macroNetworkCalls.length).toBe(0);

    // Mode must remain local
    expect(state.inferenceMode).toBe('local');
    expect(alertSpy).toHaveBeenCalledWith(
      'Local model is not loaded or ready.',
    );
  });

  it('disposes the runtime before removing the active model', async () => {
    await modelManager.startup(true);
    const disposeSpy = spyOn(fakeAdapter, 'dispose').and.callThrough();
    spyOn(storage, 'deleteModel').and.resolveTo();
    spyOn(storage, 'deletePartial').and.resolveTo();

    await modelManager.removeModel(
      TEST_MANIFEST.modelId,
      TEST_MANIFEST.version,
    );

    expect(disposeSpy).toHaveBeenCalled();
    expect(fakeAdapter.isLoaded).toBeFalse();
    expect(modelManager.getState()).toBe('not_downloaded');
  });
});
