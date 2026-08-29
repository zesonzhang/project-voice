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

import assert from 'node:assert/strict';

import {
  EXPECTED_CASES,
  REQUIRED_PLATFORMS,
  SUPPORTED_PLATFORMS,
  verifyM0Results,
} from './m0-result-verifier.mjs';

const artifact = {
  runtime: {version: '0.15.0'},
  model: {
    id: 'gemma-4-e2b-it-web',
    repositoryCommit: 'frozen-commit',
    byteSize: 2008432640,
  },
};

function environment(osFamily) {
  return {
    userAgent: 'Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36',
    declaredOsFamily: osFamily,
    declaredOsVersion: `${osFamily} test release`,
    declaredRamClassGiB: 16,
    declaredGpuDriver: 'Test GPU / driver',
    crossOriginIsolated: true,
  };
}

function baseRecord(recordType, deviceRunId) {
  return {
    schemaVersion: 1,
    recordType,
    deviceRunId,
    timestamp: '2026-08-27T00:00:00Z',
  };
}

function tupleRecord(recordType, deviceRunId, osFamily) {
  return {
    ...baseRecord(recordType, deviceRunId),
    runtimeVersion: artifact.runtime.version,
    modelId: artifact.model.id,
    modelCommit: artifact.model.repositoryCommit,
    environment: environment(osFamily),
    mainThreadLongTasks: {count: 0, longestMs: 0},
  };
}

function resultDocument(osFamily) {
  const deviceRunId = `${osFamily.toLowerCase()}-reference`;
  const records = [];
  for (let index = 0; index < 5; index += 1) {
    records.push({
      ...tupleRecord('load', deviceRunId, osFamily),
      loadKind: index === 1 ? 'warm' : 'cold',
      loadMs: 1000,
      source: 'opfs',
      modelBytes: artifact.model.byteSize,
      modelByteNetworkRequests: 0,
    });
  }
  for (const caseId of EXPECTED_CASES) {
    records.push({
      ...tupleRecord('generation', deviceRunId, osFamily),
      caseId,
      kind: caseId.endsWith('word') ? 'word' : 'sentence',
      generationPhase: 'warm',
      metrics: {
        totalMs: 3000,
        firstTokenMs: 500,
        firstParsedSuggestionMs: 1000,
        decodeTokensPerSecond: 20,
        prefillTokensPerSecond: 200,
        parsedSuggestionCount: 5,
      },
    });
  }
  records.push({
    ...tupleRecord('generation', deviceRunId, osFamily),
    caseId: 'en-word',
    kind: 'word',
    generationPhase: 'warmup',
    metrics: {
      totalMs: 15000,
      firstTokenMs: 5000,
      firstParsedSuggestionMs: 10000,
      decodeTokensPerSecond: 20,
      prefillTokensPerSecond: 200,
      parsedSuggestionCount: 5,
    },
  });
  for (const phase of ['prefill', 'decode']) {
    records.push({
      ...baseRecord('cancellation', deviceRunId),
      caseId: 'en-sentence',
      phase,
      acknowledged: true,
      acknowledgmentMs: 25,
      lateChunksSuppressed: 0,
      staleChunksRendered: 0,
    });
  }
  return {schemaVersion: 1, records};
}

const documents = SUPPORTED_PLATFORMS.map(osFamily => [
  `${osFamily}.json`,
  resultDocument(osFamily),
]);
const validResult = verifyM0Results(documents, artifact);
assert.equal(validResult.passed, true, JSON.stringify(validResult.errors));

const privateData = JSON.parse(JSON.stringify(documents));
privateData[0][1].records[0].prompt = 'must never be exported';
const privateDataResult = verifyM0Results(privateData, artifact);
assert.equal(privateDataResult.passed, false);
assert(privateDataResult.errors.some(error => error.includes('forbidden')));

const macosOnlyResult = verifyM0Results(documents.slice(0, 1), artifact);
assert.equal(macosOnlyResult.passed, true, JSON.stringify(macosOnlyResult.errors));

const missingMacosResult = verifyM0Results(documents.slice(1), artifact);
assert.equal(missingMacosResult.passed, false);
assert(
  missingMacosResult.errors.some(error =>
    error.includes(`Missing a complete ${REQUIRED_PLATFORMS[0]}`),
  ),
);

process.stdout.write('M0 result verifier tests passed.\n');
