import {DEBUG_MODEL, PublicDebugModel} from '../litert-debug/model.js';
import {Playground, templateVariables} from '../litert-debug/playground.js';
import {FakeModelRuntimeAdapter} from '../on-device/fake-runtime-adapter.js';
import {StreamingSha256} from '../on-device/hash-verifier.js';
import {InMemoryModelMetadataStore} from '../on-device/model-metadata.js';
import {GenerationOptions} from '../on-device/model-runtime-adapter.js';
import {InMemoryModelStorage} from '../on-device/model-storage.js';
import {BrowserTabCoordinator} from '../on-device/tab-coordinator.js';
import {isWorkerRequest} from '../on-device/worker-protocol.js';

const variables = {
  language: 'Mandarin',
  num: '2',
  persona: '',
  sentenceEmotion: '',
  conversationHistory: '',
  lastInputSpeech: '',
  lastOutputSpeech: '',
};

describe('LiteRT debug public download', () => {
  let storage: InMemoryModelStorage;
  let metadata: InMemoryModelMetadataStore;
  let coordinator: BrowserTabCoordinator;
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const hash = new StreamingSha256();
  hash.update(bytes);
  const manifest = {
    ...DEBUG_MODEL,
    sizeBytes: bytes.length,
    sha256: hash.digest(),
  };
  beforeEach(() => {
    storage = new InMemoryModelStorage();
    metadata = new InMemoryModelMetadataStore();
    coordinator = new BrowserTabCoordinator();
  });
  afterEach(() => coordinator.close());
  const signal = () => new AbortController().signal;
  function model(fetchImpl: typeof fetch, quota = 1000) {
    return new PublicDebugModel({
      storage,
      metadata,
      coordinator,
      manifest,
      fetchImpl,
      estimate: async () => ({quota, usage: 0}),
    });
  }
  it('verifies, caches and avoids repeated downloads', async () => {
    const fetcher = jasmine
      .createSpy('fetch')
      .and.resolveTo(new Response(bytes));
    const service = model(fetcher);
    await service.download(signal(), () => {});
    expect(await service.cached()).toBeTrue();
    await service.download(signal(), () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    await service.remove();
    expect(await service.cached()).toBeFalse();
  });
  it('resumes an existing partial with Range', async () => {
    await storage.writeChunk(
      manifest.modelId,
      manifest.version,
      bytes.slice(0, 2),
      0,
    );
    const fetcher = jasmine.createSpy('fetch').and.resolveTo(
      new Response(bytes.slice(2), {
        status: 206,
        headers: {'Content-Range': 'bytes 2-4/5'},
      }),
    );
    await model(fetcher).download(signal(), () => {});
    expect(fetcher.calls.mostRecent().args[1].headers.Range).toBe('bytes=2-4');
    expect(
      await storage.getModelFileSize(manifest.modelId, manifest.version),
    ).toBe(5);
  });
  it('restarts when a server ignores Range', async () => {
    await storage.writeChunk(
      manifest.modelId,
      manifest.version,
      bytes.slice(0, 2),
      0,
    );
    const service = model(async () => new Response(bytes));
    await service.download(signal(), () => {});
    expect(await service.cached()).toBeTrue();
  });
  it('rejects incorrect Content-Range', async () => {
    await expectAsync(
      model(
        async () =>
          new Response(bytes, {
            status: 206,
            headers: {'Content-Range': 'bytes 1-5/6'},
          }),
      ).download(signal(), () => {}),
    ).toBeRejected();
    expect(
      await storage.hasModel(manifest.modelId, manifest.version),
    ).toBeFalse();
  });
  it('discards corrupt downloads without marking a model ready', async () => {
    const service = model(
      async () => new Response(new Uint8Array([5, 4, 3, 2, 1])),
    );
    await expectAsync(
      service.download(signal(), () => {}),
    ).toBeRejectedWithError(/SHA-256/);
    expect(await service.cached()).toBeFalse();
    expect(
      await storage.hasPartial(manifest.modelId, manifest.version),
    ).toBeFalse();
  });
  it('times out a stalled connection so the user can retry', async () => {
    let connected!: () => void;
    const started = new Promise<void>(resolve => {
      connected = resolve;
    });
    const service = model(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(init!.signal!.reason),
          );
          connected();
        }),
    );
    jasmine.clock().install();
    try {
      const downloading = service.download(signal(), () => {});
      await started;
      jasmine.clock().tick(180001);
      await expectAsync(downloading).toBeRejectedWithError(/连接超时/);
      expect(await service.cached()).toBeFalse();
    } finally {
      jasmine.clock().uninstall();
    }
  });
  it('bounds range concurrency and preserves a contiguous checkpoint on failure', async () => {
    const chunkSize = 8 * 1024 * 1024;
    const payload = new Uint8Array(chunkSize * 5 + 1).fill(7);
    const digest = new StreamingSha256();
    digest.update(payload);
    const large = {
      ...manifest,
      sizeBytes: payload.length,
      sha256: digest.digest(),
    };
    let fail = true;
    let active = 0;
    let peak = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      const range = /bytes=(\d+)-(\d+)/.exec(
        (init!.headers as Record<string, string>).Range,
      )!;
      const start = +range[1],
        end = +range[2];
      active--;
      return new Response(payload.slice(start, end + 1), {
        status: 206,
        headers: {
          'Content-Range':
            fail && start === 2 * chunkSize
              ? 'bytes 0-1/2'
              : `bytes ${start}-${end}/${payload.length}`,
        },
      });
    };
    const service = new PublicDebugModel({
      storage,
      metadata,
      coordinator,
      manifest: large,
      fetchImpl: fetcher,
      estimate: async () => ({quota: payload.length * 3, usage: 0}),
    });
    await expectAsync(
      service.download(signal(), () => {}),
    ).toBeRejectedWithError(/Content-Range/);
    expect(await storage.getPartialSize(large.modelId, large.version)).toBe(
      chunkSize,
    );
    fail = false;
    await service.download(signal(), () => {});
    expect(peak).toBe(4);
    expect(await service.cached()).toBeTrue();
  }, 15000);
  it('checks capacity before fetching', async () => {
    const fetcher = jasmine.createSpy('fetch');
    await expectAsync(
      model(fetcher, 1).download(signal(), () => {}),
    ).toBeRejectedWithError(/空间不足/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('honors cancellation without destroying the partial', async () => {
    await storage.writeChunk(
      manifest.modelId,
      manifest.version,
      bytes.slice(0, 2),
      0,
    );
    const controller = new AbortController();
    controller.abort();
    await expectAsync(
      model(jasmine.createSpy('fetch')).download(controller.signal, () => {}),
    ).toBeRejected();
    expect(
      await storage.getPartialSize(manifest.modelId, manifest.version),
    ).toBe(2);
  });
  it('serializes competing downloads and rechecks cache under the lock', async () => {
    const fetcher = jasmine
      .createSpy('fetch')
      .and.callFake(async () => new Response(bytes));
    const first = model(fetcher);
    const second = model(fetcher);
    await Promise.all([
      first.download(signal(), () => {}),
      second.download(signal(), () => {}),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('LiteRT debug playground', () => {
  it('extracts conditional and substitution settings without text', () => {
    const keys = templateVariables([
      'WordMandarin20250616',
      'SentenceMandarin20250616',
    ]);
    expect(
      templateVariables(['WordJapanese20250623', 'SentenceJapanese20240628']),
    ).toContain('language');
    expect(keys).toContain('persona');
    expect(keys).toContain('language');
    expect(keys).not.toContain('text');
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('serializes word/sentence prompts and applies requested result count', async () => {
    const runtime = new FakeModelRuntimeAdapter();
    const prompts: string[] = [];
    runtime.generate = async function* (prompt: string) {
      prompts.push(prompt);
      yield '1. 公园\n2. 散步\n3. 周末';
    };
    const playground = new Playground(runtime, () => {});
    await playground.run(
      'suggest',
      '周末',
      ['WordMandarin20250616', 'SentenceMandarin20250616'],
      variables,
      {},
    );
    expect(prompts.length).toBe(2);
    expect(playground.outputs[0].label).toBe('WordMandarin20250616');
    expect(playground.outputs[1].label).toBe('SentenceMandarin20250616');
    expect(playground.outputs[0].suggestions).toEqual(['公园', '散步']);
    expect(prompts[0]).toContain('周末');
    expect(playground.history).toEqual([]);
  });
  it('sends successful chat history but never sends it to suggestion generation', async () => {
    const runtime = new FakeModelRuntimeAdapter();
    const calls: GenerationOptions[] = [];
    runtime.generate = async function* (_: string, options: GenerationOptions) {
      calls.push(options);
      yield '答复';
    };
    const playground = new Playground(runtime, () => {});
    await playground.run('chat', '第一句', [], variables, {});
    await playground.run('chat', '第二句', [], variables, {});
    expect(calls[1].history).toEqual([
      {role: 'user', content: '第一句'},
      {role: 'assistant', content: '答复'},
    ]);
    await playground.run(
      'suggest',
      '输入',
      ['WordMandarin20250616'],
      variables,
      {},
    );
    expect(calls[2].history).toBeUndefined();
    await playground.reset();
    expect(playground.history).toEqual([]);
    expect(playground.outputs).toEqual([]);
  });
  it('stops both the current stream and queued sentence; ignores late output', async () => {
    const runtime = new FakeModelRuntimeAdapter();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    runtime.generate = async function* () {
      yield '1. 保留';
      started();
      await waiting;
      yield '不应该出现';
    };
    const playground = new Playground(runtime, () => {});
    const running = playground.run(
      'suggest',
      '输入',
      ['WordMandarin20250616', 'SentenceMandarin20250616'],
      variables,
      {},
    );
    await ready;
    const stopping = playground.stop();
    release();
    await stopping;
    await running;
    expect(playground.outputs.length).toBe(1);
    expect(playground.outputs[0].raw).toBe('1. 保留');
    expect(playground.outputs[0].interrupted).toBeTrue();
    expect(playground.history).toEqual([]);
  });
  it('rejects invalid structured history in Worker messages', () => {
    const request = {
      protocolVersion: 1,
      requestId: 'test',
      type: 'GENERATE',
      sequenceId: 1,
      prompt: 'hi',
    };
    expect(
      isWorkerRequest({
        ...request,
        history: [{role: 'assistant', content: 'hello'}],
      }),
    ).toBeTrue();
    expect(
      isWorkerRequest({
        ...request,
        history: [{role: 'invalid', content: 'hello'}],
      }),
    ).toBeFalse();
  });
});

// Verify the browser's native select state, which can differ from Lit state
// when .value is assigned before its options have been rendered.
import {LiteRtDebug} from '../litert-debug/index.js';
import {InferenceWorkerClient} from '../on-device/worker-client.js';
describe('LiteRT debug page', () => {
  it('selects Mandarin templates by default', async () => {
    spyOn(PublicDebugModel.prototype, 'cached').and.resolveTo(false);
    spyOn(InferenceWorkerClient.prototype, 'getCapabilities').and.resolveTo({
      secureContext: true,
      worker: true,
      webGpu: true,
      adapterAvailable: true,
      fallbackAdapter: false,
      deviceAvailable: true,
      crossOriginIsolated: true,
    });
    const element = new LiteRtDebug();
    document.body.append(element);
    try {
      await element.updateComplete;
      const selects = element.shadowRoot!.querySelectorAll('select');
      expect(selects[0].value).toBe('WordMandarin20250616');
      expect(selects[1].value).toBe('SentenceMandarin20250616');
    } finally {
      element.remove();
    }
  });
});
