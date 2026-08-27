import {MacroApiClient} from './macro-api-client.js';
import {
  SuggestionProvider,
  SuggestionProviderIdentity,
  SuggestionRequest,
  SuggestionResult,
} from './suggestion-provider.js';

/** Backward-compatible wrapper around the existing Cloud request contract. */
export class CloudSuggestionProvider implements SuggestionProvider {
  readonly mode = 'cloud' as const;
  constructor(private readonly client = new MacroApiClient()) {}
  getIdentity(request: SuggestionRequest): SuggestionProviderIdentity {
    // Gemini preview/version information is encoded in the selected model ID.
    return {modelId: request.cloudModel, modelVersion: request.cloudModel};
  }
  abort() {
    this.client.abortFetch();
  }
  async suggest(request: SuggestionRequest): Promise<SuggestionResult | null> {
    const result = await this.client.fetchSuggestions(
      request.text,
      request.language,
      request.cloudModel,
      {
        sentenceMacroId: request.sentencePromptId,
        wordMacroId: request.wordPromptId,
        persona: request.persona,
        lastOutputSpeech: request.lastOutputSpeech,
        lastInputSpeech: request.lastInputSpeech,
        conversationHistory: request.conversationHistory,
        sentenceEmotion: request.sentenceEmotion,
      },
    );
    return (
      result && {sentences: result[0], words: result[1], provider: 'cloud'}
    );
  }
}
