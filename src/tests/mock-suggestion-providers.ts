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

import {UNCONFIGURED_LOCAL_MODEL_IDENTITY} from '../on-device/model-identity.js';
import {renderPrompt} from '../prompt-renderer.js';
import {
  normalizeLocalInput,
  parseSuggestionResponse,
} from '../suggestion-parser.js';
import {
  SuggestionPartialResultHandler,
  SuggestionProvider,
  SuggestionProviderError,
  SuggestionProviderIdentity,
  SuggestionRequest,
  SuggestionResult,
} from '../suggestion-provider.js';

export type LocalGenerator = (
  prompt: string,
  signal: AbortSignal,
) => Promise<string>;

const DEFAULT_LOCAL_IDENTITY: SuggestionProviderIdentity = {
  ...UNCONFIGURED_LOCAL_MODEL_IDENTITY,
};

/** Deterministic Local routing seam for unit and browser tests. */
export class MockLocalSuggestionProvider implements SuggestionProvider {
  readonly mode = 'local' as const;
  private controller: AbortController | null = null;
  constructor(
    private readonly generate: LocalGenerator = async (_prompt, signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return '1. Local suggestion\n2. Another local suggestion';
    },
    private readonly identity: SuggestionProviderIdentity = DEFAULT_LOCAL_IDENTITY,
  ) {}
  getIdentity(): SuggestionProviderIdentity {
    return this.identity;
  }
  abort() {
    this.controller?.abort();
  }
  async suggest(
    request: SuggestionRequest,
    onPartialResult?: SuggestionPartialResultHandler,
  ): Promise<SuggestionResult | null> {
    this.abort();
    this.controller = new AbortController();
    const commonVariables = {
      language: request.language,
      num: '5',
      persona: request.persona,
      lastOutputSpeech: request.lastOutputSpeech,
      lastInputSpeech: request.lastInputSpeech,
      conversationHistory: request.conversationHistory,
      sentenceEmotion: request.sentenceEmotion,
    };
    try {
      const sentencePromise = this.generate(
        renderPrompt(request.sentencePromptId, {
          ...commonVariables,
          text: normalizeLocalInput(
            request.text,
            request.language,
            request.sentencePromptId,
          ),
        }),
        this.controller.signal,
      ).then(output => parseSuggestionResponse(output, request.language));
      const wordPromise = this.generate(
        renderPrompt(request.wordPromptId, {
          ...commonVariables,
          text: normalizeLocalInput(
            request.text,
            request.language,
            request.wordPromptId,
          ),
        }),
        this.controller.signal,
      ).then(output => {
        const words = parseSuggestionResponse(output, request.language);
        onPartialResult?.({words, provider: 'local', ...this.identity});
        return words;
      });
      const [sentences, words] = await Promise.all([
        sentencePromise,
        wordPromise,
      ]);
      return {
        sentences,
        words,
        provider: 'local',
        ...this.identity,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        return null;
      if (error instanceof SuggestionProviderError) throw error;
      throw new SuggestionProviderError(
        'local_unavailable',
        'Local model is unavailable.',
      );
    }
  }
}
