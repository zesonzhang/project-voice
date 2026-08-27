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

import {
  ManifestValidationError,
  ModelManifest,
  validateModelManifest,
} from '../on-device/model-manifest.js';

describe('ModelManifest Schema Validation', () => {
  const validRawManifest: ModelManifest = {
    schemaVersion: 1,
    modelId: 'gemma-web-default',
    version: '2026-08-01',
    displayName: 'Gemma 4 E2B IT Web',
    family: 'gemma',
    adapterId: 'litert-lm',
    format: 'litertlm',
    sizeBytes: 2008432640,
    sha256: '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5',
    gcsGeneration: '1738700000000000',
    capabilities: {
      textGeneration: true,
      languages: ['en', 'ja', 'zh', 'fr', 'de', 'sv'],
      maxInputTokens: 4096,
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

  it('validates a correct manifest and normalizes sha256', () => {
    const raw = JSON.parse(JSON.stringify(validRawManifest));
    raw.sha256 = raw.sha256.toUpperCase();
    const result = validateModelManifest(raw);
    expect(result.modelId).toBe('gemma-web-default');
    expect(result.sha256).toBe(validRawManifest.sha256.toLowerCase());
    expect(result.capabilities.languages.length).toBe(6);
  });

  it('rejects unknown top-level keys', () => {
    const raw = {
      ...validRawManifest,
      unauthorizedField: 'dangerous',
    };
    expect(() => validateModelManifest(raw)).toThrowError(
      ManifestValidationError,
      /Unknown key in manifest/,
    );
  });

  it('rejects URL schemes in manifest fields', () => {
    const raw = {
      ...validRawManifest,
      displayName: 'https://evil.com/script.js',
    };
    expect(() => validateModelManifest(raw)).toThrowError(
      ManifestValidationError,
      /must not contain URL schemes/,
    );
  });

  it('rejects unsupported adapterId', () => {
    const raw = {
      ...validRawManifest,
      adapterId: 'unapproved-custom-adapter',
    };
    expect(() => validateModelManifest(raw)).toThrowError(
      ManifestValidationError,
      /Unsupported or dangerous adapterId/,
    );
  });

  it('rejects unsupported format', () => {
    const raw = {
      ...validRawManifest,
      format: 'exe',
    };
    expect(() => validateModelManifest(raw)).toThrowError(
      ManifestValidationError,
      /Unsupported model format/,
    );
  });

  it('rejects invalid sizeBytes bounds', () => {
    const negative = {...validRawManifest, sizeBytes: -100};
    expect(() => validateModelManifest(negative)).toThrowError(
      ManifestValidationError,
      /sizeBytes must be an integer/,
    );

    const zero = {...validRawManifest, sizeBytes: 0};
    expect(() => validateModelManifest(zero)).toThrowError(
      ManifestValidationError,
      /sizeBytes must be an integer/,
    );
  });

  it('rejects malformed sha256', () => {
    const raw = {...validRawManifest, sha256: 'short-sha'};
    expect(() => validateModelManifest(raw)).toThrowError(
      ManifestValidationError,
      /sha256 must be a 64-character hex digest/,
    );
  });

  it('rejects unsupported languages in capabilities', () => {
    const raw = {
      ...validRawManifest,
      capabilities: {
        ...validRawManifest.capabilities,
        languages: ['en', 'esperanto'],
      },
    };
    expect(() => validateModelManifest(raw)).toThrowError(
      ManifestValidationError,
      /unsupported language/,
    );
  });

  it('rejects minimumFreeStorageBytes less than sizeBytes', () => {
    const raw = {
      ...validRawManifest,
      requirements: {
        ...validRawManifest.requirements,
        minimumFreeStorageBytes: validRawManifest.sizeBytes - 1,
      },
    };
    expect(() => validateModelManifest(raw)).toThrowError(
      ManifestValidationError,
      /must be >= sizeBytes/,
    );
  });

  it('rejects temperature out of bounds [0.0, 2.0]', () => {
    const raw = {
      ...validRawManifest,
      generation: {
        ...validRawManifest.generation,
        temperature: 2.5,
      },
    };
    expect(() => validateModelManifest(raw)).toThrowError(
      ManifestValidationError,
      /temperature must be between/,
    );
  });

  it('rejects unknown nested fields and non-finite numbers', () => {
    const withNestedKey = {
      ...validRawManifest,
      capabilities: {
        ...validRawManifest.capabilities,
        scriptUrl: 'data:text/javascript,alert(1)',
      },
    };
    expect(() => validateModelManifest(withNestedKey)).toThrowError(
      ManifestValidationError,
      /Unknown key in capabilities/,
    );

    const withNaN = {
      ...validRawManifest,
      generation: {...validRawManifest.generation, temperature: NaN},
    };
    expect(() => validateModelManifest(withNaN)).toThrowError(
      ManifestValidationError,
      /temperature/,
    );
  });
});
