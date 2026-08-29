import {UNCONFIGURED_LOCAL_MODEL_IDENTITY} from './on-device/model-identity.js';
import {ModelRuntimeAdapter} from './on-device/model-runtime-adapter.js';
import {renderPrompt} from './prompt-renderer.js';
import {
  normalizeLocalInput,
  parseSuggestionResponse,
} from './suggestion-parser.js';
import {
  SuggestionPartialResultHandler,
  SuggestionProvider,
  SuggestionProviderError,
  SuggestionProviderIdentity,
  SuggestionRequest,
  SuggestionResult,
} from './suggestion-provider.js';
const DEFAULT_LOCAL_IDENTITY: SuggestionProviderIdentity = {
  ...UNCONFIGURED_LOCAL_MODEL_IDENTITY,
};

export {
  normalizeLocalInput,
  parseSuggestionResponse,
} from './suggestion-parser.js';

/** Production LocalSuggestionProvider powered by ModelRuntimeAdapter. */
export class LocalSuggestionProvider implements SuggestionProvider {
  readonly mode = 'local' as const;
  private controller: AbortController | null = null;
  private sequenceCounter = 0;

  constructor(
    private readonly runtimeAdapter: ModelRuntimeAdapter,
    private readonly identityProvider: () => SuggestionProviderIdentity = () =>
      DEFAULT_LOCAL_IDENTITY,
    private readonly readyChecker: () => boolean = () => true,
  ) {}

  getIdentity(): SuggestionProviderIdentity {
    return this.identityProvider();
  }

  abort() {
    this.sequenceCounter++;
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
    void this.runtimeAdapter.cancel();
  }

  async suggest(
    request: SuggestionRequest,
    onPartialResult?: SuggestionPartialResultHandler,
  ): Promise<SuggestionResult | null> {
    const sequenceId = ++this.sequenceCounter;
    const previousController = this.controller;
    previousController?.abort();
    if (previousController) {
      try {
        await this.runtimeAdapter.cancel();
      } catch {
        // The following generation/load state reports runtime failures. The
        // sequence gate still guarantees that stale output is discarded.
      }
    }
    if (sequenceId !== this.sequenceCounter) return null;

    if (!this.readyChecker()) {
      throw new SuggestionProviderError(
        'local_unavailable',
        'Local model is not loaded or ready.',
      );
    }

    this.controller = new AbortController();
    const signal = this.controller.signal;
    const identity = this.getIdentity();

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
      // 1. Generate words first
      const wordPrompt = renderPrompt(request.wordPromptId, {
        ...commonVariables,
        text: normalizeLocalInput(
          request.text,
          request.language,
          request.wordPromptId,
        ),
      });

      let wordOutput = '';
      for await (const chunk of this.runtimeAdapter.generate(wordPrompt, {
        sequenceId,
        signal,
        maxOutputTokens: 128,
        temperature: 0,
        topP: 0.5,
      })) {
        if (signal.aborted || sequenceId !== this.sequenceCounter) return null;
        wordOutput += chunk;
      }

      if (signal.aborted || sequenceId !== this.sequenceCounter) return null;
      const words = parseSuggestionResponse(wordOutput, request.language);
      onPartialResult?.({words, provider: 'local', ...identity});

      // 2. Generate sentences second (serialized to avoid memory/GPU thrashing)
      const sentencePrompt = renderPrompt(request.sentencePromptId, {
        ...commonVariables,
        text: normalizeLocalInput(
          request.text,
          request.language,
          request.sentencePromptId,
        ),
      });

      let sentenceOutput = '';
      for await (const chunk of this.runtimeAdapter.generate(sentencePrompt, {
        sequenceId,
        signal,
        maxOutputTokens: 256,
        temperature: 0,
        topP: 0.5,
      })) {
        if (signal.aborted || sequenceId !== this.sequenceCounter) return null;
        sentenceOutput += chunk;
      }

      if (signal.aborted || sequenceId !== this.sequenceCounter) return null;
      const sentences = parseSuggestionResponse(
        sentenceOutput,
        request.language,
      );

      return {
        sentences,
        words,
        provider: 'local',
        ...identity,
      };
    } catch (error) {
      if (
        (error instanceof DOMException && error.name === 'AbortError') ||
        signal.aborted
      ) {
        return null;
      }
      if (error instanceof SuggestionProviderError) throw error;
      throw new SuggestionProviderError(
        'request_failed',
        (error as Error).message || 'Local inference failed.',
      );
    } finally {
      if (sequenceId === this.sequenceCounter) {
        this.controller = null;
      }
    }
  }
}

/** Explicit unavailable provider for deployments that do not configure a runtime. */
export class UnavailableLocalSuggestionProvider implements SuggestionProvider {
  readonly mode = 'local' as const;
  abort() {}
  getIdentity(): SuggestionProviderIdentity {
    return DEFAULT_LOCAL_IDENTITY;
  }
  async suggest(): Promise<never> {
    throw new SuggestionProviderError(
      'local_unavailable',
      'Local inference is not available yet.',
    );
  }
}
