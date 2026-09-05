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
import '@material/web/progress/linear-progress.js';

import {localized, msg, str} from '@lit/localize';
import {SignalWatcher} from '@lit-labs/signals';
import {css, html, LitElement} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';

import {
  downloadDiagnosticsReport,
  exportPrivacySafeDiagnostics,
} from './on-device/diagnostics-exporter.js';
import {PreflightCheckResult} from './on-device/model-capabilities.js';
import {DownloadProgress, ModelManager} from './on-device/model-manager.js';
import {ModelManifest} from './on-device/model-manifest.js';
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
  static override styles = css`
    :host {
      display: block;
    }
    .model-card {
      border: 1px solid var(--md-sys-color-outline-variant, #c4c7c5);
      border-radius: 12px;
      padding: 16px;
      color: var(--md-sys-color-on-surface, #1f1f1f);
    }
    .model-card-header,
    .progress-text,
    .model-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .model-card-header {
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .model-card-title {
      font-size: 1.1rem;
      font-weight: 600;
    }
    .model-badge {
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 0.8rem;
      font-weight: 600;
    }
    .badge-ready {
      background: #c4eed0;
      color: #0f5223;
    }
    .badge-active {
      background: #d3e3fd;
      color: #0842a0;
    }
    .badge-error {
      background: #f9dedc;
      color: #8c1d18;
    }
    .badge-neutral {
      background: #e3e3e3;
      color: #444746;
    }
    .model-meta-row,
    .diagnostics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 8px 16px;
    }
    .model-meta-row {
      font-size: 0.9rem;
    }
    .privacy-notice,
    .warning-notice,
    .error-notice {
      border-radius: 8px;
      margin: 12px 0;
      padding: 10px 12px;
    }
    .privacy-notice {
      background: var(--md-sys-color-surface-container, #f0f4f9);
    }
    .warning-notice {
      background: #fff3cd;
      color: #594500;
    }
    .error-notice {
      background: #f9dedc;
      color: #8c1d18;
    }
    .model-progress-container {
      margin: 12px 0;
    }
    .progress-text {
      justify-content: space-between;
      font-size: 0.85rem;
      margin-top: 4px;
    }
    .model-actions {
      margin-top: 12px;
    }
    .diagnostics-details {
      margin-top: 14px;
    }
    .diagnostics-details summary {
      cursor: pointer;
      font-weight: 600;
    }
    .diagnostics-grid {
      margin-top: 12px;
    }
    .diagnostics-item {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .diagnostics-label {
      color: var(--md-sys-color-on-surface-variant, #444746);
      font-size: 0.8rem;
    }
    .diagnostics-value {
      overflow-wrap: anywhere;
    }
    .diagnostics-note,
    .full-row {
      grid-column: 1 / -1;
    }
    .diagnostics-note {
      color: var(--md-sys-color-on-surface-variant, #444746);
      font-size: 0.8rem;
      margin: 0;
    }
  `;

  @property({type: Object})
  modelManager?: ModelManager;

  @property({type: Boolean})
  enableDebugModelImport = false;

  /** Rollout policy may pause new installs without disabling existing models. */
  @property({type: Boolean})
  allowModelInstallation = true;

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
  pendingUpdate: ModelManifest | null = null;

  @state()
  preflight: PreflightCheckResult | null = null;

  @state()
  pageAndWorkerMemoryBytes: number | null = null;

  @state()
  recentLatencyMs: number[] = [];

  private lastRecordedLatency: number | null = null;

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
    void this.refreshCapabilities();
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

  async refreshCapabilities(): Promise<void> {
    const manifest = this.modelManager?.getActiveManifest();
    if (!manifest || !this.modelManager) {
      this.preflight = null;
      return;
    }
    this.preflight = await this.modelManager.checkCapabilities(
      manifest.sizeBytes,
      manifest.adapterId,
      manifest.requirements,
    );
  }

  async refreshPageAndWorkerMemory(): Promise<void> {
    const performanceWithMemory = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{bytes: number}>;
    };
    try {
      this.pageAndWorkerMemoryBytes =
        (await performanceWithMemory.measureUserAgentSpecificMemory?.())
          ?.bytes ?? null;
    } catch {
      this.pageAndWorkerMemoryBytes = null;
    }
  }

  private recordRuntimeMetrics(): void {
    const totalMs = this.modelManager
      ?.getRuntimeAdapter()
      ?.getMetrics().totalMs;
    if (!totalMs || totalMs === this.lastRecordedLatency) return;
    this.lastRecordedLatency = totalMs;
    this.recentLatencyMs = [...this.recentLatencyMs.slice(-4), totalMs];
  }

  onDiagnosticsToggle(event: Event): void {
    const details = event.currentTarget as HTMLDetailsElement;
    if (this.diagnosticsTimer !== undefined) {
      window.clearInterval(this.diagnosticsTimer);
      this.diagnosticsTimer = undefined;
    }
    if (details.open) {
      void this.refreshStorageEstimate();
      void this.refreshCapabilities();
      void this.refreshPageAndWorkerMemory();
      this.recordRuntimeMetrics();
      this.diagnosticsTimer = window.setInterval(() => {
        void this.refreshStorageEstimate();
        void this.refreshCapabilities();
        void this.refreshPageAndWorkerMemory();
        this.recordRuntimeMetrics();
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
        this.pendingUpdate = update;
        this.updateCheckMessage = msg(
          str`New version available: ${update.version}`,
        );
      } else {
        this.pendingUpdate = null;
        this.updateCheckMessage = msg('Model is up to date.');
      }
    } catch {
      this.updateCheckMessage = msg('Could not check for updates.');
    } finally {
      this.isCheckingUpdates = false;
    }
  }

  async onUpdateClick(): Promise<void> {
    if (!this.pendingUpdate) return;
    this.actionError = null;
    try {
      await this.modelManager?.updateModel(this.pendingUpdate);
      this.pendingUpdate = null;
      this.updateCheckMessage = null;
    } catch (err) {
      this.actionError = (err as Error).message;
    }
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

  onRequestRemoveClick(event: Event): void {
    this.dispatchEvent(
      new CustomEvent('request-model-removal', {
        bubbles: true,
        composed: true,
        detail: {trigger: event.currentTarget as HTMLElement},
      }),
    );
  }

  triggerFileImport(): void {
    const input = this.renderRoot.querySelector(
      '#debug-model-file',
    ) as HTMLInputElement;
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
    const rollingLatency = this.recentLatencyMs.length
      ? this.recentLatencyMs.reduce((sum, value) => sum + value, 0) /
        this.recentLatencyMs.length
      : null;
    const canInstall =
      this.allowModelInstallation || this.activeVersionMetadata !== null;

    return html`
      <div class="model-card">
        <div class="model-card-header">
          <span class="model-card-title"
            >${manifest?.displayName || msg('Gemma On-device')}</span
          >
          <span
            class="model-badge ${getBadgeClass(state)}"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            ${formatLifecycleState(state)}
          </span>
        </div>

        <div class="model-meta-row">
          <span>${msg('Format')}: <b>${manifest?.format || unknown}</b></span>
          <span>${msg('Family')}: <b>${manifest?.family || unknown}</b></span>
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
            >${msg('WebGPU')}:
            <b
              >${this.preflight?.webgpuSupported
                ? msg('Available')
                : msg('Unavailable')}</b
            ></span
          >
          <span
            >${msg('Hardware adapter')}:
            <b
              >${this.preflight
                ? this.preflight.fallbackAdapter
                  ? msg('Fallback only')
                  : msg('Available')
                : unknown}</b
            ></span
          >
          <span
            >${msg('Storage')}:
            <b
              >${this.preflight
                ? this.preflight.quotaAvailableBytes >=
                  (manifest?.requirements.minimumFreeStorageBytes ?? 0)
                  ? msg('Available')
                  : msg('Insufficient')
                : unknown}</b
            ></span
          >
          <span
            >${msg('Device RAM')}:
            <b
              >${this.preflight?.deviceMemoryGB !== null &&
              this.preflight?.deviceMemoryGB !== undefined
                ? `${this.preflight.deviceMemoryGB} GB`
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
        ${!canInstall
          ? html`<div class="warning-notice" role="status">
              ${msg(
                'New local model installations are paused by rollout policy. Existing local models remain available.',
              )}
            </div>`
          : ''}
        ${this.preflight?.memoryWarning
          ? html`<div class="warning-notice" role="status">
              ${this.preflight.memoryWarning}
            </div>`
          : ''}
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
            ? html`<md-filled-button
                @click=${this.onDownloadClick}
                ?disabled=${!canInstall}
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
            ? html`<md-filled-button
                @click=${this.onUpdateClick}
                ?disabled=${!this.pendingUpdate || !canInstall}
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
            ? html`<md-text-button @click=${this.onRequestRemoveClick}
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
                <md-text-button
                  @click=${this.triggerFileImport}
                  ?disabled=${!canInstall}
                >
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
                >${this.pageAndWorkerMemoryBytes
                  ? formatBytes(this.pageAndWorkerMemoryBytes)
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
              <span class="diagnostics-label"
                >${msg('Recent Average Latency')}:</span
              >
              <span class="diagnostics-value"
                >${rollingLatency
                  ? `${rollingLatency.toFixed(0)} ms`
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
            <p class="diagnostics-note">
              ${msg(
                'Memory is measured for this page and its workers when supported; browser GPU allocations are not included.',
              )}
              ${msg(
                'Running local inference in multiple tabs at the same time is not supported.',
              )}
            </p>
            <div
              class="full-row"
              style="display: flex; justify-content: flex-end;"
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
}
