import {InferenceMode} from './config-storage.js';
import {
  SuggestionPartialResultHandler,
  SuggestionProvider,
  SuggestionProviderIdentity,
  SuggestionRequest,
  SuggestionResult,
} from './suggestion-provider.js';

/** Selects exactly one provider; Local errors are deliberately never retried in Cloud. */
export class SuggestionProviderRouter {
  private cloudProvider: SuggestionProvider | null = null;
  constructor(
    private readonly createCloudProvider: () => SuggestionProvider,
    private readonly local: SuggestionProvider,
  ) {
    if (local.mode !== 'local') {
      throw new Error('Local route requires a Local provider.');
    }
  }
  private selected(mode: InferenceMode) {
    if (mode === 'local') return this.local;
    this.cloudProvider ??= this.createCloudProvider();
    if (this.cloudProvider.mode !== 'cloud') {
      throw new Error('Cloud provider factory returned a non-Cloud provider.');
    }
    return this.cloudProvider;
  }
  abort() {
    this.local.abort();
    this.cloudProvider?.abort();
  }
  getIdentity(
    mode: InferenceMode,
    request: SuggestionRequest,
  ): SuggestionProviderIdentity {
    return this.selected(mode).getIdentity(request);
  }
  suggest(
    mode: InferenceMode,
    request: SuggestionRequest,
    onPartialResult?: SuggestionPartialResultHandler,
  ): Promise<SuggestionResult | null> {
    const provider = this.selected(mode);
    // Cancel the other route so a result cannot cross an inference-mode switch.
    if (provider === this.local) this.cloudProvider?.abort();
    else this.local.abort();
    return provider.suggest(request, onPartialResult);
  }
}
