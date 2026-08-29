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

import {msg} from '@lit/localize';
import {html, TemplateResult} from 'lit';

import {
  DownloadProgress,
  ModelLifecycleState,
  ModelManager,
} from './model-manager.js';
import {ModelVersionRecord} from './model-metadata.js';
import {
  formatBytes,
  formatLifecycleState,
  formatSpeed,
  getActionableErrorMessage,
  getBadgeClass,
} from './ui-utils.js';

export interface ModelCardHost {
  modelManager?: ModelManager;
  enableDebugModelImport: boolean;
  downloadProgress: DownloadProgress | null;
  storageEstimate: StorageEstimate | null;
  activeVersionMetadata: ModelVersionRecord | null;
  isCheckingUpdates: boolean;
  updateCheckMessage: string | null;
  actionError: string | null;
  showRemoveConfirm: boolean;
  onDiagnosticsToggle(e: Event): void;
  onDownloadClick(): Promise<void>;
  onCancelDownloadClick(): void;
  onLoadClick(): Promise<void>;
  onUnloadClick(): Promise<void>;
  onRetryClick(): Promise<void>;
  onCheckUpdateClick(): Promise<void>;
  onConfirmRemoveClick(e: Event | {currentTarget: HTMLElement}): void;
  onRemoveDialogClosed(): void;
  onExportDiagnosticsClick(): Promise<void>;
  executeRemoveModel(): Promise<void>;
  triggerFileImport(): void;
  onFileImportChange(e: Event): Promise<void>;
  onInferenceModeChange?(mode: 'cloud' | 'local'): Promise<void>;
}

export function renderModelCardTemplate(host: ModelCardHost): TemplateResult {
  const mgr = host.modelManager;
  const state: ModelLifecycleState = mgr?.getState() ?? 'not_downloaded';
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
            >${host.activeVersionMetadata?.importStatus === 'unverified_import'
              ? msg('Unverified import')
              : host.activeVersionMetadata?.verificationState === 'verified'
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

      ${err || host.actionError
        ? html`
            <div class="error-notice" role="alert" aria-live="assertive">
              ${getActionableErrorMessage(err?.code)}
              ${host.actionError ? html`<div>${host.actionError}</div>` : ''}
            </div>
          `
        : ''}
      ${state === 'downloading' && host.downloadProgress
        ? html`
            <div
              class="model-progress-container"
              role="progressbar"
              aria-valuenow="${host.downloadProgress.percentage}"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-label="${msg('Model download progress')}"
            >
              <md-linear-progress
                value="${host.downloadProgress.percentage / 100}"
                aria-label="${msg('Model download progress')}"
              ></md-linear-progress>
              <div class="progress-text" role="status" aria-live="polite">
                <span
                  >${formatBytes(host.downloadProgress.bytesDownloaded)} /
                  ${formatBytes(host.downloadProgress.totalBytes)}
                  (${host.downloadProgress.percentage}%)</span
                >
                <span>${formatSpeed(host.downloadProgress.speedBps)}</span>
              </div>
            </div>
          `
        : ''}
      ${host.updateCheckMessage
        ? html`<div
            class="progress-text"
            role="status"
            aria-live="polite"
            style="color: var(--md-sys-color-primary, #0b57d0)"
          >
            ${host.updateCheckMessage}
          </div>`
        : ''}

      <div class="model-actions">
        ${state === 'not_downloaded'
          ? html`<md-filled-button @click=${() => void host.onDownloadClick()}
              >${host.downloadProgress?.bytesDownloaded
                ? msg('Resume Download')
                : msg('Download')}</md-filled-button
            >`
          : ''}
        ${state === 'downloading'
          ? html`<md-text-button @click=${() => host.onCancelDownloadClick()}
              >${msg('Cancel Download')}</md-text-button
            >`
          : ''}
        ${state === 'downloaded'
          ? html`<md-filled-button @click=${() => void host.onLoadClick()}
              >${msg('Load Model')}</md-filled-button
            >`
          : ''}
        ${state === 'ready'
          ? html`<md-text-button @click=${() => void host.onUnloadClick()}
              >${msg('Unload')}</md-text-button
            >`
          : ''}
        ${state === 'update_available'
          ? html`<md-filled-button @click=${() => void host.onDownloadClick()}
              >${msg('Update')}</md-filled-button
            >`
          : ''}
        ${state === 'error'
          ? html`
              <md-filled-button @click=${() => void host.onRetryClick()}
                >${msg('Retry')}</md-filled-button
              >
              <md-text-button
                @click=${() => void host.onInferenceModeChange?.('cloud')}
                >${msg('Switch to Cloud')}</md-text-button
              >
            `
          : ''}
        ${state === 'downloaded' ||
        state === 'ready' ||
        state === 'update_available'
          ? html`<md-text-button
              @click=${(e: Event) => host.onConfirmRemoveClick(e)}
              >${msg('Remove')}</md-text-button
            >`
          : ''}
        <md-text-button
          @click=${() => void host.onCheckUpdateClick()}
          ?disabled=${host.isCheckingUpdates}
        >
          ${host.isCheckingUpdates
            ? msg('Checking...')
            : msg('Check for Updates')}
        </md-text-button>
        ${host.enableDebugModelImport
          ? html`
              <md-text-button @click=${() => host.triggerFileImport()}>
                ${msg('Import Local Model')}
              </md-text-button>
              <input
                type="file"
                id="debug-model-file"
                accept=".litertlm"
                style="display: none"
                @change=${(e: Event) => void host.onFileImportChange(e)}
              />
            `
          : ''}
      </div>

      <details
        class="diagnostics-details"
        @toggle=${(e: Event) => host.onDiagnosticsToggle(e)}
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
            <span class="diagnostics-label">${msg('Approx Device RAM')}:</span>
            <span class="diagnostics-value"
              >${(navigator as unknown as {deviceMemory?: number}).deviceMemory
                ? `${(navigator as unknown as {deviceMemory?: number}).deviceMemory} GB`
                : unknown}</span
            >
          </div>
          <div class="diagnostics-item">
            <span class="diagnostics-label">${msg('OPFS Storage Quota')}:</span>
            <span class="diagnostics-value"
              >${host.storageEstimate?.quota
                ? formatBytes(host.storageEstimate.quota)
                : unknown}</span
            >
          </div>
          <div class="diagnostics-item">
            <span class="diagnostics-label">${msg('OPFS Storage Used')}:</span>
            <span class="diagnostics-value"
              >${host.storageEstimate?.usage
                ? formatBytes(host.storageEstimate.usage)
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
              @click=${() => void host.onExportDiagnosticsClick()}
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

export function renderRemoveConfirmDialogTemplate(
  host: ModelCardHost,
): TemplateResult {
  return html`
    <md-dialog
      id="remove-confirm-dialog"
      ?open=${host.showRemoveConfirm}
      @closed=${() => host.onRemoveDialogClosed()}
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
        <md-text-button @click=${() => host.onRemoveDialogClosed()}>
          ${msg('Cancel')}
        </md-text-button>
        <md-filled-button @click=${() => void host.executeRemoveModel()}>
          ${msg('Remove')}
        </md-filled-button>
      </div>
    </md-dialog>
  `;
}
