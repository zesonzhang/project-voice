import {StreamingSha256} from '../on-device/hash-verifier.js';
import {ModelManifest} from '../on-device/model-manifest.js';
import {ModelMetadataStore} from '../on-device/model-metadata.js';
import {ModelStorage} from '../on-device/model-storage.js';
import {TabCoordinator} from '../on-device/tab-coordinator.js';

// Frozen artifact from f528a8f docs/m0/artifact.json. Zero generation follows
// the existing local-import convention; this never enters the signed GCS API.
export const DEBUG_MODEL: ModelManifest = {
  schemaVersion: 1,
  modelId: 'debug-gemma-4-e2b-web',
  version: '6b78abd019e61a1ca4cbe3b212d2c9ce8ff38a94',
  displayName: 'Gemma 4 E2B IT Web',
  family: 'gemma',
  adapterId: 'litert-lm',
  format: 'litertlm',
  sizeBytes: 2008432640,
  sha256: '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5',
  gcsGeneration: '0',
  capabilities: {
    textGeneration: true,
    languages: ['en', 'ja', 'zh', 'fr', 'de', 'sv'],
    maxInputTokens: 2048,
    maxOutputTokens: 1024,
  },
  requirements: {
    webgpu: true,
    minimumDeviceMemoryGB: 8,
    minimumFreeStorageBytes: 4200000000,
  },
  generation: {temperature: 0, topP: 0.5, maxOutputTokens: 256},
};
export const MODEL_URL = `https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/${DEBUG_MODEL.version}/gemma-4-E2B-it-web.litertlm`;

export interface PublicModelOptions {
  storage: ModelStorage;
  metadata: ModelMetadataStore;
  coordinator: TabCoordinator;
  fetchImpl?: typeof fetch;
  estimate?: () => Promise<StorageEstimate>;
  manifest?: ModelManifest;
}

export class PublicDebugModel {
  readonly manifest: ModelManifest;
  constructor(private readonly options: PublicModelOptions) {
    this.manifest = options.manifest ?? DEBUG_MODEL;
  }
  async cached(): Promise<boolean> {
    const {modelId, version, sizeBytes, sha256} = this.manifest;
    const record = await this.options.metadata.getVersion(modelId, version);
    return (
      record?.verificationState === 'verified' &&
      record.sha256 === sha256 &&
      (await this.options.storage.getModelFileSize(modelId, version)) ===
        sizeBytes
    );
  }
  private locked<T>(action: () => Promise<T>): Promise<T> {
    return this.options.coordinator.acquireDownloadLock(
      this.manifest.modelId,
      this.manifest.version,
      action,
    );
  }
  async remove(): Promise<void> {
    await this.locked(async () => {
      const {modelId, version} = this.manifest;
      await this.options.storage.deletePartial(modelId, version);
      await this.options.storage.deleteModel(modelId, version);
      await this.options.metadata.deleteVersion(modelId, version);
    });
  }
  async download(
    signal: AbortSignal,
    progress: (bytes: number, phase: string) => void,
  ): Promise<void> {
    progress(0, '等待下载锁');
    await this.locked(async () => {
      signal.throwIfAborted();
      if (await this.cached()) return;
      const {storage, metadata} = this.options;
      const {modelId, version, sizeBytes, sha256} = this.manifest;
      const estimate = await (this.options.estimate?.() ??
        navigator.storage.estimate());
      // Promotion stream-copies the partial, so reserve space for both files.
      if (
        estimate.quota !== undefined &&
        estimate.usage !== undefined &&
        estimate.quota - estimate.usage <
          sizeBytes * 2 - (await storage.getPartialSize(modelId, version))
      ) {
        throw new Error('存储空间不足：下载和校验需要约 4.1 GB 可用空间。');
      }
      let offset = await storage.getPartialSize(modelId, version);
      if (offset > sizeBytes) {
        await storage.deletePartial(modelId, version);
        offset = 0;
      }
      progress(offset, '连接模型来源');
      if (offset < sizeBytes) {
        const chunkSize = 8 * 1024 * 1024;
        const transfer = new AbortController();
        const transferSignal = AbortSignal.any([signal, transfer.signal]);
        const fetchRange = async (start: number): Promise<Response> => {
          const connection = new AbortController();
          const timeout = setTimeout(
            () =>
              connection.abort(new Error('模型源连接超时，请检查网络后重试。')),
            180000,
          );
          try {
            return await (this.options.fetchImpl ?? fetch)(MODEL_URL, {
              signal: AbortSignal.any([transferSignal, connection.signal]),
              credentials: 'omit',
              headers: {
                Range: `bytes=${start}-${Math.min(start + chunkSize, sizeBytes) - 1}`,
              },
            });
          } finally {
            clearTimeout(timeout);
          }
        };
        const readRange = async (
          response: Response,
          start: number,
        ): Promise<Uint8Array> => {
          const end = Math.min(start + chunkSize, sizeBytes) - 1;
          try {
            if (
              response.status !== 206 ||
              !response.body ||
              response.headers.get('Content-Range') !==
                `bytes ${start}-${end}/${sizeBytes}`
            ) {
              throw new Error('模型下载 Content-Range 不匹配，请重试。');
            }
            const buffer = new Uint8Array(end - start + 1);
            const reader = response.body.getReader();
            let used = 0;
            try {
              while (!transferSignal.aborted) {
                const {done, value} = await reader.read();
                if (done) break;
                if (used + value.length > buffer.length)
                  throw new Error('下载大小超过请求范围。');
                buffer.set(value, used);
                used += value.length;
              }
              transferSignal.throwIfAborted();
              if (used !== buffer.length)
                throw new Error('下载未完成，请重试以继续下载。');
              return buffer;
            } finally {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
          } finally {
            if (!response.body?.locked)
              await response.body?.cancel().catch(() => undefined);
          }
        };
        const response = await fetchRange(offset);
        try {
          if (!response.ok || !response.body)
            throw new Error(`模型下载失败：HTTP ${response.status}`);
          if (response.status === 206) {
            const first = await readRange(response, offset);
            signal.throwIfAborted();
            await storage.writeChunk(modelId, version, first, offset);
            offset += first.length;
            progress(offset, '下载中');
            while (offset < sizeBytes) {
              signal.throwIfAborted();
              const starts = Array.from(
                {
                  length: Math.min(
                    4,
                    Math.ceil((sizeBytes - offset) / chunkSize),
                  ),
                },
                (_, index) => offset + index * chunkSize,
              );
              const pending = starts.map(async start =>
                readRange(await fetchRange(start), start),
              );
              let chunks: Uint8Array[];
              try {
                chunks = await Promise.all(pending);
              } catch (error) {
                transfer.abort();
                await Promise.allSettled(pending);
                throw error;
              }
              // Commit only contiguous completed chunks: a canceled/failed batch
              // never introduces holes or an invalid resume offset in OPFS.
              for (const chunk of chunks) {
                signal.throwIfAborted();
                await storage.writeChunk(modelId, version, chunk, offset);
                offset += chunk.length;
                progress(offset, '下载中');
              }
            }
          } else if (response.status === 200) {
            await storage.deletePartial(modelId, version);
            offset = 0;
            const reader = response.body.getReader();
            // Batch writes to avoid copying the OPFS file for every network packet.
            let buffer = new Uint8Array(8 * 1024 * 1024);
            let used = 0;
            try {
              while (!signal.aborted) {
                signal.throwIfAborted();
                const {done, value} = await reader.read();
                if (done) break;
                if (offset + used + value.length > sizeBytes)
                  throw new Error('下载大小超过固定模型大小。');
                let pos = 0;
                while (pos < value.length) {
                  const take = Math.min(
                    value.length - pos,
                    buffer.length - used,
                  );
                  buffer.set(value.subarray(pos, pos + take), used);
                  used += take;
                  pos += take;
                  if (used === buffer.length) {
                    await storage.writeChunk(modelId, version, buffer, offset);
                    offset += used;
                    used = 0;
                    progress(offset, '下载中');
                  }
                }
              }
              if (used) {
                buffer = buffer.slice(0, used);
                await storage.writeChunk(modelId, version, buffer, offset);
                offset += used;
              }
            } finally {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
          } else throw new Error(`不支持的下载响应：${response.status}`);
        } finally {
          transfer.abort();
          if (!response.body?.locked)
            await response.body?.cancel().catch(() => undefined);
        }
      }
      signal.throwIfAborted();
      if (offset !== sizeBytes)
        throw new Error('下载未完成，请重试以继续下载。');
      const hash = new StreamingSha256();
      for (let pos = 0; pos < sizeBytes; pos += 4 * 1024 * 1024) {
        signal.throwIfAborted();
        hash.update(
          await storage.readChunk(
            modelId,
            version,
            pos,
            Math.min(4 * 1024 * 1024, sizeBytes - pos),
            true,
          ),
        );
        progress(Math.min(pos + 4 * 1024 * 1024, sizeBytes), '校验 SHA-256');
      }
      if (hash.digest() !== sha256) {
        await storage.deletePartial(modelId, version);
        throw new Error('SHA-256 校验失败，已删除损坏下载，请重试。');
      }
      signal.throwIfAborted();
      progress(sizeBytes, '保存模型');
      await storage.promotePartialToModel(modelId, version);
      const now = Date.now();
      await metadata.saveVersion({
        modelId,
        version,
        manifest: this.manifest,
        fileName: `${version}.litertlm`,
        partialFileName: `${version}.partial`,
        sizeBytes,
        sha256,
        gcsGeneration: '0',
        downloadOffset: sizeBytes,
        verificationState: 'verified',
        importStatus: 'unverified_import',
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
      });
      progress(sizeBytes, '已缓存');
    });
  }
}
