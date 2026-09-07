import {css, html, LitElement} from 'lit';
import {customElement, state} from 'lit/decorators.js';

import {IndexedDbModelMetadataStore} from '../on-device/model-metadata.js';
import {OpfsModelStorage} from '../on-device/model-storage.js';
import {BrowserTabCoordinator} from '../on-device/tab-coordinator.js';
import {InferenceWorkerClient} from '../on-device/worker-client.js';
import {PROMPT_IDS} from '../prompt-templates.js';
import {DEBUG_MODEL, MODEL_URL, PublicDebugModel} from './model.js';
import {Playground, templateVariables} from './playground.js';

const labels: Record<string, string> = {
  language: '语言',
  num: '联想数量',
  persona: 'Persona / 用户背景',
  sentenceEmotion: '情绪',
  conversationHistory: '对话历史',
  lastInputSpeech: '最近输入语音文本',
  lastOutputSpeech: '最近输出语音文本',
};

@customElement('litert-debug')
export class LiteRtDebug extends LitElement {
  static styles = css`
    :host {
      display: block;
      color: #18263d;
      font:
        15px/1.5 system-ui,
        sans-serif;
      max-width: 1400px;
      margin: auto;
      padding: 32px;
    }
    * {
      box-sizing: border-box;
    }
    h1 {
      font-size: 28px;
      letter-spacing: -1px;
      margin: 0;
    }
    h2 {
      font-size: 17px;
      margin: 0 0 16px;
    }
    p {
      margin: 8px 0;
    }
    small,
    .muted {
      color: #62718a;
    }
    header {
      margin-bottom: 26px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 24px;
      align-items: start;
    }
    aside,
    main {
      min-width: 0;
    }
    section {
      background: white;
      border: 1px solid #dbe1eb;
      border-radius: 16px;
      padding: 22px;
      margin-bottom: 18px;
    }
    label {
      display: block;
      margin: 12px 0;
      font-size: 13px;
      font-weight: 600;
    }
    input,
    textarea,
    select {
      display: block;
      width: 100%;
      font: inherit;
      color: inherit;
      background: #fbfcfe;
      border: 1px solid #cbd4e2;
      border-radius: 8px;
      padding: 10px;
      margin-top: 5px;
    }
    textarea {
      resize: vertical;
      min-height: 78px;
    }
    button {
      font: inherit;
      cursor: pointer;
      border: 1px solid #cbd4e2;
      background: white;
      color: inherit;
      border-radius: 8px;
      padding: 8px 12px;
    }
    button:hover {
      background: #edf2fc;
    }
    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    button.primary,
    button.selected {
      background: #235cd6;
      border-color: #235cd6;
      color: white;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 22px;
    }
    .error {
      background: #fff1ee;
      color: #9d3027;
      padding: 14px;
      border-radius: 10px;
      white-space: pre-wrap;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font:
        13px/1.6 ui-monospace,
        monospace;
    }
    details {
      margin-top: 16px;
    }
    summary {
      cursor: pointer;
      color: #53657d;
    }
    progress {
      width: 100%;
      accent-color: #235cd6;
    }
    .chip {
      display: inline-block;
      background: #edf3ff;
      border-radius: 8px;
      padding: 8px 12px;
      margin: 4px 5px 4px 0;
    }
    .raw {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    a {
      color: #235cd6;
    }
    fieldset {
      border: 0;
      padding: 0;
      margin: 0;
      min-width: 0;
    }
    .badge {
      font-size: 12px;
      background: #e8edf5;
      border-radius: 20px;
      padding: 6px 12px;
    }
    .metrics {
      font-size: 12px;
      color: #62718a;
      margin-top: 14px;
    }
    @media (max-width: 760px) {
      :host {
        padding: 18px;
      }
      .layout {
        grid-template-columns: 1fr;
      }
      header {
        align-items: start;
        gap: 12px;
      }
      h1 {
        font-size: 23px;
      }
    }
  `;
  private storage = new OpfsModelStorage();
  private metadata = new IndexedDbModelMetadataStore();
  private coordinator = new BrowserTabCoordinator();
  private model = new PublicDebugModel({
    storage: this.storage,
    metadata: this.metadata,
    coordinator: this.coordinator,
  });
  private runtime = new InferenceWorkerClient({
    workerUrl: '/static/litert-debug/worker.js',
    loadTimeoutMs: 180000,
  });
  private playground = new Playground(this.runtime, () => this.requestUpdate());
  private downloadController?: AbortController;
  @state() private mode: 'suggest' | 'chat' = 'suggest';
  @state() private cached = false;
  @state() private ready = false;
  @state() private busy = false;
  @state() private generating = false;
  @state() private error = '';
  @state() private status = '检查环境';
  @state() private capability = '';
  @state() private bytes = 0;
  @state() private loadMs?: number;
  @state() private wordId = 'WordMandarin20250616';
  @state() private sentenceId = 'SentenceMandarin20250616';
  @state() private input = '';
  @state() private variables: Record<string, string> = {
    language: 'Mandarin',
    num: '5',
    persona: '',
    sentenceEmotion: '',
    conversationHistory: '',
    lastInputSpeech: '',
    lastOutputSpeech: '',
  };
  @state() private temperature = 0;
  @state() private topP = 0.5;
  @state() private maxOutputTokens = 256;
  private unsubscribe?: () => void;
  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe = this.runtime.onStatusChange(event => {
      this.ready =
        event.status === 'ready' ||
        event.status === 'generating' ||
        event.status === 'canceling';
      if (event.errorMessage) this.error = event.errorMessage;
    });
    void this.action(async () => {
      this.cached = await this.model.cached();
      const cap = await this.runtime.getCapabilities();
      this.capability = `WebGPU ${cap.deviceAvailable ? '✓' : '✕'} · 隔离 ${cap.crossOriginIsolated ? '✓' : '✕'} · OPFS ${typeof navigator.storage?.getDirectory === 'function' ? '✓' : '✕'}`;
      this.status = this.cached ? '已缓存，点击加载' : '尚未下载';
    });
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.downloadController?.abort();
    void this.playground.stop().finally(async () => {
      await this.runtime.dispose();
      await this.metadata.close();
      this.coordinator.close();
    });
  }
  private async action(fn: () => Promise<void>): Promise<void> {
    this.error = '';
    this.busy = true;
    try {
      await fn();
    } catch (error) {
      this.status =
        (error as Error).name === 'AbortError' ? '下载已暂停' : '操作未完成';
      this.error =
        (error as Error).name === 'AbortError'
          ? '下载已取消，可重试继续。'
          : (error as Error).message;
    } finally {
      this.busy = false;
    }
  }
  private download(): void {
    void this.action(async () => {
      this.downloadController = new AbortController();
      try {
        await this.model.download(
          this.downloadController.signal,
          (bytes, phase) => {
            this.bytes = bytes;
            this.status = phase;
          },
        );
        this.cached = await this.model.cached();
        this.status = '已缓存，点击加载';
      } finally {
        this.downloadController = undefined;
      }
    });
  }
  private load(): void {
    void this.action(async () => {
      this.status = '加载模型并执行 smoke test…';
      if (!(await this.model.cached())) {
        this.cached = false;
        throw new Error('缓存不可用，请重新下载。');
      }
      const start = performance.now();
      await this.runtime.load(
        DEBUG_MODEL,
        await this.storage.openModelFile(
          DEBUG_MODEL.modelId,
          DEBUG_MODEL.version,
        ),
      );
      this.loadMs = performance.now() - start;
      this.status = '模型就绪';
    });
  }
  private async switchMode(mode: 'suggest' | 'chat'): Promise<void> {
    if (mode === this.mode) return;
    await this.playground.reset();
    this.mode = mode;
    this.input = '';
  }
  private async run(): Promise<void> {
    if (!this.input.trim() || this.generating || this.busy || !this.ready)
      return;
    if (
      !Number.isFinite(this.temperature) ||
      this.temperature < 0 ||
      this.temperature > 2 ||
      !Number.isFinite(this.topP) ||
      this.topP < 0 ||
      this.topP > 1 ||
      !Number.isInteger(this.maxOutputTokens) ||
      this.maxOutputTokens < 1 ||
      this.maxOutputTokens > 1024 ||
      !Number.isInteger(+this.variables.num) ||
      +this.variables.num < 1 ||
      +this.variables.num > 20
    ) {
      this.error =
        '请检查参数：temperature 0–2、topP 0–1、输出 tokens 1–1024、数量 1–20。';
      return;
    }
    this.generating = true;
    this.error = '';
    try {
      await this.playground.run(
        this.mode,
        this.input,
        [this.wordId, this.sentenceId],
        {...this.variables},
        {
          temperature: this.temperature,
          topP: this.topP,
          maxOutputTokens: this.maxOutputTokens,
        },
      );
    } catch (error) {
      this.error = `${(error as Error).message}\n如果上下文已满，请新建对话；运行时错误可卸载后重新加载。`;
    } finally {
      this.generating = false;
    }
  }
  private selector(kind: string, value: string, set: (id: string) => void) {
    return html`<label
      >${kind === 'Word' ? '词模板' : '句模板'}<select
        .value=${value}
        @change=${(e: Event) => set((e.target as HTMLSelectElement).value)}
      >
        ${PROMPT_IDS.filter(id => id.startsWith(kind)).map(
          id =>
            html`<option value=${id} ?selected=${id === value}>${id}</option>`,
        )}
      </select></label
    >`;
  }
  render() {
    const disabled = this.busy || this.generating;
    const metric = (value: number | null | undefined, unit: string) =>
      value === null || value === undefined
        ? '不可用'
        : `${value.toFixed(1)} ${unit}`;
    return html` <header>
        <div>
          <h1>LiteRT-LM Playground</h1>
          <p class="muted">本地 WebGPU 推理 · Prompt 调试与对话</p>
        </div>
        <span class="badge">DEV ONLY · 0.15.0</span>
      </header>
      <div class="layout">
        <aside>
          <section>
            <h2>Gemma 4 E2B</h2>
            <p class="muted">Web · 2.01 GB · OPFS 缓存</p>
            <p>
              <a href=${MODEL_URL} target="_blank" rel="noreferrer"
                >固定版本模型来源 ↗</a
              >
            </p>
            <small>${this.capability}</small>
            <p role="status">${this.status}</p>
            <small>缓存：${this.cached ? '可用' : '无完整模型'}</small>
            ${this.downloadController
              ? html`<progress
                    max=${DEBUG_MODEL.sizeBytes}
                    value=${this.bytes}
                  ></progress
                  ><small
                    >${(this.bytes / 1e6).toFixed(0)} /
                    ${(DEBUG_MODEL.sizeBytes / 1e6).toFixed(0)} MB</small
                  >`
              : ''}
            <div class="actions">
              <button
                ?disabled=${disabled || this.cached}
                @click=${this.download}
              >
                下载 / 重试</button
              >${this.downloadController
                ? html`<button @click=${() => this.downloadController?.abort()}>
                    取消下载
                  </button>`
                : ''}<button
                ?disabled=${disabled || !this.cached || this.ready}
                @click=${this.load}
              >
                加载</button
              ><button
                ?disabled=${disabled}
                @click=${() =>
                  this.action(async () => {
                    await this.runtime.dispose();
                    this.status = '已卸载';
                  })}
              >
                卸载</button
              ><button
                ?disabled=${disabled}
                @click=${() =>
                  this.action(async () => {
                    await this.runtime.dispose();
                    await this.model.remove();
                    this.cached = false;
                    this.bytes = 0;
                    this.status = '缓存已删除';
                  })}
              >
                删除缓存
              </button>
            </div>
            ${this.loadMs !== undefined
              ? html`<p class="metrics">
                  加载及 smoke test：${metric(this.loadMs, 'ms')}
                </p>`
              : ''}
          </section>
          <section>
            <h2>设置</h2>
            <fieldset ?disabled=${disabled}>
              ${this.mode === 'suggest'
                ? html`${this.selector('Word', this.wordId, id => {
                    this.wordId = id;
                  })}${this.selector('Sentence', this.sentenceId, id => {
                    this.sentenceId = id;
                  })}
                  ${templateVariables([this.wordId, this.sentenceId]).map(
                    key =>
                      html`<label
                        >${labels[key] ?? key}${key === 'num'
                          ? html`<input
                              type="number"
                              min="1"
                              max="20"
                              .value=${this.variables[key]}
                              @input=${(e: Event) => {
                                this.variables = {
                                  ...this.variables,
                                  [key]: (e.target as HTMLInputElement).value,
                                };
                              }}
                            />`
                          : html`<textarea
                              rows="2"
                              .value=${this.variables[key] ?? ''}
                              @input=${(e: Event) => {
                                this.variables = {
                                  ...this.variables,
                                  [key]: (e.target as HTMLTextAreaElement)
                                    .value,
                                };
                              }}
                            ></textarea>`}</label
                      >`,
                  )}`
                : ''}
              <label
                >Temperature<input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  .value=${String(this.temperature)}
                  @input=${(e: Event) => {
                    this.temperature = (
                      e.target as HTMLInputElement
                    ).valueAsNumber;
                  }}
              /></label>
              <label
                >Top P<input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  .value=${String(this.topP)}
                  @input=${(e: Event) => {
                    this.topP = (e.target as HTMLInputElement).valueAsNumber;
                  }}
              /></label>
              <label
                >最大输出 tokens<input
                  type="number"
                  min="1"
                  max="1024"
                  .value=${String(this.maxOutputTokens)}
                  @input=${(e: Event) => {
                    this.maxOutputTokens = (
                      e.target as HTMLInputElement
                    ).valueAsNumber;
                  }}
              /></label>
            </fieldset>
          </section>
        </aside>
        <main>
          <section>
            <div class="tabs">
              <button
                class=${this.mode === 'suggest' ? 'selected' : ''}
                ?disabled=${this.busy}
                @click=${() => this.switchMode('suggest')}
              >
                联想 Playground</button
              ><button
                class=${this.mode === 'chat' ? 'selected' : ''}
                ?disabled=${this.busy}
                @click=${() => this.switchMode('chat')}
              >
                普通聊天
              </button>
            </div>
            <label
              >${this.mode === 'suggest' ? '输入字、词或句子' : '消息'}<textarea
                rows="4"
                placeholder=${this.mode === 'suggest'
                  ? '例如：周末 公园'
                  : '输入消息，开始对话'}
                .value=${this.input}
                ?disabled=${disabled}
                @input=${(e: Event) => {
                  this.input = (e.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
            </label>
            <div class="actions">
              <button
                class="primary"
                ?disabled=${disabled || !this.ready || !this.input.trim()}
                @click=${this.run}
              >
                ${this.generating
                  ? '生成中…'
                  : this.mode === 'suggest'
                    ? '生成词与句'
                    : '发送'}</button
              ><button
                ?disabled=${!this.generating}
                @click=${() => this.playground.stop()}
              >
                停止</button
              >${this.mode === 'chat'
                ? html`<button
                    ?disabled=${this.busy}
                    @click=${() => this.playground.reset()}
                  >
                    新建对话
                  </button>`
                : ''}
            </div>
          </section>
          ${this.error
            ? html`<p class="error" role="alert">${this.error}</p>`
            : ''}
          ${!this.playground.outputs.length
            ? html`<section class="muted">
                下载并加载模型后，提交输入查看结果。所有推理在当前浏览器中运行。
              </section>`
            : ''}
          ${this.playground.outputs.map(
            output =>
              html`<section>
                <h2>
                  ${output.label === 'chat'
                    ? '对话'
                    : output.label.startsWith('Word')
                      ? '联想词'
                      : '联想句'}
                </h2>
                ${output.label === 'chat'
                  ? html`<p class="muted">你：${output.prompt}</p>
                      <div class="raw">${output.raw}</div>`
                  : html`<div>
                        ${output.suggestions.map(
                          value => html`<span class="chip">${value}</span>`,
                        )}
                      </div>
                      ${!output.suggestions.length
                        ? html`<p class="muted">
                            ${output.raw
                              ? '未解析到编号联想，请查看原始输出。'
                              : '等待模型输出…'}
                          </p>`
                        : ''}`}
                ${output.interrupted
                  ? html`<p class="muted">已中止 · 本轮不加入聊天上下文</p>`
                  : ''}
                <details>
                  <summary>最终 prompt / 原始输出</summary>
                  <pre>${output.prompt}</pre>
                  <hr />
                  <pre>${output.raw}</pre>
                </details>
                ${output.metrics
                  ? html`<div class="metrics">
                      首 token ${metric(output.metrics.firstTokenMs, 'ms')} ·
                      总耗时 ${metric(output.metrics.totalMs, 'ms')} · Decode
                      ${metric(output.metrics.decodeTokensPerSecond, 'tok/s')} ·
                      Prefill
                      ${metric(output.metrics.prefillTokensPerSecond, 'tok/s')}
                    </div>`
                  : ''}
              </section>`,
          )}
        </main>
      </div>`;
  }
}
