/**
 * Copyright 2026 Google LLC
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

import '@material/web/button/filled-button.js';
import '@material/web/button/text-button.js';
import '@material/web/dialog/dialog.js';
import '@material/web/progress/linear-progress.js';

import {localized, msg, str} from '@lit/localize';
import {SignalWatcher} from '@lit-labs/signals';
import {html, LitElement} from 'lit';
import {customElement, property, query, state} from 'lit/decorators.js';

import {
  downloadDiagnosticsReport,
  exportPrivacySafeDiagnostics,
} from './on-device/diagnostics-exporter.js';
import {DownloadProgress, ModelManager} from './on-device/model-manager.js';
import {ModelVersionRecord} from './on-device/model-metadata.js';
import {
  formatBytes,
  formatLifecycleState,
  formatSpeed,
  getActionableErrorMessage,
  getBadgeClass,
} from './on-device/ui-utils.js';

@localized()
@customElement('pv-on-device-model-card')
export class PvOnDeviceModelCard extends SignalWatcher(LitElement) {
  // Render in light DOM so containing dialogs and accessibility queries find
  // live regions, progress bars, and confirm dialogs directly.
  override createRenderRoot() {
    return this;
  }

  @property({type: Object})
  modelManager?: ModelManager;

  @property({type: Boolean})
  enableDebugModelImport = false;

  @state()
  downloadProgress: DownloadProgress | null = null;

  @state()
  storageEstimate: StorageEstimate | null = null;

  @state()
  activeVersionMetadata: ModelVersionRecord | null = null;

  @state()
  isCheckingUpdates = false;

  @state()
  updateCheckMessage: string | null = null;

  @state()
  actionError: string | null = null;

  @state()
  showRemoveConfirm = false;

  private removeTrigger: HTMLElement | null = null;

  @query('#remove-confirm-dialog')
  removeConfirmDialog?: HTMLDialogElement;

  private unsubscribeState?: () => void;
  private unsubscribeProgress?: () => void;
  private diagnosticsTimer?: number;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.modelManager) {
      this.bindModelManager(this.modelManager);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unbindModelManager();
    if (this.diagnosticsTimer !== undefined) {
      window.clearInterval(this.diagnosticsTimer);
      this.diagnosticsTimer = undefined;
    }
  }

  override updated(changedProperties: Map<string, unknown>): void {
    super.updated(changedProperties);
    if (changedProperties.has('modelManager')) {
      this.unbindModelManager();
      if (this.modelManager) {
        this.bindModelManager(this.modelManager);
      }
    }
  }

  private bindModelManager(mgr: ModelManager): void {
    this.unsubscribeState = mgr.onStateChange(() => {
      this.actionError = null;
      void this.refreshModelMetadata();
      this.requestUpdate();
    });
    this.unsubscribeProgress = mgr.onDownloadProgress(prog => {
      this.downloadProgress = prog;
      this.requestUpdate();
    });
    void this.refreshStorageEstimate();
    void this.refreshModelMetadata();
  }

  private unbindModelManager(): void {
    this.unsubscribeState?.();
    this.unsubscribeProgress?.();
    this.unsubscribeState = undefined;
    this.unsubscribeProgress = undefined;
  }

  async refreshModelMetadata(): Promise<void> {
    try {
      this.activeVersionMetadata =
        (await this.modelManager?.getActiveVersionMetadata()) ?? null;
    } catch {
      this.activeVersionMetadata = null;
    }
  }

  async refreshStorageEstimate(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        this.storageEstimate = await navigator.storage.estimate();
      } catch {
        // Storage estimate optional
      }
    }
  }

  onDiagnosticsToggle(event: Event): void {
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

  async onDownloadClick(): Promise<void> {
    this.actionError = null;
    try {
      await this.modelManager?.downloadModel();
    } catch (err) {
      this.actionError = (err as Error).message;
    }
  }

  onCancelDownloadClick(): void {
    this.modelManager?.pauseDownload();
  }

  async onLoadClick(): Promise<void> {
    this.actionError = null;
    try {
      await this.modelManager?.loadActiveModel();
    } catch (err) {
      this.actionError = (err as Error).message;
    }
  }

  async onUnloadClick(): Promise<void> {
    await this.modelManager?.unloadActiveModel();
  }

  async onRetryClick(): Promise<void> {
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

  async onCheckUpdateClick(): Promise<void> {
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

  onConfirmRemoveClick(event: Event | {currentTarget: HTMLElement}): void {
    this.removeTrigger = event.currentTarget as HTMLElement;
    this.showRemoveConfirm = true;
  }

  onRemoveDialogClosed(): void {
    this.showRemoveConfirm = false;
    this.removeTrigger?.focus();
    this.removeTrigger = null;
  }

  async onExportDiagnosticsClick(): Promise<void> {
    if (!this.modelManager) return;
    try {
      const report = await exportPrivacySafeDiagnostics(this.modelManager);
      downloadDiagnosticsReport(report);
    } catch (err) {
      console.error('Failed to export diagnostics:', err);
    }
  }

  async executeRemoveModel(): Promise<void> {
    this.showRemoveConfirm = false;
    const manifest = this.modelManager?.getActiveManifest();
    if (manifest) {
      await this.modelManager?.removeModel(manifest.modelId, manifest.version);
    }
  }

  triggerFileImport(): void {
    const input = this.querySelector('#debug-model-file') as HTMLInputElement;
    input?.click();
  }

  async onFileImportChange(e: Event): Promise<void> {
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

  override render() {
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
          <span class="model-badge ${getBadgeClass(state)}">
            ${formatLifecycleState(state)}
          </span>
        </div>

        <div class="model-meta-row">
          <span>${msg('Format')}: <b>${manifest?.format || unknown}</b></span>
          <span>${msg('Version')}: <b>${manifest?.version || unknown}</b></span>
          <span
            >${msg('Size')}:
            <b
              >${manifest?.sizeBytes
                ? formatBytes(manifest.sizeBytes)
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
                ${getActionableErrorMessage(err?.code)}
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
                    >${formatBytes(this.downloadProgress.bytesDownloaded)} /
                    ${formatBytes(this.downloadProgress.totalBytes)}
                    (${this.downloadProgress.percentage}%)</span
                  >
                  <span>${formatSpeed(this.downloadProgress.speedBps)}</span>
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
                  @click=${() => {
                    this.dispatchEvent(
                      new CustomEvent('switch-to-cloud', {
                        bubbles: true,
                        composed: true,
                      }),
                    );
                  }}
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
                  ? formatBytes(this.storageEstimate.quota)
                  : unknown}</span
              >
            </div>
            <div class="diagnostics-item">
              <span class="diagnostics-label"
                >${msg('OPFS Storage Used')}:</span
              >
              <span class="diagnostics-value"
                >${this.storageEstimate?.usage
                  ? formatBytes(this.storageEstimate.usage)
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
                  ? formatBytes(
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
                >${formatLifecycleState(state)}</span
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

      <md-dialog
        id="remove-confirm-dialog"
        role="alertdialog"
        aria-labelledby="remove-confirm-headline"
        aria-describedby="remove-confirm-content"
        .open=${this.showRemoveConfirm}
        @closed=${this.onRemoveDialogClosed}
      >
        <div slot="headline" id="remove-confirm-headline">
          ${msg('Remove Local Model?')}
        </div>
        <div slot="content" id="remove-confirm-content">
          ${msg(
            'This will delete the downloaded model weights from your device and free storage space. You can download it again at any time.',
          )}
        </div>
        <div slot="actions">
          <md-text-button @click=${this.onRemoveDialogClosed}
            >${msg('Cancel')}</md-text-button
          >
          <md-filled-button @click=${this.executeRemoveModel}
            >${msg('Remove Model')}</md-filled-button
          >
        </div>
      </md-dialog>
    `;
  }
}
