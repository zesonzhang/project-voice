/**
 * Validates a real-device soak result. This command intentionally does
 * not synthesize latency or memory measurements: release evidence must be
 * produced by a 30-minute Chrome/WebGPU run with the pinned production model.
 */

import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const resultPath = process.argv[2] || process.env.ON_DEVICE_SOAK_RESULT;
if (!resultPath) {
  throw new Error(
    'BLOCKED: provide a real-device result path: npm run test:on-device-soak -- <result.json>',
  );
}

const absolutePath = resolve(resultPath);
if (!existsSync(absolutePath)) {
  throw new Error(`BLOCKED: soak evidence does not exist: ${absolutePath}`);
}

const result = JSON.parse(readFileSync(absolutePath, 'utf8'));
const requiredStrings = [
  'recordedAt',
  'platformId',
  'browserVersion',
  'runtime',
  'model',
];
for (const field of requiredStrings) {
  if (typeof result[field] !== 'string' || !result[field]) {
    throw new Error(`Invalid soak evidence: ${field} is required.`);
  }
}
if (result.schemaVersion !== 1 || result.evidenceType !== 'real-device') {
  throw new Error(
    'Invalid soak evidence: real-device schema version 1 is required.',
  );
}
if (result.durationMinutes < 30 || result.reloadCycles < 5) {
  throw new Error(
    'Invalid soak evidence: require >=30 minutes and >=5 reload cycles.',
  );
}

const metrics = result.metrics || {};
const gates = [
  ['firstWordLatencyP95Ms', metrics.firstWordLatencyP95Ms <= 2000],
  ['completeResultLatencyP95Ms', metrics.completeResultLatencyP95Ms <= 5000],
  ['mainThreadTasksOver200Ms', metrics.mainThreadTasksOver200Ms === 0],
  ['modelRedownloads', metrics.modelRedownloads === 0],
  ['memoryGrowthPercent', metrics.memoryGrowthPercent < 10],
  ['outputParseRatePercent', metrics.outputParseRatePercent >= 95],
];
for (const [name, passed] of gates) {
  if (!passed) throw new Error(`release gate failed: ${name}`);
}

console.log(`real-device soak evidence PASSED: ${absolutePath}`);
