import {CloudSuggestionProvider} from '../cloud-suggestion-provider.js';
import {
  MockLocalSuggestionProvider,
  normalizeLocalInput,
  parseSuggestionResponse,
} from '../local-suggestion-provider.js';
import {MacroApiClient} from '../macro-api-client.js';
import {renderPrompt} from '../prompt-renderer.js';
import {PROMPT_TEMPLATES} from '../prompt-templates.js';
import {
  SuggestionProvider,
  SuggestionProviderError,
  SuggestionProviderIdentity,
  SuggestionRequest,
  SuggestionResult,
} from '../suggestion-provider.js';
import {SuggestionProviderRouter} from '../suggestion-provider-router.js';

const request: SuggestionRequest = {
  text: 'hello',
  language: 'English',
  cloudModel: 'gemini',
  sentencePromptId: 'SentenceGeneric20260130',
  wordPromptId: 'WordGeneric20240628',
  persona: '',
  lastOutputSpeech: '',
  lastInputSpeech: '',
  conversationHistory: '',
  sentenceEmotion: '',
};

class RecordingProvider implements SuggestionProvider {
  calls = 0;
  aborts = 0;
  readonly mode: 'cloud' | 'local';
  constructor(
    mode: 'cloud' | 'local',
    private readonly failure?: Error,
  ) {
    this.mode = mode;
  }
  abort() {
    this.aborts++;
  }
  getIdentity(request: SuggestionRequest): SuggestionProviderIdentity {
    return {modelId: request.cloudModel, modelVersion: 'test-version'};
  }
  async suggest(): Promise<SuggestionResult> {
    this.calls++;
    if (this.failure) throw this.failure;
    return {sentences: ['sentence'], words: ['word'], provider: this.mode};
  }
}

describe('Suggestion providers', () => {
  it('preserves the Cloud request payload, result shape, and abort behavior', async () => {
    const fetchSpy = spyOn(
      MacroApiClient.prototype,
      'fetchSuggestions',
    ).and.resolveTo([['sentence'], ['word']]);
    const abortSpy = spyOn(MacroApiClient.prototype, 'abortFetch');
    const cloud = new CloudSuggestionProvider();

    expect(await cloud.suggest(request)).toEqual({
      sentences: ['sentence'],
      words: ['word'],
      provider: 'cloud',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
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
    cloud.abort();
    expect(abortSpy).toHaveBeenCalled();
  });

  it('routes Local errors without calling Cloud', async () => {
    let cloudInstantiations = 0;
    const local = new RecordingProvider(
      'local',
      new SuggestionProviderError('local_unavailable', 'not ready'),
    );
    const router = new SuggestionProviderRouter(() => {
      cloudInstantiations++;
      return new RecordingProvider('cloud');
    }, local);
    await expectAsync(router.suggest('local', request)).toBeRejectedWithError(
      'not ready',
    );
    expect(local.calls).toBe(1);
    expect(cloudInstantiations).toBe(0);
  });

  it('renders prompts locally and normalizes numbered Local output', async () => {
    const prompts: string[] = [];
    const partials: string[][] = [];
    const local = new MockLocalSuggestionProvider(async (prompt, signal) => {
      expect(signal.aborted).toBeFalse();
      prompts.push(prompt);
      return '1. One*\n2. One\n3. Two';
    });
    const result = await local.suggest(request, partial => {
      partials.push(partial.words);
    });
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain('hello');
    expect(result).toEqual(
      jasmine.objectContaining({provider: 'local', sentences: ['One', 'Two']}),
    );
    expect(partials).toEqual([['One', 'Two']]);
  });

  it('matches backend input and Japanese output normalization', () => {
    expect(
      normalizeLocalInput('hello world ', 'English', 'WordGeneric20240628'),
    ).toBe('hello§world ');
    expect(
      normalizeLocalInput('日本 語 ', 'Japanese', 'SentenceJapanese20240628'),
    ).toBe('日本§語§');
    expect(
      parseSuggestionResponse('1. 日 本*§語\n2. 同じ\n3. 同じ', 'Japanese'),
    ).toEqual(['日本 語', '同じ']);
  });

  it('aborts generation without converting cancellation to an error', async () => {
    const local = new MockLocalSuggestionProvider(
      (_prompt, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const pending = local.suggest(request);
    local.abort();
    await expectAsync(pending).toBeResolvedTo(null);
  });

  it('aborts the previous route when inference mode changes', async () => {
    const cloud = new RecordingProvider('cloud');
    const local = new RecordingProvider('local');
    const router = new SuggestionProviderRouter(() => cloud, local);
    await router.suggest('cloud', request);
    await router.suggest('local', request);
    expect(cloud.aborts).toBe(1);
  });

  it('supports nested conditionals and rejects unknown prompt IDs', () => {
    const prompt = renderPrompt('WordGeneric20240628', {...request, num: '5'});
    expect(prompt).toContain('given sentence');
    expect(() => renderPrompt('not-a-template', {})).toThrowError(
      'Unknown prompt ID: not-a-template',
    );
  });

  it('renders every canonical template with all supported variables', () => {
    const variables = {
      ...request,
      num: '5',
      persona: 'A <profile>',
      lastInputSpeech: 'partner',
      lastOutputSpeech: 'me',
      conversationHistory: 'history',
      sentenceEmotion: 'question',
    };
    for (const promptId of Object.keys(PROMPT_TEMPLATES)) {
      const output = renderPrompt(promptId, variables);
      expect(output).not.toContain('{{');
      expect(output).not.toContain('{%');
      expect(output).toContain('hello');
    }
  });
});
