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
import {
  GenerationOptions,
  ModelRuntimeAdapter,
  ProbeResult,
  RuntimeMetrics,
} from './model-runtime-adapter.js';

export interface FakeAdapterOptions {
  supported?: boolean;
  loadShouldFail?: boolean;
  generateHandler?: (
    prompt: string,
    options: GenerationOptions,
  ) => AsyncIterable<string> | Promise<string>;
  streamDelayMs?: number;
}

export class FakeModelRuntimeAdapter implements ModelRuntimeAdapter {
  readonly adapterId = 'litert-lm';

  isLoaded = false;
  isCancelled = false;
  lastPrompt: string | null = null;
  lastOptions: GenerationOptions | null = null;
  generatedCount = 0;

  private metrics: RuntimeMetrics = {
    totalMs: 120,
    firstTokenMs: 45,
    firstParsedSuggestionMs: 80,
    outputCharacters: 150,
    tokensPerSecond: 28.5,
    prefillTokensPerSecond: 120.0,
    decodeTokensPerSecond: 32.0,
    dutyCyclePercent: 0,
  };

  constructor(private readonly options: FakeAdapterOptions = {}) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async probe(manifest: ModelManifest, file: File): Promise<ProbeResult> {
    if (this.options.supported === false) {
      return {
        supported: false,
        adapterId: this.adapterId,
        errorMessage: 'Fake adapter simulated unsupported WebGPU device.',
      };
    }
    if (manifest.adapterId !== this.adapterId) {
      return {
        supported: false,
        adapterId: manifest.adapterId,
        errorMessage: `Mismatch adapter: ${manifest.adapterId}`,
      };
    }
    return {supported: true, adapterId: this.adapterId};
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async load(manifest: ModelManifest, file: File): Promise<void> {
    if (this.options.loadShouldFail) {
      throw new Error('Fake adapter simulated load failure');
    }
    this.isLoaded = true;
  }

  async *generate(
    prompt: string,
    options: GenerationOptions,
  ): AsyncIterable<string> {
    if (!this.isLoaded) {
      throw new Error('Model is not loaded');
    }
    this.isCancelled = false;
    this.lastPrompt = prompt;
    this.lastOptions = options;
    this.generatedCount++;

    if (options.signal) {
      options.signal.addEventListener(
        'abort',
        () => {
          this.isCancelled = true;
        },
        {once: true},
      );
    }

    if (this.options.generateHandler) {
      const result = this.options.generateHandler(prompt, options);
      if (Symbol.asyncIterator in Object(result)) {
        for await (const chunk of result as AsyncIterable<string>) {
          if (this.isCancelled || options.signal?.aborted) {
            return;
          }
          yield chunk;
        }
      } else {
        const text = await (result as Promise<string>);
        yield text;
      }
      return;
    }

    // Default mock response generator based on prompt
    const isWord =
      prompt.includes('word') ||
      prompt.includes('WordGeneric') ||
      prompt.includes('WordJapanese');
    const defaultLines = isWord
      ? '1. localword\n2. testword\n3. another\n4. voice\n5. predict'
      : '1. This is a local sentence.\n2. Another local prediction.\n3. Ready to communicate.\n4. Hello world.\n5. Project voice on device.';

    const chunks = defaultLines.split('\n');
    for (const chunk of chunks) {
      if (this.isCancelled || options.signal?.aborted) {
        return;
      }
      if (this.options.streamDelayMs) {
        await new Promise(resolve =>
          window.setTimeout(resolve, this.options.streamDelayMs),
        );
      }
      yield chunk + '\n';
    }
  }

  async cancel(): Promise<void> {
    this.isCancelled = true;
  }

  async dispose(): Promise<void> {
    this.isLoaded = false;
    this.isCancelled = true;
  }

  getMetrics(): RuntimeMetrics {
    return this.metrics;
  }

  setMetrics(metrics: Partial<RuntimeMetrics>): void {
    this.metrics = {...this.metrics, ...metrics};
  }
}
