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

import {ModelManifest} from './model-manifest.js';

export interface ProbeResult {
  supported: boolean;
  adapterId: string;
  errorMessage?: string;
}

export interface GenerationOptions {
  sequenceId: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
}

export interface RuntimeMetrics {
  totalMs: number;
  firstTokenMs: number | null;
  firstParsedSuggestionMs?: number | null;
  outputCharacters: number;
  tokensPerSecond?: number | null;
  prefillTokensPerSecond?: number | null;
  decodeTokensPerSecond?: number | null;
  /** Percentage of wall time spent generating over the latest 60 seconds. */
  dutyCyclePercent?: number;
}

/**
 * Standard runtime adapter interface for on-device inference engines.
 * Isolates runtime specifics (LiteRT-LM, WebGPU, etc.) from the application.
 */
export interface ModelRuntimeAdapter {
  readonly adapterId: string;

  probe(manifest: ModelManifest, file: File): Promise<ProbeResult>;
  load(manifest: ModelManifest, file: File): Promise<void>;
  generate(prompt: string, options: GenerationOptions): AsyncIterable<string>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
  getMetrics(): RuntimeMetrics;
}
