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

import {
  CANDIDATE_MODEL,
  LITERT_LM_VERSION,
  M0_PROTOCOL_VERSION,
  M0GenerationMetrics,
  M0WorkerRequest,
  M0WorkerResponse,
} from './protocol.js';

interface BenchmarkCase {
  id: string;
  label: string;
  language: 'English' | 'Japanese' | 'Mandarin';
  kind: 'word' | 'sentence';
  prompt: string;
}

interface GenerationRecord {
  schemaVersion: 1;
  recordType: 'generation';
  deviceRunId: string;
  timestamp: string;
  caseId: string;
  language: BenchmarkCase['language'];
  kind: BenchmarkCase['kind'];
  generationPhase: 'warmup' | 'warm';
  runtimeVersion: string;
  modelId: string;
  modelCommit: string;
  environment: Record<string, unknown>;
  metrics: M0GenerationMetrics;
  mainThreadLongTasks: {count: number; longestMs: number};
  pageMemoryBytes: number | null;
  opfsUsageBytes: number | null;
  opfsQuotaBytes: number | null;
  errors: string[];
}

interface LoadRecord {
  schemaVersion: 1;
  recordType: 'load';
  deviceRunId: string;
  timestamp: string;
  loadKind: 'cold' | 'warm';
  loadMs: number;
  source: 'opfs';
  modelBytes: number;
  modelByteNetworkRequests: 0;
  runtimeVersion: string;
  modelId: string;
  modelCommit: string;
  environment: Record<string, unknown>;
  mainThreadLongTasks: {count: number; longestMs: number};
  pageMemoryBytes: number | null;
  opfsUsageBytes: number | null;
  opfsQuotaBytes: number | null;
}

interface ErrorRecord {
  schemaVersion: 1;
  recordType: 'error';
  deviceRunId: string;
  timestamp: string;
  code: string;
  phase: string;
  detailIncluded: false;
}

interface CancellationRecord {
  schemaVersion: 1;
  recordType: 'cancellation';
  deviceRunId: string;
  timestamp: string;
  caseId: string;
  phase: 'prefill' | 'decode';
  acknowledged: true;
  acknowledgmentMs: number;
  lateChunksSuppressed: number;
  staleChunksRendered: 0;
}

type BenchmarkRecord =
  | GenerationRecord
  | LoadRecord
  | ErrorRecord
  | CancellationRecord;

const BENCHMARK_CASES: BenchmarkCase[] = [
  {
    id: 'en-word',
    label: 'English · word',
    language: 'English',
    kind: 'word',
    prompt:
      'Complete the partial English input "I would like" with five likely ' +
      'next words. Return only a numbered list in the form "1. word".',
  },
  {
    id: 'en-sentence',
    label: 'English · sentence',
    language: 'English',
    kind: 'sentence',
    prompt:
      'Suggest five concise English sentences that begin with "I would ' +
      'like". Return only a numbered list in the form "1. sentence".',
  },
  {
    id: 'ja-word',
    label: 'Japanese · word',
    language: 'Japanese',
    kind: 'word',
    prompt:
      '「今日は」の次に続く可能性が高い日本語の単語を5つ提案してくだ' +
      'さい。「1. 単語」の形式の番号付きリストだけを返してください。',
  },
  {
    id: 'ja-sentence',
    label: 'Japanese · sentence',
    language: 'Japanese',
    kind: 'sentence',
    prompt:
      '「今日は」で始まる自然で短い日本語の文を5つ提案してください。' +
      '「1. 文」の形式の番号付きリストだけを返してください。',
  },
  {
    id: 'zh-word',
    label: 'Mandarin · word',
    language: 'Mandarin',
    kind: 'word',
    prompt:
      '为中文输入“我想”提供五个最可能的后续词。只返回“1. 词语”格式的' +
      '编号列表。',
  },
  {
    id: 'zh-sentence',
    label: 'Mandarin · sentence',
    language: 'Mandarin',
    kind: 'sentence',
    prompt:
      '提供五个以“我想”开头的简短自然中文句子。只返回“1. 句子”格式的' +
      '编号列表。',
  },
];

const worker = new Worker('/static/m0-inference-worker.js');
const records: BenchmarkRecord[] = loadRecords();
let sequenceId = 0;
let activeSequenceId: number | null = null;
let currentCase: BenchmarkCase | null = null;
let longTaskCount = 0;
let longestLongTaskMs = 0;
let loadCountThisPage = 0;
let activeGenerationHadOutput = false;
let completedGenerationCountThisEngine = 0;
let activeGenerationPhase: GenerationRecord['generationPhase'] = 'warmup';
let pendingCancellation: PendingCancellation | null = null;
const cancellationRecords = new Map<number, CancellationRecord>();

interface PendingCancellation {
  sequenceId: number;
  caseId: string;
  phase: CancellationRecord['phase'];
  requestedAt: number;
  lateChunksSuppressed: number;
}

const statusElement = requiredElement<HTMLElement>('status');
const outputElement = requiredElement<HTMLElement>('output');
const logElement = requiredElement<HTMLElement>('log');
const progressElement = requiredElement<HTMLProgressElement>('progress');
const progressLabel = requiredElement<HTMLElement>('progress-label');
const caseSelect = requiredElement<HTMLSelectElement>('benchmark-case');
const modelInput = requiredElement<HTMLInputElement>('model-file');
const deviceRunIdInput = requiredElement<HTMLInputElement>('device-run-id');
const osFamilyInput = requiredElement<HTMLSelectElement>('os-family');
const osVersionInput = requiredElement<HTMLInputElement>('os-version');
const ramClassInput = requiredElement<HTMLSelectElement>('ram-class');
const gpuDriverInput = requiredElement<HTMLInputElement>('gpu-driver');

restoreDeviceMetadata();
for (const input of [
  deviceRunIdInput,
  osFamilyInput,
  osVersionInput,
  ramClassInput,
  gpuDriverInput,
]) {
  input.addEventListener('change', saveDeviceMetadata);
}

for (const benchmarkCase of BENCHMARK_CASES) {
  const option = document.createElement('option');
  option.value = benchmarkCase.id;
  option.textContent = benchmarkCase.label;
  caseSelect.append(option);
}

const observer =
  typeof PerformanceObserver === 'undefined'
    ? null
    : new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1;
          longestLongTaskMs = Math.max(longestLongTaskMs, entry.duration);
        }
      });
try {
  observer?.observe({entryTypes: ['longtask']});
} catch {
  appendLog('Long Task API is unavailable; this metric will remain zero.');
}

worker.addEventListener('message', event => {
  const response = event.data as M0WorkerResponse;
  if (response.protocolVersion !== M0_PROTOCOL_VERSION) {
    appendLog('Ignored a Worker response with an unsupported protocol.');
    return;
  }
  void handleResponse(response);
});

worker.addEventListener('error', event => {
  setStatus('Worker crashed', true);
  appendLog(event.message);
});

bindButton('check-capabilities', () => send('GET_CAPABILITIES'));
bindButton('model-info', () => send('GET_MODEL_INFO'));
bindButton('install-url', () => {
  const gib = (CANDIDATE_MODEL.byteSize / 1024 ** 3).toFixed(2);
  if (
    window.confirm(
      `Download the frozen ${gib} GiB feasibility model into OPFS?`,
    )
  ) {
    void requestPersistence();
    send('INSTALL_URL', {url: CANDIDATE_MODEL.url});
  }
});
bindButton('install-file', () => modelInput.click());
modelInput.addEventListener('change', () => {
  const file = modelInput.files?.[0];
  if (!file) return;
  void requestPersistence();
  send('INSTALL_FILE', {file});
  modelInput.value = '';
});
bindButton('load-model', () => {
  resetLongTasks();
  send('LOAD_MODEL');
});
bindButton('run-case', () => {
  currentCase =
    BENCHMARK_CASES.find(item => item.id === caseSelect.value) ?? null;
  if (!currentCase) return;
  activeSequenceId = ++sequenceId;
  activeGenerationHadOutput = false;
  activeGenerationPhase =
    completedGenerationCountThisEngine === 0 ? 'warmup' : 'warm';
  pendingCancellation = null;
  outputElement.textContent = '';
  resetLongTasks();
  send('GENERATE', {
    sequenceId: activeSequenceId,
    prompt: currentCase.prompt,
    maxOutputTokens: currentCase.kind === 'word' ? 64 : 192,
    temperature: 0,
    topP: 0.95,
  });
});
bindButton('cancel', () => {
  if (activeSequenceId !== null && currentCase !== null) {
    pendingCancellation = {
      sequenceId: activeSequenceId,
      caseId: currentCase.id,
      phase: activeGenerationHadOutput ? 'decode' : 'prefill',
      requestedAt: performance.now(),
      lateChunksSuppressed: 0,
    };
    send('CANCEL', {sequenceId: activeSequenceId});
    activeSequenceId = null;
    setStatus('Cancel requested; suppressing later output');
  }
});
bindButton('unload-model', () => send('UNLOAD_MODEL'));
bindButton('remove-model', () => {
  if (window.confirm('Remove only the frozen M0 model from this origin?')) {
    send('REMOVE_MODEL');
  }
});
bindButton('export-results', exportRecords);
bindButton('clear-results', () => {
  records.splice(0, records.length);
  cancellationRecords.clear();
  saveRecords();
  renderRecordCount();
});

send('GET_CAPABILITIES');
send('GET_MODEL_INFO');
renderCandidate();
renderRecordCount();

function send(
  type: M0WorkerRequest['type'],
  payload: Record<string, unknown> = {},
): void {
  worker.postMessage({
    protocolVersion: M0_PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    type,
    ...payload,
  });
}

async function handleResponse(response: M0WorkerResponse): Promise<void> {
  switch (response.type) {
    case 'CAPABILITIES':
      requiredElement('capabilities').textContent = JSON.stringify(
        response.capabilities,
        null,
        2,
      );
      setStatus(
        response.capabilities.deviceAvailable
          ? 'Capabilities ready'
          : 'WebGPU unavailable',
        !response.capabilities.deviceAvailable,
      );
      return;
    case 'MODEL_INFO':
      requiredElement('model-state').textContent = response.model.installed
        ? `Installed (${formatBytes(response.model.byteSize)})`
        : 'Not installed';
      return;
    case 'STATUS':
      setStatus(response.detail ?? response.status);
      return;
    case 'INSTALL_PROGRESS':
      progressElement.hidden = false;
      progressElement.max = response.totalBytes;
      progressElement.value = response.loadedBytes;
      progressLabel.textContent = `${formatBytes(
        response.loadedBytes,
      )} / ${formatBytes(response.totalBytes)}`;
      return;
    case 'MODEL_READY':
      setStatus(`Ready; loaded from OPFS in ${formatMs(response.loadMs)}`);
      appendLog(
        `Model ready from ${response.source}; network model-byte requests: 0.`,
      );
      records.push(
        await createLoadRecord(
          loadCountThisPage === 0 ? 'cold' : 'warm',
          response.loadMs,
          response.modelBytes,
        ),
      );
      loadCountThisPage += 1;
      completedGenerationCountThisEngine = 0;
      saveRecords();
      renderRecordCount();
      send('GET_MODEL_INFO');
      return;
    case 'PARTIAL_OUTPUT':
      if (pendingCancellation?.sequenceId === response.sequenceId) {
        pendingCancellation.lateChunksSuppressed += 1;
      } else if (response.sequenceId === activeSequenceId) {
        activeGenerationHadOutput = true;
        outputElement.textContent = response.text;
      } else {
        const record = cancellationRecords.get(response.sequenceId);
        if (record) {
          record.lateChunksSuppressed += 1;
          saveRecords();
        }
      }
      return;
    case 'GENERATION_COMPLETE':
      if (response.sequenceId !== activeSequenceId || currentCase === null) {
        return;
      }
      records.push(
        await createRecord(
          currentCase,
          activeGenerationPhase,
          response.metrics,
          {
            count: longTaskCount,
            longestMs: longestLongTaskMs,
          },
        ),
      );
      completedGenerationCountThisEngine += 1;
      saveRecords();
      renderRecordCount();
      setStatus(
        `Complete in ${formatMs(response.metrics.totalMs)}; ` +
          `${response.metrics.parsedSuggestionCount} parsed`,
      );
      activeSequenceId = null;
      return;
    case 'CANCELED':
      if (
        pendingCancellation !== null &&
        pendingCancellation.sequenceId === response.sequenceId
      ) {
        const cancellationRecord: CancellationRecord = {
          schemaVersion: 1,
          recordType: 'cancellation',
          deviceRunId: getDeviceRunId(),
          timestamp: new Date().toISOString(),
          caseId: pendingCancellation.caseId,
          phase: pendingCancellation.phase,
          acknowledged: true,
          acknowledgmentMs: performance.now() - pendingCancellation.requestedAt,
          lateChunksSuppressed: pendingCancellation.lateChunksSuppressed,
          staleChunksRendered: 0,
        };
        records.push(cancellationRecord);
        cancellationRecords.set(response.sequenceId, cancellationRecord);
        saveRecords();
        renderRecordCount();
        pendingCancellation = null;
        setStatus('Generation canceled; stale output suppressed');
      }
      return;
    case 'DONE':
      progressElement.hidden = true;
      progressLabel.textContent = '';
      setStatus(`${response.operation} complete`);
      send('GET_MODEL_INFO');
      return;
    case 'ERROR':
      setStatus(`${response.error.code}: ${response.error.message}`, true);
      appendLog(
        `${response.error.phase} / ${response.error.code}: ` +
          response.error.message,
      );
      records.push({
        schemaVersion: 1,
        recordType: 'error',
        deviceRunId: getDeviceRunId(),
        timestamp: new Date().toISOString(),
        code: response.error.code,
        phase: response.error.phase,
        detailIncluded: false,
      });
      saveRecords();
      renderRecordCount();
      return;
  }
}

async function createRecord(
  benchmarkCase: BenchmarkCase,
  generationPhase: GenerationRecord['generationPhase'],
  metrics: M0GenerationMetrics,
  mainThreadLongTasks: {count: number; longestMs: number},
): Promise<GenerationRecord> {
  const [environment, storage, pageMemoryBytes] = await Promise.all([
    getEnvironment(),
    navigator.storage.estimate(),
    measurePageMemory(),
  ]);
  return {
    schemaVersion: 1,
    recordType: 'generation',
    deviceRunId: getDeviceRunId(),
    timestamp: new Date().toISOString(),
    caseId: benchmarkCase.id,
    language: benchmarkCase.language,
    kind: benchmarkCase.kind,
    generationPhase,
    runtimeVersion: LITERT_LM_VERSION,
    modelId: CANDIDATE_MODEL.id,
    modelCommit: CANDIDATE_MODEL.repositoryCommit,
    environment,
    metrics,
    mainThreadLongTasks,
    pageMemoryBytes,
    opfsUsageBytes: storage.usage ?? null,
    opfsQuotaBytes: storage.quota ?? null,
    errors: [],
  };
}

async function createLoadRecord(
  loadKind: LoadRecord['loadKind'],
  loadMs: number,
  modelBytes: number,
): Promise<LoadRecord> {
  const [environment, storage, pageMemoryBytes] = await Promise.all([
    getEnvironment(),
    navigator.storage.estimate(),
    measurePageMemory(),
  ]);
  return {
    schemaVersion: 1,
    recordType: 'load',
    deviceRunId: getDeviceRunId(),
    timestamp: new Date().toISOString(),
    loadKind,
    loadMs,
    source: 'opfs',
    modelBytes,
    modelByteNetworkRequests: 0,
    runtimeVersion: LITERT_LM_VERSION,
    modelId: CANDIDATE_MODEL.id,
    modelCommit: CANDIDATE_MODEL.repositoryCommit,
    environment,
    mainThreadLongTasks: {
      count: longTaskCount,
      longestMs: longestLongTaskMs,
    },
    pageMemoryBytes,
    opfsUsageBytes: storage.usage ?? null,
    opfsQuotaBytes: storage.quota ?? null,
  };
}

async function getEnvironment(): Promise<Record<string, unknown>> {
  const extendedNavigator = navigator as Navigator & {
    deviceMemory?: number;
    gpu?: {
      requestAdapter(): Promise<{
        info?: Record<string, string>;
      } | null>;
    };
  };
  let adapterInfo: Record<string, string> | null = null;
  try {
    adapterInfo = (await extendedNavigator.gpu?.requestAdapter())?.info ?? null;
  } catch {
    adapterInfo = null;
  }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    declaredOsFamily: osFamilyInput.value,
    declaredOsVersion: osVersionInput.value.trim() || null,
    declaredRamClassGiB: Number(ramClassInput.value) || null,
    declaredGpuDriver: gpuDriverInput.value.trim() || null,
    logicalProcessors: navigator.hardwareConcurrency,
    deviceMemoryGiB: extendedNavigator.deviceMemory ?? null,
    adapterInfo,
    crossOriginIsolated: self.crossOriginIsolated,
  };
}

async function measurePageMemory(): Promise<number | null> {
  const extendedPerformance = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{bytes: number}>;
  };
  try {
    return (
      (await extendedPerformance.measureUserAgentSpecificMemory?.())?.bytes ??
      null
    );
  } catch {
    return null;
  }
}

async function requestPersistence(): Promise<void> {
  try {
    const persisted = await navigator.storage.persist();
    appendLog(`Persistent storage ${persisted ? 'granted' : 'not granted'}.`);
  } catch (error) {
    appendLog(`Persistent storage request failed: ${String(error)}`);
  }
}

function renderCandidate(): void {
  requiredElement('candidate').textContent = JSON.stringify(
    {
      ...CANDIDATE_MODEL,
      url: '(frozen URL; omitted from diagnostics export)',
      runtimeVersion: LITERT_LM_VERSION,
    },
    null,
    2,
  );
}

function exportRecords(): void {
  if (!isDeviceMetadataComplete()) {
    setStatus('Complete all reference device metadata before export.', true);
    return;
  }
  const blob = new Blob(
    [JSON.stringify({schemaVersion: 1, records}, null, 2)],
    {type: 'application/json'},
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `project-voice-m0-${new Date()
    .toISOString()
    .replaceAll(':', '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function loadRecords(): BenchmarkRecord[] {
  try {
    const value = JSON.parse(
      localStorage.getItem('project-voice-m0-runs') ?? '[]',
    );
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveRecords(): void {
  localStorage.setItem('project-voice-m0-runs', JSON.stringify(records));
}

function renderRecordCount(): void {
  requiredElement('record-count').textContent = `${records.length} run(s)`;
}

function getDeviceRunId(): string {
  return deviceRunIdInput.value.trim() || 'unlabeled';
}

function restoreDeviceMetadata(): void {
  deviceRunIdInput.value =
    localStorage.getItem('project-voice-m0-device-run-id') ?? '';
  osFamilyInput.value =
    localStorage.getItem('project-voice-m0-os-family') ?? '';
  osVersionInput.value =
    localStorage.getItem('project-voice-m0-os-version') ?? '';
  ramClassInput.value =
    localStorage.getItem('project-voice-m0-ram-class') ?? '';
  gpuDriverInput.value =
    localStorage.getItem('project-voice-m0-gpu-driver') ?? '';
}

function saveDeviceMetadata(): void {
  localStorage.setItem(
    'project-voice-m0-device-run-id',
    deviceRunIdInput.value.trim(),
  );
  localStorage.setItem('project-voice-m0-os-family', osFamilyInput.value);
  localStorage.setItem(
    'project-voice-m0-os-version',
    osVersionInput.value.trim(),
  );
  localStorage.setItem('project-voice-m0-ram-class', ramClassInput.value);
  localStorage.setItem(
    'project-voice-m0-gpu-driver',
    gpuDriverInput.value.trim(),
  );
}

function isDeviceMetadataComplete(): boolean {
  return (
    /^[a-z0-9-]+$/.test(getDeviceRunId()) &&
    ['macOS', 'Windows', 'Linux'].includes(osFamilyInput.value) &&
    osVersionInput.value.trim().length > 0 &&
    Number(ramClassInput.value) > 0 &&
    gpuDriverInput.value.trim().length > 0
  );
}

function resetLongTasks(): void {
  longTaskCount = 0;
  longestLongTaskMs = 0;
}

function bindButton(id: string, handler: () => void): void {
  requiredElement<HTMLButtonElement>(id).addEventListener('click', handler);
}

function setStatus(message: string, isError = false): void {
  statusElement.textContent = message;
  statusElement.dataset.error = String(isError);
}

function appendLog(message: string): void {
  logElement.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatMs(milliseconds: number): string {
  return `${milliseconds.toFixed(0)} ms`;
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}.`);
  return element as T;
}
