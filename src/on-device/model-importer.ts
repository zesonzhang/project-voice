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

import {StreamingSha256} from './hash-verifier.js';
import {ModelManagerError} from './model-lifecycle.js';
import {ModelManifest} from './model-manifest.js';
import {ModelMetadataStore} from './model-metadata.js';
import {ModelStorage} from './model-storage.js';

export interface ModelImporterContext {
  storage: ModelStorage;
  metadataStore: ModelMetadataStore;
  activateCandidate: (manifest: ModelManifest) => Promise<void>;
}

/**
 * Copies a local .litertlm file into OPFS, computes SHA-256, records unverified candidate,
 * probes and loads the model, and activates it.
 */
export async function importLocalModel(
  file: File,
  context: ModelImporterContext,
): Promise<ModelManifest> {
  if (!file || file.size <= 0) {
    throw new ModelManagerError('ERR_LOAD_FAILED', 'Invalid model file');
  }
  if (!file.name.toLowerCase().endsWith('.litertlm')) {
    throw new ModelManagerError(
      'ERR_LOAD_FAILED',
      'Local model imports must use the .litertlm file extension.',
    );
  }
  const modelId = 'imported';
  const version = `v-${Date.now()}`;
  const chunkSize = 2 * 1024 * 1024;
  const hasher = new StreamingSha256();

  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(file.size, offset + chunkSize));
    const arrayBuffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    hasher.update(bytes);
    await context.storage.writeChunk(modelId, version, bytes, offset);
    offset += bytes.byteLength;
  }
  await context.storage.promotePartialToModel(modelId, version);
  const sha256 = hasher.digest();

  const manifest: ModelManifest = {
    schemaVersion: 1,
    modelId,
    version,
    displayName: file.name.replace(/\.litertlm$/, ''),
    family: 'gemma',
    adapterId: 'litert-lm',
    format: 'litertlm',
    sizeBytes: file.size,
    sha256,
    gcsGeneration: '0',
    capabilities: {
      textGeneration: true,
      languages: ['en', 'ja', 'zh', 'fr', 'de', 'sv'],
      maxInputTokens: 2048,
      maxOutputTokens: 256,
    },
    requirements: {
      webgpu: true,
      minimumDeviceMemoryGB: 8,
      minimumFreeStorageBytes: Math.round(file.size * 1.2),
    },
    generation: {
      temperature: 0,
      topP: 0.5,
      maxOutputTokens: 256,
    },
  };

  await context.metadataStore.saveVersion({
    modelId,
    version,
    manifest,
    fileName: `${version}.litertlm`,
    partialFileName: `${version}.partial`,
    sizeBytes: file.size,
    sha256,
    gcsGeneration: '0',
    downloadOffset: file.size,
    verificationState: 'verified',
    importStatus: 'unverified_import',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUsedAt: Date.now(),
  });

  await context.activateCandidate(manifest);
  return manifest;
}
