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
import {HttpModelApiClient} from '../on-device/model-client.js';
import {ModelManager} from '../on-device/model-manager.js';
import {ModelManifest} from '../on-device/model-manifest.js';
import {InMemoryModelMetadataStore} from '../on-device/model-metadata.js';
import {OpfsModelStorage} from '../on-device/model-storage.js';
import {
  LifecycleBroadcastMessage,
  TabCoordinator,
} from '../on-device/tab-coordinator.js';
import {TEST_ONLY} from '../pv-app.js';
import {State} from '../state.js';
import {SuggestionProviderRouter} from '../suggestion-provider-router.js';

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

const PRIVACY_TEST_MANIFEST: ModelManifest = {
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

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

describe('Local inference privacy (mocked network)', () => {
  let state: State;
  let fakeAdapter: FakeModelRuntimeAdapter;
  let modelManager: ModelManager;
  let metadataStore: InMemoryModelMetadataStore;
  let storage: OpfsModelStorage;
  let localProvider: LocalSuggestionProvider;
  let router: SuggestionProviderRouter;
  let appElement: InstanceType<typeof TEST_ONLY.PvAppElement>;
  let capturedRequests: CapturedRequest[];
  let alertSpy: jasmine.Spy;

  beforeEach(async () => {
    capturedRequests = [];
    alertSpy = spyOn(window, 'alert');

    state = new State(new ConfigStorage('test-local-inference-privacy', CONFIG_DEFAULT));
    state.lang = LANGUAGES['englishWithSingleRowKeyboard'];
    state.inferenceMode = 'local';

    fakeAdapter = new FakeModelRuntimeAdapter();
    metadataStore = new InMemoryModelMetadataStore();
    storage = new OpfsModelStorage();

    await metadataStore.saveModel({
      modelId: PRIVACY_TEST_MANIFEST.modelId,
      activeVersion: PRIVACY_TEST_MANIFEST.version,
      lastKnownGoodVersion: PRIVACY_TEST_MANIFEST.version,
      updatedAt: Date.now(),
    });
    await metadataStore.saveVersion({
      modelId: PRIVACY_TEST_MANIFEST.modelId,
      version: PRIVACY_TEST_MANIFEST.version,
      manifest: PRIVACY_TEST_MANIFEST,
      fileName: `${PRIVACY_TEST_MANIFEST.version}.litertlm`,
      partialFileName: `${PRIVACY_TEST_MANIFEST.version}.partial`,
      sizeBytes: PRIVACY_TEST_MANIFEST.sizeBytes,
      sha256: PRIVACY_TEST_MANIFEST.sha256,
      gcsGeneration: PRIVACY_TEST_MANIFEST.gcsGeneration,
      downloadOffset: PRIVACY_TEST_MANIFEST.sizeBytes,
      verificationState: 'verified',
      importStatus: 'certified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    spyOn(storage, 'hasModel').and.returnValue(Promise.resolve(true));
    spyOn(storage, 'getModelFileSize').and.returnValue(
      Promise.resolve(PRIVACY_TEST_MANIFEST.sizeBytes),
    );
    spyOn(storage, 'openModelFile').and.returnValue(
      Promise.resolve(
        new File(
          [new Uint8Array(PRIVACY_TEST_MANIFEST.sizeBytes)],
          'model.litertlm',
        ),
      ),
    );

    // Wire-level fetch interceptor recording all outgoing requests
    spyOn(window, 'fetch').and.callFake(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        let url = '';
        if (typeof input === 'string') {
          url = input;
        } else if (input instanceof URL) {
          url = input.toString();
        } else if (input && typeof input === 'object' && 'url' in input) {
          url = (input as Request).url;
        }

        const method = init?.method || 'GET';
        const headers: Record<string, string> = {};
        if (init?.headers) {
          if (init.headers instanceof Headers) {
            init.headers.forEach((v, k) => {
              headers[k] = v;
            });
          } else if (Array.isArray(init.headers)) {
            init.headers.forEach(([k, v]) => {
              headers[k] = v;
            });
          } else {
            Object.assign(headers, init.headers);
          }
        }

        let body: string | null = null;
        if (init?.body) {
          if (typeof init.body === 'string') {
            body = init.body;
          } else if (init.body instanceof FormData) {
            const entries: Record<string, string> = {};
            init.body.forEach((val, key) => {
              entries[key] = String(val);
            });
            body = JSON.stringify(entries);
          } else {
            body = '[binary/other]';
          }
        }

        capturedRequests.push({url, method, headers, body});

        if (url.includes('/run-macro')) {
          return new Response(
            JSON.stringify({
              response: ['1. Leak sentence', '2. Leak sentence'],
            }),
            {status: 200, headers: {'Content-Type': 'application/json'}},
          );
        }

        if (url.includes('/api/on-device-models/default')) {
          return new Response(JSON.stringify(PRIVACY_TEST_MANIFEST), {
            status: 200,
            headers: {'Content-Type': 'application/json'},
          });
        }

        if (url.includes('/download-url')) {
          return new Response(
            JSON.stringify({
              url: 'https://storage.googleapis.com/test-bucket/model.litertlm?generation=1',
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              sizeBytes: PRIVACY_TEST_MANIFEST.sizeBytes,
              sha256: PRIVACY_TEST_MANIFEST.sha256,
              gcsGeneration: PRIVACY_TEST_MANIFEST.gcsGeneration,
            }),
            {status: 200, headers: {'Content-Type': 'application/json'}},
          );
        }

        return new Response('{}', {status: 200});
      },
    );

    modelManager = new ModelManager({
      metadataStore,
      storage,
      tabCoordinator: new MockTabCoordinator(),
      apiClient: new HttpModelApiClient(),
      runtimeAdapter: fakeAdapter,
      smokeTestHook: async () => true,
      webgpuChecker: async () => true,
    });

    localProvider = new LocalSuggestionProvider(
      fakeAdapter,
      () => ({
        modelId: PRIVACY_TEST_MANIFEST.modelId,
        modelVersion: PRIVACY_TEST_MANIFEST.version,
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
    await modelManager.startup(true);
    expect(modelManager.getState()).toBe('ready');
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

  function assertZeroCloudOrDataLeaks(sensitiveTokens: string[]) {
    const macroCalls = capturedRequests.filter(r =>
      r.url.includes('/run-macro'),
    );
    expect(macroCalls.length)
      .withContext('Must have exactly 0 calls to /run-macro')
      .toBe(0);

    for (const req of capturedRequests) {
      for (const token of sensitiveTokens) {
        expect(req.url.toLowerCase())
          .withContext(
            `URL ${req.url} must not contain sensitive token '${token}'`,
          )
          .not.toContain(token.toLowerCase());

        if (req.body) {
          expect(req.body.toLowerCase())
            .withContext(
              `Request body must not contain sensitive token '${token}'`,
            )
            .not.toContain(token.toLowerCase());
        }

        for (const [headerName, headerVal] of Object.entries(req.headers)) {
          expect(headerVal.toLowerCase())
            .withContext(
              `Header ${headerName} must not contain sensitive token '${token}'`,
            )
            .not.toContain(token.toLowerCase());
        }
      }
    }
  }

  it('checks zero network calls and zero data leaks during continuous typing and suggestion updates in Local mode', async () => {
    const sensitiveTokens = [
      'confidentialMedicalDiagnosis',
      'bankAccount98765',
    ];

    state.persona = 'Patient with ALS, privacy sensitive';
    state.text = `My ${sensitiveTokens[0]} and ${sensitiveTokens[1]}`;

    await appElement.updateSuggestions();
    await new Promise(resolve => window.setTimeout(resolve, 350));

    expect(appElement.suggestions.length).toBeGreaterThan(0);
    expect(appElement.words.length).toBeGreaterThan(0);

    assertZeroCloudOrDataLeaks(sensitiveTokens);
    expect(capturedRequests.length).toBe(0);
  });

  it('checks zero network calls and zero fallback when in-flight generation is rapidly cancelled', async () => {
    const secret = 'abortedSuperSecretKeystroke';
    state.text = secret;
    const updatePromise = appElement.updateSuggestions();

    // Immediately trigger newer input to cancel in-flight request
    state.text = 'new replacement input';
    await appElement.updateSuggestions();
    await updatePromise;
    await new Promise(resolve => window.setTimeout(resolve, 350));

    assertZeroCloudOrDataLeaks([secret]);
    expect(capturedRequests.length).toBe(0);
  });

  it('checks zero network calls and zero silent cloud fallback when runtime errors occur', async () => {
    const secret = 'privateCrashText';
    state.text = secret;

    // Simulate WebGPU runtime error during generation
    spyOn(fakeAdapter, 'generate').and.throwError(
      new Error('WebGPU device lost or out of memory'),
    );

    await appElement.updateSuggestions();
    await new Promise(resolve => window.setTimeout(resolve, 350));

    expect(state.inferenceMode).toBe('local');
    expect(alertSpy).toHaveBeenCalledWith(
      'WebGPU device lost or out of memory',
    );
    assertZeroCloudOrDataLeaks([secret]);
    expect(capturedRequests.length).toBe(0);
  });

  it('checks zero network calls and zero fallback when local model is unloaded', async () => {
    const secret = 'privateMessageWhileUnloaded';
    await modelManager.unloadActiveModel();
    expect(modelManager.getState()).toBe('downloaded');

    state.text = secret;
    await appElement.updateSuggestions();
    await new Promise(resolve => window.setTimeout(resolve, 350));

    expect(state.inferenceMode).toBe('local');
    expect(alertSpy).toHaveBeenCalledWith(
      'Local model is not loaded or ready.',
    );
    assertZeroCloudOrDataLeaks([secret]);
    expect(capturedRequests.length).toBe(0);
  });

  it('checks zero model-byte network downloads on page restart/reload in Local mode', async () => {
    capturedRequests = [];

    // Simulate page startup in Local mode
    await modelManager.startup(true);
    expect(modelManager.getState()).toBe('ready');

    // Startup should read exclusively from OPFS/IndexedDB with zero network requests
    expect(capturedRequests.length).toBe(0);
  });

  it('checks update check transmits only metadata and never leaks user text or prompts', async () => {
    capturedRequests = [];
    state.text = 'unrelatedUserSecret';

    await modelManager.checkForUpdate();

    expect(capturedRequests.length).toBe(1);
    const req = capturedRequests[0];
    expect(req.url).toContain('/api/on-device-models/default');
    expect(req.method).toBe('GET');
    expect(req.body).toBeNull();
    assertZeroCloudOrDataLeaks(['unrelatedUserSecret']);
  });

  it('checks removing the installed model never causes silent fallback to Cloud', async () => {
    capturedRequests = [];
    const secret = 'postRemovalKeystroke';

    spyOn(storage, 'deleteModel').and.resolveTo();
    spyOn(storage, 'deletePartial').and.resolveTo();

    await modelManager.removeModel(
      PRIVACY_TEST_MANIFEST.modelId,
      PRIVACY_TEST_MANIFEST.version,
    );
    expect(modelManager.getState()).toBe('not_downloaded');

    state.text = secret;
    await appElement.updateSuggestions();
    await new Promise(resolve => window.setTimeout(resolve, 350));

    expect(state.inferenceMode).toBe('local');
    expect(alertSpy).toHaveBeenCalledWith(
      'Local model is not loaded or ready.',
    );
    assertZeroCloudOrDataLeaks([secret]);
    expect(capturedRequests.length).toBe(0);
  });
});
