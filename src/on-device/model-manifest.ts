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

export interface ModelCapabilities {
  textGeneration: true;
  languages: string[];
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface ModelRequirements {
  webgpu: true;
  minimumDeviceMemoryGB: number;
  minimumFreeStorageBytes: number;
}

export interface ModelGenerationConfig {
  temperature: number;
  topP: number;
  maxOutputTokens: number;
}

export interface ModelManifest {
  schemaVersion: 1;
  modelId: string;
  version: string;
  displayName: string;
  family: 'gemma';
  adapterId: 'litert-lm';
  format: 'litertlm';
  sizeBytes: number;
  sha256: string;
  gcsGeneration: string;
  capabilities: ModelCapabilities;
  requirements: ModelRequirements;
  generation: ModelGenerationConfig;
}

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

const ALLOWED_FAMILIES = new Set(['gemma']);
const ALLOWED_ADAPTERS = new Set(['litert-lm']);
const ALLOWED_FORMATS = new Set(['litertlm']);
const ALLOWED_LANGUAGES = new Set(['en', 'ja', 'zh', 'fr', 'de', 'sv']);

const MODEL_ID_REGEX = /^[a-z0-9-]+$/;
const VERSION_REGEX = /^[a-z0-9.-]+$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/;
const GCS_GENERATION_REGEX = /^[0-9]+$/;

function containsControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'modelId',
  'version',
  'displayName',
  'family',
  'adapterId',
  'format',
  'sizeBytes',
  'sha256',
  'gcsGeneration',
  'capabilities',
  'requirements',
  'generation',
]);

const ALLOWED_CAPABILITY_KEYS = new Set([
  'textGeneration',
  'languages',
  'maxInputTokens',
  'maxOutputTokens',
]);
const ALLOWED_REQUIREMENT_KEYS = new Set([
  'webgpu',
  'minimumDeviceMemoryGB',
  'minimumFreeStorageBytes',
]);
const ALLOWED_GENERATION_KEYS = new Set([
  'temperature',
  'topP',
  'maxOutputTokens',
]);

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  section: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ManifestValidationError(`Unknown key in ${section}: ${key}`);
    }
  }
}

/**
 * Validates raw data as a safe, canonical ModelManifest.
 * Rejects unknown fields, malicious URL schemes, and invalid numeric bounds.
 */
export function validateModelManifest(raw: unknown): ModelManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ManifestValidationError('Manifest must be a non-null object');
  }

  const record = raw as Record<string, unknown>;

  // Check unknown top-level keys
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new ManifestValidationError(`Unknown key in manifest: ${key}`);
    }
  }

  // Reject URL schemes or script content in any string field
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      if (
        value.includes('http://') ||
        value.includes('https://') ||
        value.includes('javascript:')
      ) {
        throw new ManifestValidationError(
          `Field "${key}" must not contain URL schemes`,
        );
      }
    }
  }

  // 1. schemaVersion
  if (record.schemaVersion !== 1) {
    throw new ManifestValidationError(
      `Invalid schemaVersion: ${record.schemaVersion}`,
    );
  }

  // 2. modelId
  if (
    typeof record.modelId !== 'string' ||
    record.modelId.length > 64 ||
    !MODEL_ID_REGEX.test(record.modelId)
  ) {
    throw new ManifestValidationError(`Invalid modelId: ${record.modelId}`);
  }

  // 3. version
  if (
    typeof record.version !== 'string' ||
    record.version.length > 64 ||
    !VERSION_REGEX.test(record.version)
  ) {
    throw new ManifestValidationError(`Invalid version: ${record.version}`);
  }

  // 4. displayName
  if (
    typeof record.displayName !== 'string' ||
    record.displayName.trim() === '' ||
    record.displayName.length > 128 ||
    containsControlCharacter(record.displayName)
  ) {
    throw new ManifestValidationError(
      'displayName must be a non-empty safe string of at most 128 characters',
    );
  }

  // 5. family
  if (
    typeof record.family !== 'string' ||
    !ALLOWED_FAMILIES.has(record.family)
  ) {
    throw new ManifestValidationError(
      `Unsupported model family: ${record.family}`,
    );
  }

  // 6. adapterId
  if (
    typeof record.adapterId !== 'string' ||
    !ALLOWED_ADAPTERS.has(record.adapterId)
  ) {
    throw new ManifestValidationError(
      `Unsupported or dangerous adapterId: ${record.adapterId}`,
    );
  }

  // 7. format
  if (
    typeof record.format !== 'string' ||
    !ALLOWED_FORMATS.has(record.format)
  ) {
    throw new ManifestValidationError(
      `Unsupported model format: ${record.format}`,
    );
  }

  // 8. sizeBytes
  if (
    typeof record.sizeBytes !== 'number' ||
    !Number.isInteger(record.sizeBytes) ||
    record.sizeBytes <= 0 ||
    record.sizeBytes > 20_000_000_000
  ) {
    throw new ManifestValidationError(
      `sizeBytes must be an integer between 1 and 20,000,000,000: ${record.sizeBytes}`,
    );
  }

  // 9. sha256
  if (typeof record.sha256 !== 'string') {
    throw new ManifestValidationError('sha256 must be a string');
  }
  const sha256Lower = record.sha256.toLowerCase();
  if (!SHA256_REGEX.test(sha256Lower)) {
    throw new ManifestValidationError(
      `sha256 must be a 64-character hex digest: ${record.sha256}`,
    );
  }

  // 10. gcsGeneration
  if (
    typeof record.gcsGeneration !== 'string' ||
    !GCS_GENERATION_REGEX.test(record.gcsGeneration) ||
    /^0+$/.test(record.gcsGeneration)
  ) {
    throw new ManifestValidationError(
      `gcsGeneration must be a non-empty numeric string: ${record.gcsGeneration}`,
    );
  }

  // 11. capabilities
  const cap = record.capabilities as Record<string, unknown> | undefined;
  if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) {
    throw new ManifestValidationError('capabilities must be an object');
  }
  rejectUnknownKeys(cap, ALLOWED_CAPABILITY_KEYS, 'capabilities');
  if (cap.textGeneration !== true) {
    throw new ManifestValidationError(
      'capabilities.textGeneration must be true',
    );
  }
  if (!Array.isArray(cap.languages) || cap.languages.length === 0) {
    throw new ManifestValidationError(
      'capabilities.languages must be a non-empty array',
    );
  }
  for (const lang of cap.languages) {
    if (typeof lang !== 'string' || !ALLOWED_LANGUAGES.has(lang)) {
      throw new ManifestValidationError(
        `capabilities.languages contains unsupported language: ${lang}`,
      );
    }
  }
  if (new Set(cap.languages).size !== cap.languages.length) {
    throw new ManifestValidationError(
      'capabilities.languages must not contain duplicates',
    );
  }
  if (
    typeof cap.maxInputTokens !== 'number' ||
    !Number.isInteger(cap.maxInputTokens) ||
    cap.maxInputTokens <= 0 ||
    cap.maxInputTokens > 32768
  ) {
    throw new ManifestValidationError(
      'capabilities.maxInputTokens must be between 1 and 32768',
    );
  }
  if (
    typeof cap.maxOutputTokens !== 'number' ||
    !Number.isInteger(cap.maxOutputTokens) ||
    cap.maxOutputTokens <= 0 ||
    cap.maxOutputTokens > 4096
  ) {
    throw new ManifestValidationError(
      'capabilities.maxOutputTokens must be between 1 and 4096',
    );
  }

  // 12. requirements
  const req = record.requirements as Record<string, unknown> | undefined;
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new ManifestValidationError('requirements must be an object');
  }
  rejectUnknownKeys(req, ALLOWED_REQUIREMENT_KEYS, 'requirements');
  if (req.webgpu !== true) {
    throw new ManifestValidationError('requirements.webgpu must be true');
  }
  if (
    typeof req.minimumDeviceMemoryGB !== 'number' ||
    !Number.isFinite(req.minimumDeviceMemoryGB) ||
    req.minimumDeviceMemoryGB <= 0 ||
    req.minimumDeviceMemoryGB > 1024
  ) {
    throw new ManifestValidationError(
      'requirements.minimumDeviceMemoryGB must be between 0 and 1024',
    );
  }
  if (
    typeof req.minimumFreeStorageBytes !== 'number' ||
    !Number.isInteger(req.minimumFreeStorageBytes) ||
    req.minimumFreeStorageBytes < record.sizeBytes ||
    req.minimumFreeStorageBytes > 100_000_000_000
  ) {
    throw new ManifestValidationError(
      `requirements.minimumFreeStorageBytes (${req.minimumFreeStorageBytes}) must be >= sizeBytes (${record.sizeBytes})`,
    );
  }

  // 13. generation
  const gen = record.generation as Record<string, unknown> | undefined;
  if (typeof gen !== 'object' || gen === null || Array.isArray(gen)) {
    throw new ManifestValidationError('generation must be an object');
  }
  rejectUnknownKeys(gen, ALLOWED_GENERATION_KEYS, 'generation');
  if (
    typeof gen.temperature !== 'number' ||
    !Number.isFinite(gen.temperature) ||
    gen.temperature < 0 ||
    gen.temperature > 2.0
  ) {
    throw new ManifestValidationError(
      'generation.temperature must be between 0.0 and 2.0',
    );
  }
  if (
    typeof gen.topP !== 'number' ||
    !Number.isFinite(gen.topP) ||
    gen.topP < 0 ||
    gen.topP > 1.0
  ) {
    throw new ManifestValidationError(
      'generation.topP must be between 0.0 and 1.0',
    );
  }
  if (
    typeof gen.maxOutputTokens !== 'number' ||
    !Number.isInteger(gen.maxOutputTokens) ||
    gen.maxOutputTokens <= 0 ||
    gen.maxOutputTokens > cap.maxOutputTokens
  ) {
    throw new ManifestValidationError(
      'generation.maxOutputTokens must be positive and no greater than capabilities.maxOutputTokens',
    );
  }

  return {
    schemaVersion: 1,
    modelId: record.modelId,
    version: record.version,
    displayName: record.displayName,
    family: record.family as 'gemma',
    adapterId: record.adapterId as 'litert-lm',
    format: record.format as 'litertlm',
    sizeBytes: record.sizeBytes,
    sha256: sha256Lower,
    gcsGeneration: record.gcsGeneration,
    capabilities: {
      textGeneration: true,
      languages: [...cap.languages],
      maxInputTokens: cap.maxInputTokens,
      maxOutputTokens: cap.maxOutputTokens,
    },
    requirements: {
      webgpu: true,
      minimumDeviceMemoryGB: req.minimumDeviceMemoryGB,
      minimumFreeStorageBytes: req.minimumFreeStorageBytes,
    },
    generation: {
      temperature: gen.temperature,
      topP: gen.topP,
      maxOutputTokens: gen.maxOutputTokens,
    },
  };
}
