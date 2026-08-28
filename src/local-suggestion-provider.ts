import {UNCONFIGURED_LOCAL_MODEL_IDENTITY} from './on-device/model-identity.js';
import {ModelRuntimeAdapter} from './on-device/model-runtime-adapter.js';
import {renderPrompt} from './prompt-renderer.js';
import {
  SuggestionPartialResultHandler,
  SuggestionProvider,
  SuggestionProviderError,
  SuggestionProviderIdentity,
  SuggestionRequest,
  SuggestionResult,
} from './suggestion-provider.js';

export type LocalGenerator = (
  prompt: string,
  signal: AbortSignal,
) => Promise<string>;

const DEFAULT_LOCAL_IDENTITY: SuggestionProviderIdentity = {
  ...UNCONFIGURED_LOCAL_MODEL_IDENTITY,
};

export function normalizeLocalInput(
  text: string,
  language: string,
  promptId: string,
): string {
  let normalized = language === 'Japanese' ? text.replaceAll(' ', '§') : text;
  if (promptId === 'WordGeneric20240628') {
    normalized = normalized.replaceAll(' ', '§').replace(/§$/, ' ');
  }
  return normalized;
}

export function parseSuggestionResponse(
  response: string,
  language: string,
  num = 5,
): string[] {
  let cleaned = response.replaceAll('\\\n', '').replaceAll('*', '');
  if (language === 'Japanese') {
    // Match macro.py's ASCII-mode removal of half-width spaces in Japanese.
    cleaned = cleaned.replace(/([^\w;:,.?]) +(\W)/g, '$1$2');
  }
  cleaned = cleaned.replaceAll('§', ' ');
  return Array.from(
    new Set(
      cleaned
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^\d+\./.test(line))
        .map(line => line.replace(/^\d+\.\s?/, '')),
    ),
  ).slice(0, num);
}

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
