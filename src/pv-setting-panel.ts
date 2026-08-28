/**
 * Copyright 2024 Google LLC
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

import '@material/web/checkbox/checkbox.js';
import '@material/web/select/select-option.js';
import '@material/web/button/filled-button.js';
import '@material/web/button/text-button.js';
import '@material/web/switch/switch.js';
import '@material/web/tabs/primary-tab.js';
import '@material/web/tabs/tabs.js';
import '@material/web/textfield/filled-text-field.js';
import '@material/web/select/outlined-select.js';
import '@material/web/dialog/dialog.js';
import '@material/web/slider/slider.js';
import '@material/web/progress/linear-progress.js';

import {localized, msg, str} from '@lit/localize';
import {SignalWatcher} from '@lit-labs/signals';
import {MdTabs} from '@material/web/tabs/tabs.js';
import {css, html, LitElement} from 'lit';
import {customElement, property, query, state} from 'lit/decorators.js';

import {LANGUAGES} from './language.js';
import {
  downloadDiagnosticsReport,
  exportPrivacySafeDiagnostics,
} from './on-device/diagnostics-exporter.js';
import {
  DownloadProgress,
  ModelErrorCode,
  ModelLifecycleState,
  ModelManager,
} from './on-device/model-manager.js';
import {ModelVersionRecord} from './on-device/model-metadata.js';
import {State} from './state.js';

const EVENT_KEY = {
  okClick: 'ok-click',
} as const;

type EventKey = (typeof EVENT_KEY)[keyof typeof EVENT_KEY];

@localized()
@customElement('pv-setting-panel')
export class PvSettingPanel extends SignalWatcher(LitElement) {
  @property({type: Object})
  state!: State;

  @property({type: Object})
  modelManager?: ModelManager;

  /** Enables the development-only local model import control. */
  @property({type: Boolean})
  enableDebugModelImport = false;

  @state()
  private activeSettingsTabIndex = 0;

  @state()
  private downloadProgress: DownloadProgress | null = null;

  @state()
  private storageEstimate: StorageEstimate | null = null;

  @state()
  private activeVersionMetadata: ModelVersionRecord | null = null;

  @state()
  private isCheckingUpdates = false;

  @state()
  private updateCheckMessage: string | null = null;

  @state()
  private actionError: string | null = null;

  @state()
  private showRemoveConfirm = false;

  private removeTrigger: HTMLElement | null = null;

  @query('md-dialog#settings-dialog')
  private settingsDialog?: HTMLDialogElement;

  @query('md-dialog#remove-confirm-dialog')
  private removeConfirmDialog?: HTMLDialogElement;

  private unsubscribeState?: () => void;
  private unsubscribeProgress?: () => void;
  private diagnosticsTimer?: number;

  static styles = css`
    :host {
      background: var(--color-background);
      display: flex;

      --md-icon-button-icon-size: 3rem;
      --md-icon-button-state-layer-width: 4rem;
      --md-icon-button-state-layer-height: 4rem;

      --mdc-typography-body2-font-size: 3rem;
      --mdc-typography-body2-line-height: 3.5rem;
    }

    #form-id {
      max-height: 520px;
      width: 520px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .voice-config-slider {
      display: inline-block;
      width: 350px;
    }

    .form-section {
      margin: 1rem 0;
    }

    .form-section-columns {
      display: flex;
    }

    .form-section-column {
      flex: 1;
    }

    .language-select {
      border: 1px solid var(--md-sys-color-outline, #79747e);
      border-radius: var(--md-sys-shape-corner-extra-small, 4px);
      display: inline-flex;
      height: 5rem;
      overflow-x: hidden;
      overflow-y: scroll;
    }

    .language-option {
      border-color: black;
      display: flex;
      margin: 0.75rem 8px;
    }

    .language-option-label {
      flex: 1;
    }

    .language-option-checkbox {
      flex: 0;
      margin: 0 0 0 0.75rem;
    }

    .pv-persona-text-field,
    .pv-initial-phrase-text-field {
      width: 100%;
    }

    /* On-device Model Card Styles */
    .model-card {
      border: 1px solid var(--md-sys-color-outline-variant, #cac4d0);
      border-radius: 12px;
      padding: 14px 16px;
      margin: 10px 0;
      background: var(--md-sys-color-surface-container-low, #f7f2fa);
    }

    .model-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .model-card-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #1d1b20);
    }

    .model-badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .badge-ready {
      background: #e6f4ea;
      color: #137333;
    }

    .badge-active {
      background: #e8f0fe;
      color: #1a73e8;
    }

    .badge-error {
      background: #fce8e6;
      color: #c5221f;
    }

    .badge-neutral {
      background: #f1f3f4;
      color: #5f6368;
    }

    .model-meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 0.8rem;
      color: var(--md-sys-color-on-surface-variant, #49454f);
      margin-bottom: 8px;
    }

    .privacy-notice {
      background: #e6f4ea;
      color: #0d652d;
      border-left: 4px solid #1e8e3e;
      padding: 6px 10px;
      font-size: 0.8rem;
      border-radius: 4px;
      margin: 8px 0;
    }

    .error-notice {
      background: #fce8e6;
      color: #c5221f;
      border-left: 4px solid #d93025;
      padding: 6px 10px;
      font-size: 0.8rem;
      border-radius: 4px;
      margin: 8px 0;
    }

    .model-progress-container {
      margin: 8px 0;
    }

    .progress-text {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      margin-top: 4px;
      color: var(--md-sys-color-on-surface-variant, #49454f);
    }

    .model-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
      align-items: center;
    }

    .diagnostics-details {
      margin-top: 12px;
      font-size: 0.8rem;
      border-top: 1px solid var(--md-sys-color-outline-variant, #cac4d0);
      padding-top: 8px;
    }

    .diagnostics-details summary {
      cursor: pointer;
      font-weight: 500;
      color: var(--md-sys-color-primary, #0b57d0);
    }

    .diagnostics-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 12px;
      padding: 8px 0;
    }

    .diagnostics-item {
      display: flex;
      justify-content: space-between;
    }

    .diagnostics-label {
      color: var(--md-sys-color-on-surface-variant, #5f6368);
    }

    .diagnostics-value {
      font-family: monospace;
      font-weight: 500;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.modelManager) {
      this.unsubscribeState = this.modelManager.onStateChange(() => {
        this.actionError = null;
        void this.refreshModelMetadata();
        this.requestUpdate();
      });
      this.unsubscribeProgress = this.modelManager.onDownloadProgress(prog => {
        this.downloadProgress = prog;
        this.requestUpdate();
      });
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeState?.();
    this.unsubscribeProgress?.();
    if (this.diagnosticsTimer !== undefined) {
      window.clearInterval(this.diagnosticsTimer);
    }
  }

  show(): void {
    void this.refreshStorageEstimate();
    void this.refreshModelMetadata();
    this.settingsDialog?.show();
  }

  private async refreshModelMetadata(): Promise<void> {
    try {
      this.activeVersionMetadata =
        (await this.modelManager?.getActiveVersionMetadata()) ?? null;
    } catch {
      this.activeVersionMetadata = null;
    }
  }

  private async refreshStorageEstimate(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        this.storageEstimate = await navigator.storage.estimate();
      } catch {
        // Storage estimate optional
      }
    }
  }

  private onDiagnosticsToggle(event: Event): void {
    const details = event.currentTarget as HTMLDetailsElement;
    if (this.diagnosticsTimer !== undefined) {
      window.clearInterval(this.diagnosticsTimer);
      this.diagnosticsTimer = undefined;
    }
    if (details.open) {
      this.diagnosticsTimer = window.setInterval(() => {
        this.requestUpdate();
      }, 2000);
    }
  }

  private fireEvent(key: EventKey): void {
    this.dispatchEvent(
      new CustomEvent(key, {
        detail: {callee: this},
        bubbles: true,
        composed: true,
      }),
    );
  }

  private formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 2 : 0)} ${units[i]}`;
  }

  private formatSpeed(bps: number): string {
    if (!bps || bps <= 0) return '0 MB/s';
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  }

  private formatLifecycleState(state: ModelLifecycleState): string {
    switch (state) {
      case 'unsupported':
        return msg('Hardware Unsupported');
      case 'not_downloaded':
        return msg('Download Required');
      case 'downloading':
        return msg('Downloading...');
      case 'verifying':
        return msg('Verifying Checksum...');
      case 'downloaded':
        return msg('Ready to Load');
      case 'loading':
        return msg('Loading into WebGPU...');
      case 'ready':
        return msg('Ready (Active)');
      case 'generating':
        return msg('Generating...');
      case 'update_available':
        return msg('Update Available');
      case 'error':
        return msg('Error');
      default:
        return state;
    }
  }

  private getBadgeClass(state: ModelLifecycleState): string {
    switch (state) {
      case 'ready':
      case 'generating':
        return 'badge-ready';
      case 'downloading':
      case 'verifying':
      case 'loading':
      case 'update_available':
        return 'badge-active';
      case 'error':
      case 'unsupported':
        return 'badge-error';
      default:
        return 'badge-neutral';
    }
  }

  private getActionableErrorMessage(code?: ModelErrorCode): string {
    switch (code) {
      case 'ERR_WEBGPU_UNSUPPORTED':
        return msg(
          'WebGPU is not supported or device was lost on this system.',
        );
      case 'ERR_ADAPTER_UNSUPPORTED':
        return msg(
          'This model format is not compatible with the installed runtime.',
        );
      case 'ERR_STORAGE_UNSUPPORTED':
        return msg(
          'Persistent browser storage is unavailable. Check site permissions.',
        );
      case 'ERR_INSUFFICIENT_STORAGE':
        return msg(
          'Insufficient storage space to download model. Please free up disk space.',
        );
      case 'ERR_PERSISTENCE_DENIED':
        return msg(
          'Persistent storage was denied. Free space or update site permissions, then retry.',
        );
      case 'ERR_DOWNLOAD_FAILED':
        return msg(
          'Failed to download model artifact. Check your network connection.',
        );
      case 'ERR_URL_EXPIRED':
        return msg('The download link expired. Retry to request a new link.');
      case 'ERR_RANGE_NOT_SATISFIABLE':
        return msg(
          'The partial download cannot be resumed safely. Retry the download.',
        );
      case 'ERR_GENERATION_MISMATCH':
        return msg('The downloaded model version changed. Check for updates.');
      case 'ERR_CHECKSUM_MISMATCH':
        return msg(
          'Model integrity check failed. The downloaded file may be corrupted.',
        );
      case 'ERR_LOAD_FAILED':
        return msg('Failed to load model into WebGPU runtime.');
      case 'ERR_SMOKE_TEST_FAILED':
        return msg(
          'Activation smoke test failed. Model output could not be verified.',
        );
      case 'ERR_TAB_LOCKED':
        return msg(
          'Model is currently in use or downloading in another browser tab.',
        );
      default:
        return msg('An error occurred with on-device inference.');
    }
  }

  private async onDownloadClick(): Promise<void> {
    this.actionError = null;
    try {
      await this.modelManager?.downloadModel();
    } catch (err) {
      this.actionError = (err as Error).message;
    }
  }

  private onCancelDownloadClick(): void {
    this.modelManager?.pauseDownload();
  }

  private async onLoadClick(): Promise<void> {
    this.actionError = null;
    try {
      await this.modelManager?.loadActiveModel();
    } catch (err) {
      this.actionError = (err as Error).message;
    }
  }

  private async onUnloadClick(): Promise<void> {
    await this.modelManager?.unloadActiveModel();
  }

  private async onRetryClick(): Promise<void> {
    this.actionError = null;
    try {
      await this.modelManager?.initialize();
      if (this.modelManager?.getState() === 'downloaded') {
        await this.modelManager.loadActiveModel();
      }
    } catch (err) {
      this.actionError = (err as Error).message;
    }
  }

  private async onCheckUpdateClick(): Promise<void> {
    this.isCheckingUpdates = true;
    this.updateCheckMessage = null;
    try {
      const update = await this.modelManager?.checkForUpdate();
      if (update) {
        this.updateCheckMessage = msg(
          str`New version available: ${update.version}`,
        );
      } else {
        this.updateCheckMessage = msg('Model is up to date.');
      }
    } catch {
      this.updateCheckMessage = msg('Could not check for updates.');
    } finally {
      this.isCheckingUpdates = false;
    }
  }

  private onConfirmRemoveClick(event: Event): void {
    this.removeTrigger = event.currentTarget as HTMLElement;
    this.showRemoveConfirm = true;
  }

  private onRemoveDialogClosed(): void {
    this.showRemoveConfirm = false;
    this.removeTrigger?.focus();
    this.removeTrigger = null;
  }

  private async onExportDiagnosticsClick(): Promise<void> {
    if (!this.modelManager) return;
    try {
      const report = await exportPrivacySafeDiagnostics(this.modelManager);
      downloadDiagnosticsReport(report);
    } catch (err) {
      console.error('Failed to export diagnostics:', err);
    }
  }

  private async onInferenceModeChange(mode: 'cloud' | 'local'): Promise<void> {
    // Persist first so Cloud requests stop immediately, even if local startup
    // subsequently reports that a model must be downloaded or reloaded.
    this.state.inferenceMode = mode;
    this.actionError = null;
    if (mode === 'local') {
      try {
        await this.modelManager?.startup(true);
      } catch (error) {
        this.actionError = (error as Error).message;
      }
    }
  }

  private async executeRemoveModel(): Promise<void> {
    this.showRemoveConfirm = false;
    const manifest = this.modelManager?.getActiveManifest();
    if (manifest) {
      await this.modelManager?.removeModel(manifest.modelId, manifest.version);
    }
  }

  private triggerFileImport(): void {
    const input = this.renderRoot.querySelector(
      '#debug-model-file',
    ) as HTMLInputElement;
    input?.click();
  }

  private async onFileImportChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.actionError = null;
    try {
      await this.modelManager?.importLocalModel(file);
    } catch (err) {
      this.actionError = (err as Error).message;
    } finally {
      input.value = '';
    }
  }

  private renderModelCard() {
    const mgr = this.modelManager;
    const state = mgr?.getState() ?? 'not_downloaded';
    const manifest = mgr?.getActiveManifest();
    const err = mgr?.getError();
    const metrics = mgr?.getRuntimeAdapter()?.getMetrics();
    const unknown = msg('Unknown');

    return html`
      <div class="model-card">
        <div class="model-card-header">
          <span class="model-card-title"
            >${manifest?.displayName || msg('Gemma On-device')}</span
          >
          <span class="model-badge ${this.getBadgeClass(state)}">
            ${this.formatLifecycleState(state)}
          </span>
        </div>

        <div class="model-meta-row">
          <span>${msg('Format')}: <b>${manifest?.format || unknown}</b></span>
          <span>${msg('Version')}: <b>${manifest?.version || unknown}</b></span>
          <span
            >${msg('Size')}:
            <b
              >${manifest?.sizeBytes
                ? this.formatBytes(manifest.sizeBytes)
                : unknown}</b
            ></span
          >
          <span
            >${msg('Compatibility')}:
            <b
              >${manifest &&
              manifest.adapterId === mgr?.getRuntimeAdapter()?.adapterId
                ? msg('Compatible')
                : unknown}</b
            ></span
          >
          <span
            >${msg('Verification')}:
            <b
              >${this.activeVersionMetadata?.importStatus ===
              'unverified_import'
                ? msg('Unverified import')
                : this.activeVersionMetadata?.verificationState === 'verified'
                  ? msg('Checksum verified')
                  : unknown}</b
            ></span
          >
        </div>

        <div class="privacy-notice" role="status" aria-live="polite">
          ${msg(
            'When On-device is selected, suggestion text is not sent to Gemini.',
          )}
        </div>

        ${err || this.actionError
          ? html`
              <div class="error-notice" role="alert" aria-live="assertive">
                ${this.getActionableErrorMessage(err?.code)}
                ${this.actionError ? html`<div>${this.actionError}</div>` : ''}
              </div>
            `
          : ''}
        ${state === 'downloading' && this.downloadProgress
          ? html`
              <div
                class="model-progress-container"
                role="progressbar"
                aria-valuenow="${this.downloadProgress.percentage}"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-label="${msg('Model download progress')}"
              >
                <md-linear-progress
                  value="${this.downloadProgress.percentage / 100}"
                  aria-label="${msg('Model download progress')}"
                ></md-linear-progress>
                <div class="progress-text" role="status" aria-live="polite">
                  <span
                    >${this.formatBytes(this.downloadProgress.bytesDownloaded)}
                    / ${this.formatBytes(this.downloadProgress.totalBytes)}
                    (${this.downloadProgress.percentage}%)</span
                  >
                  <span
                    >${this.formatSpeed(this.downloadProgress.speedBps)}</span
                  >
                </div>
              </div>
            `
          : ''}
        ${this.updateCheckMessage
          ? html`<div
              class="progress-text"
              role="status"
              aria-live="polite"
              style="color: var(--md-sys-color-primary, #0b57d0)"
            >
              ${this.updateCheckMessage}
            </div>`
          : ''}

        <div class="model-actions">
          ${state === 'not_downloaded'
            ? html`<md-filled-button @click=${this.onDownloadClick}
                >${this.downloadProgress?.bytesDownloaded
                  ? msg('Resume Download')
                  : msg('Download')}</md-filled-button
              >`
            : ''}
          ${state === 'downloading'
            ? html`<md-text-button @click=${this.onCancelDownloadClick}
                >${msg('Cancel Download')}</md-text-button
              >`
            : ''}
          ${state === 'downloaded'
            ? html`<md-filled-button @click=${this.onLoadClick}
                >${msg('Load Model')}</md-filled-button
              >`
            : ''}
          ${state === 'ready'
            ? html`<md-text-button @click=${this.onUnloadClick}
                >${msg('Unload')}</md-text-button
              >`
            : ''}
          ${state === 'update_available'
            ? html`<md-filled-button @click=${this.onDownloadClick}
                >${msg('Update')}</md-filled-button
              >`
            : ''}
          ${state === 'error'
            ? html`
                <md-filled-button @click=${this.onRetryClick}
                  >${msg('Retry')}</md-filled-button
                >
                <md-text-button
                  @click=${() => void this.onInferenceModeChange('cloud')}
                  >${msg('Switch to Cloud')}</md-text-button
                >
              `
            : ''}
          ${state === 'downloaded' ||
          state === 'ready' ||
          state === 'update_available'
            ? html`<md-text-button @click=${this.onConfirmRemoveClick}
                >${msg('Remove')}</md-text-button
              >`
            : ''}
          <md-text-button
            @click=${this.onCheckUpdateClick}
            ?disabled=${this.isCheckingUpdates}
          >
            ${this.isCheckingUpdates
              ? msg('Checking...')
              : msg('Check for Updates')}
          </md-text-button>
          ${this.enableDebugModelImport
            ? html`
                <md-text-button @click=${this.triggerFileImport}>
                  ${msg('Import Local Model')}
                </md-text-button>
                <input
                  type="file"
                  id="debug-model-file"
                  accept=".litertlm"
                  style="display: none"
                  @change=${this.onFileImportChange}
                />
              `
            : ''}
        </div>

        <details
          class="diagnostics-details"
          @toggle=${this.onDiagnosticsToggle}
        >
          <summary>${msg('Resource & Diagnostics')}</summary>
          <div class="diagnostics-grid">
            <div class="diagnostics-item">
              <span class="diagnostics-label">${msg('Logical CPUs')}:</span>
              <span class="diagnostics-value"
                >${navigator.hardwareConcurrency || unknown}</span
              >
            </div>
            <div class="diagnostics-item">
              <span class="diagnostics-label"
                >${msg('Approx Device RAM')}:</span
              >
              <span class="diagnostics-value"
                >${(navigator as unknown as {deviceMemory?: number})
                  .deviceMemory
                  ? `${(navigator as unknown as {deviceMemory?: number}).deviceMemory} GB`
                  : unknown}</span
              >
            </div>
            <div class="diagnostics-item">
              <span class="diagnostics-label"
                >${msg('OPFS Storage Quota')}:</span
              >
              <span class="diagnostics-value"
                >${this.storageEstimate?.quota
                  ? this.formatBytes(this.storageEstimate.quota)
                  : unknown}</span
              >
            </div>
            <div class="diagnostics-item">
              <span class="diagnostics-label"
                >${msg('OPFS Storage Used')}:</span
              >
              <span class="diagnostics-value"
                >${this.storageEstimate?.usage
                  ? this.formatBytes(this.storageEstimate.usage)
                  : unknown}</span
              >
            </div>
            <div class="diagnostics-item">
              <span class="diagnostics-label">${msg('Runtime Backend')}:</span>
              <span class="diagnostics-value">WebGPU</span>
            </div>
            <div class="diagnostics-item">
              <span class="diagnostics-label">${msg('Page Memory')}:</span>
              <span class="diagnostics-value"
                >${(
                  performance as unknown as {
                    memory?: {usedJSHeapSize: number};
                  }
                ).memory?.usedJSHeapSize
                  ? this.formatBytes(
                      (
                        performance as unknown as {
                          memory: {usedJSHeapSize: number};
                        }
                      ).memory.usedJSHeapSize,
                    )
                  : msg('Unavailable')}</span
              >
            </div>
            <div class="diagnostics-item">
              <span class="diagnostics-label">${msg('Model State')}:</span>
              <span class="diagnostics-value"
                >${this.formatLifecycleState(state)}</span
              >
            </div>
            <div class="diagnostics-item">
              <span class="diagnostics-label">${msg('Model Activity')}:</span>
              <span class="diagnostics-value"
                >${metrics?.dutyCyclePercent !== undefined
                  ? `${metrics.dutyCyclePercent.toFixed(1)}%`
                  : msg('Unavailable')}</span
              >
            </div>
            <div class="diagnostics-item">
              <span class="diagnostics-label">${msg('Last Latency')}:</span>
              <span class="diagnostics-value"
                >${metrics?.totalMs
                  ? `${metrics.totalMs.toFixed(0)} ms`
                  : msg('N/A')}</span
              >
            </div>
            <div class="diagnostics-item">
              <span class="diagnostics-label">${msg('Throughput')}:</span>
              <span class="diagnostics-value"
                >${metrics?.tokensPerSecond
                  ? `${metrics.tokensPerSecond.toFixed(1)} tok/s`
                  : msg('N/A')}</span
              >
            </div>
            <div
              style="margin-top: 12px; display: flex; justify-content: flex-end;"
            >
              <md-text-button
                @click=${this.onExportDiagnosticsClick}
                aria-label="${msg('Export privacy-safe diagnostics report')}"
              >
                ${msg('Export Diagnostics (JSON)')}
              </md-text-button>
            </div>
          </div>
        </details>
      </div>
    `;
  }

  render() {
    const profileSettingsPanelTemplate = html`
      <div class="form-section">
        <label>
          ${msg('Persona')}
          <p>
            <md-filled-text-field
              class="pv-persona-text-field"
              type="textarea"
              rows="5"
              @input=${(e: Event) => {
                this.state.persona = (e.target as HTMLTextAreaElement).value;
              }}
              value="${this.state.persona}"
            >
            </md-filled-text-field>
          </p>
        </label>
      </div>
      <div class="form-section">
        <label>
          ${msg('Initial phrases (separated by new line)')}
          <p>
            <md-filled-text-field
              class="pv-initial-phrase-text-field"
              type="textarea"
              rows="5"
              value="${this.state.initialPhrases.join('\n')}"
              @input=${(e: Event) => {
                this.state.initialPhrases = (
                  e.target as HTMLTextAreaElement
                ).value
                  .split('\n')
                  .filter(str => str);
              }}
            >
            </md-filled-text-field>
          </p>
        </label>
      </div>
    `;

    const generalSettingsPanelTemplate = html`
      <div class="form-section">
        <md-outlined-select
          label="${msg('Inference Source')}"
          @change=${(e: Event) => {
            const selected = e.composedPath()[0] as HTMLSelectElement;
            void this.onInferenceModeChange(
              selected.value as 'cloud' | 'local',
            );
          }}
        >
          <md-select-option
            ?selected="${this.state.inferenceMode === 'cloud'}"
            value="cloud"
          >
            <div slot="headline">${msg('Cloud (Gemini)')}</div>
          </md-select-option>
          <md-select-option
            ?selected="${this.state.inferenceMode === 'local'}"
            value="local"
          >
            <div slot="headline">${msg('On-device')}</div>
          </md-select-option>
        </md-outlined-select>
      </div>

      ${this.state.inferenceMode === 'cloud'
        ? html`
            <div class="form-section">
              <md-outlined-select
                label="${msg('Cloud AI Model')}"
                @change=${(e: Event) => {
                  const selected = e.composedPath()[0] as HTMLSelectElement;
                  this.state.aiConfig = selected.value;
                }}
              >
                <md-select-option
                  ?selected="${this.state.aiConfig === 'gemini_3_1_flash_lite'}"
                  value="gemini_3_1_flash_lite"
                >
                  <div slot="headline">Gemini 3.1 Flash Lite</div>
                </md-select-option>
                <md-select-option
                  ?selected="${this.state.aiConfig === 'gemini_3_flash'}"
                  value="gemini_3_flash"
                >
                  <div slot="headline">Gemini 3 Flash Preview</div>
                </md-select-option>
              </md-outlined-select>
            </div>
          `
        : this.renderModelCard()}

      <div class="form-section-columns">
        <div class="form-section-column">
          <div class="form-section">
            <label>
              ${msg('Always expand at origin')}
              <md-switch
                ?selected=${this.state.expandAtOrigin}
                @change=${() => {
                  this.state.expandAtOrigin = !this.state.expandAtOrigin;
                }}
              ></md-switch>
            </label>
          </div>
          <div class="form-section">
            <label>
              ${msg('Use smaller sentence margin')}
              <md-switch
                ?selected=${this.state.sentenceSmallMargin}
                @change=${() => {
                  this.state.sentenceSmallMargin =
                    !this.state.sentenceSmallMargin;
                }}
              ></md-switch>
            </label>
          </div>
          <div class="form-section">
            <label>
              ${msg('Enable earcons')}
              <md-switch
                ?selected=${this.state.enableEarcons}
                @change=${() => {
                  this.state.enableEarcons = !this.state.enableEarcons;
                }}
              ></md-switch>
            </label>
          </div>
        </div>
        <div class="form-section-column"></div>
      </div>

      <div class="form-section">
        <div>
          <label>${msg('Language')}</label>
        </div>
        <div class="language-select">
          <div>
            ${Object.entries(LANGUAGES).map(
              ([label, lang]) =>
                html`<div class="language-option">
                  <div class="language-option-label">
                    <label>${lang.render()}</label>
                  </div>
                  <div class="language-option-checkbox">
                    <md-checkbox
                      ?checked="${this.state.checkedLanguages.includes(label)}"
                      ?disabled="${this.state.checkedLanguages.length === 1 &&
                      this.state.checkedLanguages.includes(label)}"
                      @change=${() => {
                        if (this.state.checkedLanguages.includes(label)) {
                          this.state.checkedLanguages =
                            this.state.checkedLanguages.filter(
                              l => l !== label,
                            );
                        } else {
                          this.state.checkedLanguages = [
                            ...this.state.checkedLanguages,
                            label,
                          ];
                        }
                      }}
                    ></md-checkbox>
                  </div>
                </div>`,
            )}
          </div>
        </div>
      </div>
    `;

    const ttsSettingsPanelTemplate = html`
      <div class="form-section">
        <md-outlined-select
          label="${msg('TTS Voice')}"
          @change=${(e: Event) => {
            const selected = e.target;
            this.state.voiceName = (selected as HTMLSelectElement).value;
            this.requestUpdate();
          }}
        >
          <md-select-option
            value="Default"
            ?selected="${this.state.voiceName === ''}"
          >
            <div slot="headline">Default</div>
          </md-select-option>
          ${typeof window !== 'undefined' && window.speechSynthesis
            ? window.speechSynthesis
                .getVoices()
                .filter(voice => voice.lang.startsWith(this.state.lang.code))
                .map(
                  voice =>
                    html`<md-select-option
                      value="${voice.name}"
                      ?selected="${this.state.voiceName === voice.name}"
                    >
                      <div slot="headline">${voice.name}</div>
                    </md-select-option>`,
                )
            : ''}
        </md-outlined-select>
      </div>

      <div class="form-section">
        <label>
          ${msg('Speaking rate')}
          <md-slider
            class="voice-config-slider"
            min="-10"
            max="10"
            value="${this.state.voiceSpeakingRate}"
            @change=${(e: Event) => {
              this.state.voiceSpeakingRate = Number(
                (e.target as HTMLInputElement).value,
              );
            }}
          >
          </md-slider>
        </label>
      </div>
      <div class="form-section">
        <label>
          ${msg('Pitch')}
          <md-slider
            class="voice-config-slider"
            min="-10"
            max="10"
            value="${this.state.voicePitch}"
            @change=${(e: Event) => {
              this.state.voicePitch = Number(
                (e.target as HTMLInputElement).value,
              );
            }}
          >
          </md-slider>
        </label>
      </div>
    `;

    const tabs = [
      {
        label: msg('General'),
        template: generalSettingsPanelTemplate,
      },
      {
        label: msg('Profile'),
        template: profileSettingsPanelTemplate,
      },
      {
        label: msg('VOICE'),
        template: ttsSettingsPanelTemplate,
      },
    ];

    return html`
      <md-dialog id="settings-dialog">
        <form slot="content" id="form-id" method="dialog">
          <md-tabs
            @change="${(e: Event) => {
              if (e.target instanceof MdTabs) {
                this.activeSettingsTabIndex = e.target.activeTabIndex;
              }
            }}"
          >
            ${tabs.map(
              (tab, index) => html`
                <md-primary-tab
                  ?active="${this.activeSettingsTabIndex === index}"
                >
                  ${tab.label}
                </md-primary-tab>
              `,
            )}
          </md-tabs>
          ${tabs[this.activeSettingsTabIndex]?.template}
        </form>
        <div slot="actions">
          <md-text-button
            form="form-id"
            @click="${() => {
              this.settingsDialog?.close();
              this.fireEvent(EVENT_KEY.okClick);
            }}"
            >OK</md-text-button
          >
        </div>
      </md-dialog>

      <md-dialog
        id="remove-confirm-dialog"
        ?open=${this.showRemoveConfirm}
        @closed=${this.onRemoveDialogClosed}
        role="alertdialog"
        aria-labelledby="remove-confirm-headline"
        aria-describedby="remove-confirm-content"
      >
        <div slot="headline" id="remove-confirm-headline">
          ${msg('Remove Local Model?')}
        </div>
        <div slot="content" id="remove-confirm-content">
          ${msg(
            'This will delete the model weights from local storage (~2 GB). You will need to download the model again to use on-device suggestions.',
          )}
        </div>
        <div slot="actions">
          <md-text-button @click=${() => (this.showRemoveConfirm = false)}>
            ${msg('Cancel')}
          </md-text-button>
          <md-filled-button @click=${this.executeRemoveModel}>
            ${msg('Remove')}
          </md-filled-button>
        </div>
      </md-dialog>
    `;
  }
}
