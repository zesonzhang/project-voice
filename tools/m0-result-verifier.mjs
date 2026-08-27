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

export const EXPECTED_CASES = [
  'en-word',
  'en-sentence',
  'ja-word',
  'ja-sentence',
  'zh-word',
  'zh-sentence',
];

export const SUPPORTED_PLATFORMS = ['macOS', 'Windows', 'Linux'];
export const REQUIRED_PLATFORMS = ['macOS'];

const FORBIDDEN_KEYS = new Set([
  'conversationhistory',
  'generatedoutput',
  'generatedtext',
  'output',
  'persona',
  'prompt',
  'signedurl',
  'suggestions',
]);

export function verifyM0Results(documents, artifact) {
  const errors = [];
  const warnings = [];
  const records = [];

  for (const [documentName, document] of documents) {
    if (!isObject(document) || document.schemaVersion !== 1) {
      errors.push(`${documentName}: expected result schemaVersion 1.`);
      continue;
    }
    if (!Array.isArray(document.records)) {
      errors.push(`${documentName}: records must be an array.`);
      continue;
    }
    findForbiddenKeys(document, documentName, errors);
    for (const record of document.records) {
      records.push({documentName, record});
    }
  }

  if (records.length === 0) errors.push('No M0 result records were supplied.');

  const groups = new Map();
  for (const entry of records) {
    const {documentName, record} = entry;
    if (!isObject(record) || record.schemaVersion !== 1) {
      errors.push(`${documentName}: every record must use schemaVersion 1.`);
      continue;
    }
    if (!isValidRunId(record.deviceRunId)) {
      errors.push(`${documentName}: record has an invalid deviceRunId.`);
      continue;
    }
    const group = groups.get(record.deviceRunId) ?? [];
    group.push(record);
    groups.set(record.deviceRunId, group);
  }

  const environmentSummaries = [];
  for (const [deviceRunId, groupRecords] of groups) {
    environmentSummaries.push(
      verifyEnvironment(deviceRunId, groupRecords, artifact, errors, warnings),
    );
  }

  const representedPlatforms = new Set(
    environmentSummaries.map(summary => summary.osFamily).filter(Boolean),
  );
  for (const platform of REQUIRED_PLATFORMS) {
    if (!representedPlatforms.has(platform)) {
      errors.push(`Missing a complete ${platform} reference-device result.`);
    }
  }

  return {
    schemaVersion: 1,
    passed: errors.length === 0,
    errors,
    warnings,
    environments: environmentSummaries,
  };
}

function verifyEnvironment(
  deviceRunId,
  records,
  artifact,
  errors,
  warnings,
) {
  const prefix = `[${deviceRunId}]`;
  const generations = records.filter(item => item.recordType === 'generation');
  const warmupGenerations = generations.filter(
    item => item.generationPhase === 'warmup',
  );
  const warmGenerations = generations.filter(
    item => item.generationPhase === 'warm',
  );
  const loads = records.filter(item => item.recordType === 'load');
  const cancellations = records.filter(
    item => item.recordType === 'cancellation',
  );
  const runtimeErrors = records.filter(item => item.recordType === 'error');
  const unknownTypes = records.filter(
    item =>
      !['generation', 'load', 'cancellation', 'error'].includes(
        item.recordType,
      ),
  );
  if (unknownTypes.length > 0) {
    errors.push(`${prefix} contains unknown record types.`);
  }
  if (runtimeErrors.length > 0) {
    errors.push(`${prefix} contains ${runtimeErrors.length} runtime error(s).`);
  }

  const environmentRecords = [...generations, ...loads];
  const osFamilies = new Set(
    environmentRecords.map(item => item.environment?.declaredOsFamily),
  );
  const osFamily = osFamilies.size === 1 ? [...osFamilies][0] : null;
  if (!SUPPORTED_PLATFORMS.includes(osFamily)) {
    errors.push(`${prefix} has missing or inconsistent OS-family metadata.`);
  }

  for (const record of environmentRecords) {
    verifyTuple(record, artifact, prefix, errors);
    verifyEnvironmentMetadata(record.environment, prefix, errors);
    if (record.mainThreadLongTasks?.longestMs > 200) {
      errors.push(`${prefix} has a main-thread long task over 200 ms.`);
    }
  }

  if (loads.length < 5) {
    errors.push(`${prefix} needs at least five OPFS load records.`);
  }
  if (!loads.some(item => item.loadKind === 'cold')) {
    errors.push(`${prefix} is missing a cold-load record.`);
  }
  if (!loads.some(item => item.loadKind === 'warm')) {
    errors.push(`${prefix} is missing a warm engine-recreation record.`);
  }
  for (const load of loads) {
    if (
      load.source !== 'opfs' ||
      load.modelByteNetworkRequests !== 0 ||
      load.modelBytes !== artifact.model.byteSize ||
      !isPositiveNumber(load.loadMs)
    ) {
      errors.push(`${prefix} contains an invalid OPFS load record.`);
      break;
    }
  }

  if (warmupGenerations.length < 1) {
    errors.push(`${prefix} is missing a generation warm-up sample.`);
  }
  if (warmupGenerations.length + warmGenerations.length !== generations.length) {
    errors.push(`${prefix} contains a generation with an invalid phase.`);
  }
  const completedCases = new Set(warmGenerations.map(item => item.caseId));
  for (const caseId of EXPECTED_CASES) {
    if (!completedCases.has(caseId)) {
      errors.push(`${prefix} is missing generation case ${caseId}.`);
    }
  }
  for (const generation of warmupGenerations) {
    verifyGeneration(generation, prefix, errors, false);
  }
  for (const generation of warmGenerations) {
    verifyGeneration(generation, prefix, errors, true);
  }

  const cancellationPhases = new Set(cancellations.map(item => item.phase));
  for (const phase of ['prefill', 'decode']) {
    if (!cancellationPhases.has(phase)) {
      errors.push(`${prefix} is missing a confirmed ${phase} cancellation.`);
    }
  }
  for (const cancellation of cancellations) {
    if (
      cancellation.acknowledged !== true ||
      cancellation.staleChunksRendered !== 0 ||
      !isNonNegativeNumber(cancellation.lateChunksSuppressed) ||
      !isPositiveNumber(cancellation.acknowledgmentMs)
    ) {
      errors.push(`${prefix} contains an invalid cancellation record.`);
      break;
    }
  }

  if (warmGenerations.length < EXPECTED_CASES.length) {
    warnings.push(`${prefix} has too few samples for a meaningful p95.`);
  }

  return {
    deviceRunId,
    osFamily,
    loadCount: loads.length,
    generationCount: generations.length,
    cancellationCount: cancellations.length,
    runtimeErrorCount: runtimeErrors.length,
  };
}

function verifyTuple(record, artifact, prefix, errors) {
  if (
    record.runtimeVersion !== artifact.runtime.version ||
    record.modelId !== artifact.model.id ||
    record.modelCommit !== artifact.model.repositoryCommit
  ) {
    errors.push(`${prefix} contains a record from a different frozen tuple.`);
  }
}

function verifyEnvironmentMetadata(environment, prefix, errors) {
  if (
    !isObject(environment) ||
    !SUPPORTED_PLATFORMS.includes(environment.declaredOsFamily) ||
    typeof environment.declaredOsVersion !== 'string' ||
    environment.declaredOsVersion.trim() === '' ||
    !isPositiveNumber(environment.declaredRamClassGiB) ||
    typeof environment.declaredGpuDriver !== 'string' ||
    environment.declaredGpuDriver.trim() === '' ||
    typeof environment.userAgent !== 'string' ||
    !/Chrome\/\d+(?:\.\d+)+/.test(environment.userAgent) ||
    environment.crossOriginIsolated !== true
  ) {
    errors.push(`${prefix} has incomplete reference-device metadata.`);
  }
}

function verifyGeneration(generation, prefix, errors, enforceLatency) {
  const metrics = generation.metrics;
  if (
    !isObject(metrics) ||
    !isPositiveNumber(metrics.totalMs) ||
    !isPositiveNumber(metrics.firstTokenMs) ||
    !isPositiveNumber(metrics.firstParsedSuggestionMs) ||
    !isPositiveNumber(metrics.decodeTokensPerSecond) ||
    !isPositiveNumber(metrics.prefillTokensPerSecond) ||
    !Number.isInteger(metrics.parsedSuggestionCount) ||
    metrics.parsedSuggestionCount < 1
  ) {
    errors.push(`${prefix} contains incomplete generation metrics.`);
    return;
  }
  if (
    enforceLatency &&
    generation.kind === 'word' &&
    metrics.firstParsedSuggestionMs > 2000
  ) {
    errors.push(`${prefix} word suggestions exceed the 2-second target.`);
  }
  if (enforceLatency && metrics.totalMs > 5000) {
    errors.push(`${prefix} generation exceeds the 5-second target.`);
  }
}

function findForbiddenKeys(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findForbiddenKeys(item, `${path}[${index}]`, errors),
    );
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if (FORBIDDEN_KEYS.has(normalizedKey)) {
      errors.push(`${path}: forbidden diagnostics field ${key}.`);
    }
    findForbiddenKeys(child, `${path}.${key}`, errors);
  }
}

function isValidRunId(value) {
  return typeof value === 'string' && /^[a-z0-9-]+$/.test(value);
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isObject(value) {
  return typeof value === 'object' && value !== null;
}
