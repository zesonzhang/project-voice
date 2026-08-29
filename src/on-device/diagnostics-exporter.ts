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

import {ModelLifecycleState} from './model-lifecycle.js';
import {ModelManager, StateTransitionRecord} from './model-manager.js';

export interface PrivacySafeDiagnosticsReport {
  schemaVersion: 1;
  exportedAt: string;
  systemInfo: {
    userAgent: string;
    isSecureContext: boolean;
    crossOriginIsolated: boolean;
    webgpuSupported: boolean;
    opfsSupported: boolean;
    workerSupported: boolean;
    persistenceGranted: boolean;
  };
  lifecycle: {
    currentState: ModelLifecycleState;
    activeModelId: string | null;
    activeVersion: string | null;
    activeModelSizeBytes: number | null;
    transitionHistory: StateTransitionRecord[];
  };
  storage: {
    quotaTotalBytes: number;
    quotaAvailableBytes: number;
    installedVersions: Array<{
      modelId: string;
      version: string;
      sizeBytes: number;
      verificationState: string;
      createdAt: number;
    }>;
  };
  lastError: {
    code: string | null;
    sanitizedMessage: string | null;
  };
  privacyVerification: {
    userTextIncluded: false;
    personaIncluded: false;
    conversationHistoryIncluded: false;
    signedUrlsIncluded: false;
  };
}

/**
 * Sanitizes arbitrary error messages or diagnostic strings:
 * - Strips signed URLs, HMAC signatures, tokens, auth headers.
 * - Strips sensitive query parameters.
 */
export function sanitizeDiagnosticText(
  text: string | null | undefined,
): string | null {
  if (!text) return null;

  // Redact signed Google Cloud Storage URLs or URLs with query parameters
  let sanitized = text.replace(
    /https?:\/\/[^\s"'<>]+\?[^\s"'<>]+/gi,
    '[REDACTED_SIGNED_URL]',
  );

  // Redact hex signatures (e.g. signature=..., sig=..., auth=...)
  sanitized = sanitized.replace(
    /(?:sig|signature|token|auth|key)=[a-zA-Z0-9_-]+/gi,
    '[REDACTED_CREDENTIAL]',
  );

  // Redact potential Bearer tokens
  sanitized = sanitized.replace(
    /Bearer\s+[a-zA-Z0-9._-]+/gi,
    'Bearer [REDACTED]',
  );

  return sanitized;
}

/**
 * Collects and exports a privacy-safe diagnostics snapshot from ModelManager.
 */
export async function exportPrivacySafeDiagnostics(
  modelManager: ModelManager,
): Promise<PrivacySafeDiagnosticsReport> {
  const activeManifest = modelManager.getActiveManifest();
  const rawError = modelManager.getError();
  const preflight = await modelManager.checkCapabilities();

  // Inspect storage and metadata safely
  const metadataStore = modelManager.getMetadataStore();
  let installedVersions: PrivacySafeDiagnosticsReport['storage']['installedVersions'] =
    [];

  try {
    const models = await metadataStore.listModels();
    for (const m of models) {
      const versions = await metadataStore.listVersions(m.modelId);
      for (const v of versions) {
        installedVersions.push({
          modelId: v.modelId,
          version: v.version,
          sizeBytes: v.sizeBytes,
          verificationState: v.verificationState,
          createdAt: v.createdAt,
        });
      }
    }
  } catch {
    installedVersions = [];
  }

  const isSecure =
    typeof window !== 'undefined' ? !!window.isSecureContext : true;
  const isIsolated =
    typeof window !== 'undefined' ? !!window.crossOriginIsolated : true;
  const userAgent =
    typeof navigator !== 'undefined' ? navigator.userAgent : 'Node/Test';

  const report: PrivacySafeDiagnosticsReport = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    systemInfo: {
      userAgent,
      isSecureContext: isSecure,
      crossOriginIsolated: isIsolated,
      webgpuSupported: !!preflight.webgpuSupported,
      opfsSupported: !!preflight.opfsSupported,
      workerSupported: !!preflight.workerSupported,
      persistenceGranted: !!preflight.persistenceGranted,
    },
    lifecycle: {
      currentState: modelManager.getState(),
      activeModelId: activeManifest?.modelId || null,
      activeVersion: activeManifest?.version || null,
      activeModelSizeBytes: activeManifest?.sizeBytes || null,
      transitionHistory: modelManager.getTransitionHistory(),
    },
    storage: {
      quotaTotalBytes: preflight.quotaTotalBytes || 0,
      quotaAvailableBytes: preflight.quotaAvailableBytes || 0,
      installedVersions,
    },
    lastError: {
      code: rawError?.code || null,
      sanitizedMessage: sanitizeDiagnosticText(rawError?.message),
    },
    privacyVerification: {
      userTextIncluded: false,
      personaIncluded: false,
      conversationHistoryIncluded: false,
      signedUrlsIncluded: false,
    },
  };

  return report;
}

/**
 * Triggers a browser file download of the privacy-safe diagnostics report.
 */
export function downloadDiagnosticsReport(
  report: PrivacySafeDiagnosticsReport,
  filename = `project-voice-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
): void {
  if (typeof document === 'undefined') return;

  const jsonStr = JSON.stringify(report, null, 2);
  const blob = new Blob([jsonStr], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
