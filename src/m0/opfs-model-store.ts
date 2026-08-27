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

import {CANDIDATE_MODEL, M0ModelInfo, MODEL_STORAGE_PATH} from './protocol.js';

export class OpfsModelStore {
  async getInfo(): Promise<M0ModelInfo> {
    try {
      const file = await this.open();
      return {
        installed: true,
        byteSize: file.size,
        lastModified: file.lastModified,
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return {installed: false, byteSize: 0, lastModified: null};
      }
      throw error;
    }
  }

  async open(): Promise<File> {
    const directory = await this.getDirectory(false);
    const handle = await directory.getFileHandle(CANDIDATE_MODEL.filename);
    return handle.getFile();
  }

  async installFile(
    file: File,
    onProgress: (loadedBytes: number) => void,
  ): Promise<void> {
    this.validateCandidate(file.name, file.size);
    await this.writeStream(file.stream(), file.size, onProgress);
  }

  async installUrl(
    url: string,
    onProgress: (loadedBytes: number) => void,
  ): Promise<void> {
    const response = await fetch(url, {cache: 'no-store'});
    if (!response.ok || !response.body) {
      throw new Error(`Model download failed with HTTP ${response.status}.`);
    }
    const headerSize = Number(response.headers.get('content-length'));
    if (headerSize !== CANDIDATE_MODEL.byteSize) {
      throw new Error(
        `Expected ${CANDIDATE_MODEL.byteSize} bytes, received ${headerSize}.`,
      );
    }
    await this.writeStream(response.body, headerSize, onProgress);
  }

  async remove(): Promise<void> {
    try {
      const directory = await this.getDirectory(false);
      await directory.removeEntry(CANDIDATE_MODEL.filename);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  private async writeStream(
    stream: ReadableStream<Uint8Array>,
    totalBytes: number,
    onProgress: (loadedBytes: number) => void,
  ): Promise<void> {
    const directory = await this.getDirectory(true);
    const partialName = `${CANDIDATE_MODEL.filename}.partial`;
    const partial = await directory.getFileHandle(partialName, {create: true});
    const writer = await partial.createWritable();
    const reader = stream.getReader();
    let loadedBytes = 0;
    let done = false;
    try {
      while (!done) {
        const readResult = await reader.read();
        if (readResult.done) {
          done = true;
          continue;
        }
        const value = readResult.value;
        const bytes = value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        ) as ArrayBuffer;
        await writer.write(bytes);
        loadedBytes += value.byteLength;
        onProgress(loadedBytes);
      }
      if (loadedBytes !== totalBytes) {
        throw new Error(`Expected ${totalBytes} bytes, wrote ${loadedBytes}.`);
      }
      await writer.close();
      await directory.removeEntry(CANDIDATE_MODEL.filename).catch(error => {
        if (!isNotFoundError(error)) throw error;
      });
      await (
        partial as FileSystemFileHandle & {
          move(name: string): Promise<void>;
        }
      ).move(CANDIDATE_MODEL.filename);
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private validateCandidate(name: string, byteSize: number): void {
    if (name !== CANDIDATE_MODEL.filename) {
      throw new Error(
        `Expected ${CANDIDATE_MODEL.filename}, received ${name}.`,
      );
    }
    if (byteSize !== CANDIDATE_MODEL.byteSize) {
      throw new Error(
        `Expected ${CANDIDATE_MODEL.byteSize} bytes, received ${byteSize}.`,
      );
    }
  }

  private async getDirectory(
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    let directory = await navigator.storage.getDirectory();
    for (const name of MODEL_STORAGE_PATH) {
      directory = await directory.getDirectoryHandle(name, {create});
    }
    return directory;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}
