/** Validates per-platform, real-device M4.6 compatibility evidence. */

import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve('.');
const matrixPath = resolve(root, 'docs/m4/compatibility.json');
const evidenceDir = resolve(
  process.argv[2] || process.env.M4_COMPATIBILITY_RESULTS || 'docs/m4/results',
);
const matrixData = JSON.parse(readFileSync(matrixPath, 'utf8'));

if (!Array.isArray(matrixData.matrix) || matrixData.matrix.length === 0) {
  throw new Error('Compatibility matrix is empty.');
}

const operatingSystems = new Set();
for (const entry of matrixData.matrix) {
  const evidencePath = resolve(evidenceDir, `${entry.platformId}.json`);
  if (!existsSync(evidencePath)) {
    throw new Error(`BLOCKED: missing real-device evidence ${evidencePath}`);
  }
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  if (
    evidence.schemaVersion !== 1 ||
    evidence.evidenceType !== 'real-device' ||
    evidence.platformId !== entry.platformId ||
    evidence.runtime !== matrixData.frozenTuple.runtime ||
    evidence.model !== matrixData.frozenTuple.model
  ) {
    throw new Error(`Invalid or mismatched evidence for ${entry.platformId}.`);
  }
  if (
    evidence.firstWordLatencyP95Sec > 2 ||
    evidence.completeResultLatencyP95Sec > 5 ||
    evidence.installPassed !== true ||
    evidence.reloadPassed !== true ||
    evidence.updatePassed !== true ||
    evidence.failureRecoveryPassed !== true
  ) {
    throw new Error(`Compatibility gates failed for ${entry.platformId}.`);
  }
  const os = entry.os.toLowerCase();
  if (os.includes('macos')) operatingSystems.add('macos');
  if (os.includes('windows')) operatingSystems.add('windows');
  if (os.includes('linux') || os.includes('ubuntu')) {
    operatingSystems.add('linux');
  }
}

for (const requiredOs of ['macos', 'windows', 'linux']) {
  if (!operatingSystems.has(requiredOs)) {
    throw new Error(`Compatibility evidence does not cover ${requiredOs}.`);
  }
}

console.log(`M4.6 real-device compatibility evidence PASSED: ${evidenceDir}`);
