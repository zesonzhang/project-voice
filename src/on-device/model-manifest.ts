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
