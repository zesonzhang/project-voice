import {InferenceMode} from './config-storage.js';

export interface SuggestionRequest {
  text: string;
  language: string;
  cloudModel: string;
  sentencePromptId: string;
  wordPromptId: string;
  persona: string;
  lastOutputSpeech: string;
  lastInputSpeech: string;
  conversationHistory: string;
  sentenceEmotion: string;
}

export interface SuggestionResult {
  sentences: string[];
  words: string[];
  provider: InferenceMode;
  modelId?: string;
  modelVersion?: string;
}

/** An incremental result that can be shown before sentence generation ends. */
export interface SuggestionPartialResult {
  words: string[];
  provider: InferenceMode;
  modelId?: string;
  modelVersion?: string;
}

export interface SuggestionProviderIdentity {
  modelId: string;
  modelVersion: string;
}

export type SuggestionPartialResultHandler = (
  result: SuggestionPartialResult,
) => void;

export class SuggestionProviderError extends Error {
  constructor(
    readonly code: 'aborted' | 'local_unavailable' | 'request_failed',
    message: string,
  ) {
    super(message);
  }
}

export interface SuggestionProvider {
  readonly mode: InferenceMode;
  abort(): void;
  getIdentity(request: SuggestionRequest): SuggestionProviderIdentity;
  suggest(
    request: SuggestionRequest,
    onPartialResult?: SuggestionPartialResultHandler,
  ): Promise<SuggestionResult | null>;
}
