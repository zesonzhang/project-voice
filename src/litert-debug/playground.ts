import {
  ChatMessage,
  GenerationOptions,
  ModelRuntimeAdapter,
  RuntimeMetrics,
} from '../on-device/model-runtime-adapter.js';
import {renderPrompt} from '../prompt-renderer.js';
import {PROMPT_TEMPLATES} from '../prompt-templates.js';
import {
  normalizeLocalInput,
  parseSuggestionResponse,
} from '../suggestion-parser.js';

export function templateVariables(ids: string[]): string[] {
  // Language is also consumed by input normalization and output parsing.
  const keys = new Set<string>(['language']);
  for (const id of ids) {
    const template = PROMPT_TEMPLATES[id as keyof typeof PROMPT_TEMPLATES];
    if (!template) throw new Error(`Unknown prompt: ${id}`);
    for (const match of template.matchAll(
      /(?:{{\s*|{%\s*if\s+)([A-Za-z][A-Za-z0-9_]*)/g,
    )) {
      if (match[1] !== 'text') keys.add(match[1]);
    }
  }
  return [...keys];
}
export interface PlaygroundOutput {
  label: string;
  prompt: string;
  raw: string;
  suggestions: string[];
  metrics?: RuntimeMetrics;
  interrupted?: boolean;
}
export class Playground {
  history: ChatMessage[] = [];
  outputs: PlaygroundOutput[] = [];
  private sequence = 0;
  private controller?: AbortController;
  private pending?: Promise<void>;
  constructor(
    private readonly runtime: ModelRuntimeAdapter,
    private readonly changed: () => void,
  ) {}

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.pending;
  }
  async reset(): Promise<void> {
    await this.stop();
    this.history = [];
    this.outputs = [];
    this.changed();
  }
  run(
    mode: 'suggest' | 'chat',
    input: string,
    ids: string[],
    variables: Record<string, string>,
    options: Omit<GenerationOptions, 'sequenceId'>,
  ): Promise<void> {
    if (this.pending)
      return Promise.reject(new Error('已有生成任务正在运行。'));
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.generate(
      mode,
      input,
      ids,
      variables,
      options,
      controller.signal,
    ).finally(() => {
      this.pending = undefined;
      this.controller = undefined;
    });
    return this.pending;
  }
  private async generate(
    mode: 'suggest' | 'chat',
    input: string,
    ids: string[],
    variables: Record<string, string>,
    options: Omit<GenerationOptions, 'sequenceId'>,
    signal: AbortSignal,
  ): Promise<void> {
    if (mode === 'suggest') this.outputs = [];
    for (const id of mode === 'suggest' ? ids : ['chat']) {
      if (signal.aborted) break;
      const prompt =
        mode === 'chat'
          ? input
          : renderPrompt(id, {
              ...variables,
              text: normalizeLocalInput(input, variables.language, id),
            });
      const output: PlaygroundOutput = {
        label: id,
        prompt,
        raw: '',
        suggestions: [],
      };
      this.outputs = [...this.outputs, output];
      this.changed();
      try {
        for await (const chunk of this.runtime.generate(prompt, {
          ...options,
          history: mode === 'chat' ? [...this.history] : undefined,
          sequenceId: ++this.sequence,
          signal,
        })) {
          if (signal.aborted) continue;
          output.raw += chunk;
          if (mode === 'suggest')
            output.suggestions = parseSuggestionResponse(
              output.raw,
              variables.language,
              Number(variables.num),
            );
          this.changed();
        }
        if (!signal.aborted) {
          output.metrics = this.runtime.getMetrics();
          if (mode === 'chat')
            this.history.push(
              {role: 'user', content: input},
              {role: 'assistant', content: output.raw},
            );
        }
      } catch (error) {
        output.interrupted = true;
        if (!signal.aborted) throw error;
      } finally {
        output.interrupted ||= signal.aborted;
        this.changed();
      }
    }
  }
}
