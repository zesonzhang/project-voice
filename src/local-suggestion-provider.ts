import {UNCONFIGURED_LOCAL_MODEL_IDENTITY} from './on-device/model-identity.js';
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

/** CI seam for Local routing until M3 supplies the LiteRT-LM generator. */
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

/** Production placeholder until M3 connects the installed LiteRT-LM runtime. */
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
