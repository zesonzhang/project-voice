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

export interface ModelStorage {
  writeChunk(
    modelId: string,
    version: string,
    chunk: Uint8Array,
    offset: number,
  ): Promise<void>;
  appendChunk(
    modelId: string,
    version: string,
    chunk: Uint8Array,
  ): Promise<number>;
  getPartialSize(modelId: string, version: string): Promise<number>;
  getModelFileSize(modelId: string, version: string): Promise<number>;
  readChunk(
    modelId: string,
    version: string,
    offset: number,
    length: number,
    isPartial?: boolean,
  ): Promise<Uint8Array>;
  promotePartialToModel(modelId: string, version: string): Promise<void>;
  deletePartial(modelId: string, version: string): Promise<void>;
  deleteModel(modelId: string, version: string): Promise<void>;
  hasModel(modelId: string, version: string): Promise<boolean>;
  hasPartial(modelId: string, version: string): Promise<boolean>;
  listModelFiles(modelId: string): Promise<string[]>;
  openModelFile(modelId: string, version: string): Promise<File>;
}

const ROOT_DIR_NAME = 'project-voice';
const MODELS_DIR_NAME = 'models';
const MODEL_ID_PATTERN = /^[a-z0-9-]+$/;
const VERSION_PATTERN = /^[a-z0-9.-]+$/;

function assertSafeStorageTarget(modelId: string, version?: string): void {
  if (!MODEL_ID_PATTERN.test(modelId) || modelId.length > 128) {
    throw new Error(`Invalid model storage ID: ${modelId}`);
  }
  if (
    version !== undefined &&
    (!VERSION_PATTERN.test(version) ||
      version === '.' ||
      version === '..' ||
      version.length > 128)
  ) {
    throw new Error(`Invalid model storage version: ${version}`);
  }
}

/**
 * OPFS (Origin Private File System) implementation of ModelStorage.
 */
export class OpfsModelStorage implements ModelStorage {
  private async getModelDirectory(
    modelId: string,
    create = true,
  ): Promise<FileSystemDirectoryHandle> {
    assertSafeStorageTarget(modelId);
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
      throw new Error('OPFS is not supported in this browser environment');
    }
    const root = await navigator.storage.getDirectory();
    const pvDir = await root.getDirectoryHandle(ROOT_DIR_NAME, {create});
    const modelsDir = await pvDir.getDirectoryHandle(MODELS_DIR_NAME, {create});
    return await modelsDir.getDirectoryHandle(modelId, {create});
  }

  private partialFileName(version: string): string {
    assertSafeStorageTarget('model', version);
    return `${version}.partial`;
  }

  private modelFileName(version: string): string {
    assertSafeStorageTarget('model', version);
    return `${version}.litertlm`;
  }

  async writeChunk(
    modelId: string,
    version: string,
    chunk: Uint8Array,
    offset: number,
  ): Promise<void> {
    const dir = await this.getModelDirectory(modelId, true);
    const fileHandle = await dir.getFileHandle(this.partialFileName(version), {
      create: true,
    });
    const writable = await fileHandle.createWritable({keepExistingData: true});
    await writable.seek(offset);
    await writable.write(chunk as unknown as BufferSource);
    await writable.close();
  }

  async appendChunk(
    modelId: string,
    version: string,
    chunk: Uint8Array,
  ): Promise<number> {
    const currentSize = await this.getPartialSize(modelId, version);
    await this.writeChunk(modelId, version, chunk, currentSize);
    return currentSize + chunk.byteLength;
  }

  async getPartialSize(modelId: string, version: string): Promise<number> {
    try {
      const dir = await this.getModelDirectory(modelId, false);
      const fileHandle = await dir.getFileHandle(
        this.partialFileName(version),
        {create: false},
      );
      const file = await fileHandle.getFile();
      return file.size;
    } catch {
      return 0;
    }
  }

  async getModelFileSize(modelId: string, version: string): Promise<number> {
    try {
      const dir = await this.getModelDirectory(modelId, false);
      const fileHandle = await dir.getFileHandle(this.modelFileName(version), {
        create: false,
      });
      const file = await fileHandle.getFile();
      return file.size;
    } catch {
      return 0;
    }
  }

  async readChunk(
    modelId: string,
    version: string,
    offset: number,
    length: number,
    isPartial = false,
  ): Promise<Uint8Array> {
    const dir = await this.getModelDirectory(modelId, false);
    const fileName = isPartial
      ? this.partialFileName(version)
      : this.modelFileName(version);
    const fileHandle = await dir.getFileHandle(fileName, {create: false});
    const file = await fileHandle.getFile();
    const slice = file.slice(offset, offset + length);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async promotePartialToModel(modelId: string, version: string): Promise<void> {
    const dir = await this.getModelDirectory(modelId, false);
    const partialName = this.partialFileName(version);
    const finalName = this.modelFileName(version);

    const partialHandle = await dir.getFileHandle(partialName, {create: false});
    const partialFile = await partialHandle.getFile();

    // Stream-copy to target file in chunks to avoid allocating entire file in RAM
    const targetHandle = await dir.getFileHandle(finalName, {create: true});
    const writable = await targetHandle.createWritable({
      keepExistingData: false,
    });

    const chunkSize = 4 * 1024 * 1024; // 4MB chunks
    for (let offset = 0; offset < partialFile.size; offset += chunkSize) {
      const slice = partialFile.slice(offset, offset + chunkSize);
      const buffer = await slice.arrayBuffer();
      await writable.write(new Uint8Array(buffer) as unknown as BufferSource);
    }
    await writable.close();

    // Delete the partial file after successful promotion
    await dir.removeEntry(partialName);
  }

  async deletePartial(modelId: string, version: string): Promise<void> {
    try {
      const dir = await this.getModelDirectory(modelId, false);
      await dir.removeEntry(this.partialFileName(version));
    } catch {
      // Ignored if file does not exist
    }
  }

  async deleteModel(modelId: string, version: string): Promise<void> {
    try {
      const dir = await this.getModelDirectory(modelId, false);
      await dir.removeEntry(this.modelFileName(version));
    } catch {
      // Ignored if file does not exist
    }
  }

  async hasModel(modelId: string, version: string): Promise<boolean> {
    try {
      const dir = await this.getModelDirectory(modelId, false);
      await dir.getFileHandle(this.modelFileName(version), {create: false});
      return true;
    } catch {
      return false;
    }
  }

  async hasPartial(modelId: string, version: string): Promise<boolean> {
    try {
      const dir = await this.getModelDirectory(modelId, false);
      await dir.getFileHandle(this.partialFileName(version), {create: false});
      return true;
    } catch {
      return false;
    }
  }

  async listModelFiles(modelId: string): Promise<string[]> {
    try {
      const dir = await this.getModelDirectory(modelId, false);
      const files: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [name, handle] of (dir as any).entries()) {
        if (handle.kind === 'file') {
          files.push(name);
        }
      }
      return files;
    } catch {
      return [];
    }
  }

  async openModelFile(modelId: string, version: string): Promise<File> {
    const dir = await this.getModelDirectory(modelId, false);
    const fileHandle = await dir.getFileHandle(this.modelFileName(version), {
      create: false,
    });
    return await fileHandle.getFile();
  }
}

/**
 * In-memory implementation of ModelStorage for unit and integration testing.
 */
export class InMemoryModelStorage implements ModelStorage {
  private files = new Map<string, Uint8Array>();

  private getFileKey(
    modelId: string,
    version: string,
    isPartial: boolean,
  ): string {
    assertSafeStorageTarget(modelId, version);
    const ext = isPartial ? '.partial' : '.litertlm';
    return `${ROOT_DIR_NAME}/${MODELS_DIR_NAME}/${modelId}/${version}${ext}`;
  }

  async writeChunk(
    modelId: string,
    version: string,
    chunk: Uint8Array,
    offset: number,
  ): Promise<void> {
    const key = this.getFileKey(modelId, version, true);
    const existing = this.files.get(key) || new Uint8Array(0);
    const needed = Math.max(existing.length, offset + chunk.byteLength);
    const updated = new Uint8Array(needed);
    updated.set(existing, 0);
    updated.set(chunk, offset);
    this.files.set(key, updated);
  }

  async appendChunk(
    modelId: string,
    version: string,
    chunk: Uint8Array,
  ): Promise<number> {
    const key = this.getFileKey(modelId, version, true);
    const existing = this.files.get(key) || new Uint8Array(0);
    const updated = new Uint8Array(existing.length + chunk.byteLength);
    updated.set(existing, 0);
    updated.set(chunk, existing.length);
    this.files.set(key, updated);
    return updated.byteLength;
  }

  async getPartialSize(modelId: string, version: string): Promise<number> {
    const key = this.getFileKey(modelId, version, true);
    return this.files.get(key)?.byteLength || 0;
  }

  async getModelFileSize(modelId: string, version: string): Promise<number> {
    const key = this.getFileKey(modelId, version, false);
    return this.files.get(key)?.byteLength || 0;
  }

  async readChunk(
    modelId: string,
    version: string,
    offset: number,
    length: number,
    isPartial = false,
  ): Promise<Uint8Array> {
    const key = this.getFileKey(modelId, version, isPartial);
    const fileData = this.files.get(key);
    if (!fileData) {
      throw new Error(`File not found: ${key}`);
    }
    const end = Math.min(fileData.byteLength, offset + length);
    return fileData.slice(offset, end);
  }

  async promotePartialToModel(modelId: string, version: string): Promise<void> {
    const partialKey = this.getFileKey(modelId, version, true);
    const modelKey = this.getFileKey(modelId, version, false);
    const data = this.files.get(partialKey);
    if (!data) {
      throw new Error(`Partial file not found for promotion: ${partialKey}`);
    }
    this.files.set(modelKey, new Uint8Array(data));
    this.files.delete(partialKey);
  }

  async deletePartial(modelId: string, version: string): Promise<void> {
    const key = this.getFileKey(modelId, version, true);
    this.files.delete(key);
  }

  async deleteModel(modelId: string, version: string): Promise<void> {
    const key = this.getFileKey(modelId, version, false);
    this.files.delete(key);
  }

  async hasModel(modelId: string, version: string): Promise<boolean> {
    return this.files.has(this.getFileKey(modelId, version, false));
  }

  async hasPartial(modelId: string, version: string): Promise<boolean> {
    return this.files.has(this.getFileKey(modelId, version, true));
  }

  async listModelFiles(modelId: string): Promise<string[]> {
    const prefix = `${ROOT_DIR_NAME}/${MODELS_DIR_NAME}/${modelId}/`;
    const names: string[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        names.push(key.substring(prefix.length));
      }
    }
    return names;
  }

  async openModelFile(modelId: string, version: string): Promise<File> {
    const key = this.getFileKey(modelId, version, false);
    const data = this.files.get(key);
    if (!data) {
      throw new Error(`Model file not found: ${key}`);
    }
    return new File([data as unknown as BlobPart], `${version}.litertlm`, {
      type: 'application/octet-stream',
    });
  }
}
