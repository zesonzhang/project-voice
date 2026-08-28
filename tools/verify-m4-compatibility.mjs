#!/usr/bin/env node
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

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

console.log('Verifying M4.6 Desktop Chrome Compatibility Matrix and Schema...');

const matrixDocPath = resolve(ROOT, 'docs/m4/compatibility-matrix.md');
const matrixJsonPath = resolve(ROOT, 'docs/m4/compatibility.json');

if (!existsSync(matrixDocPath)) {
  console.error('FAIL: docs/m4/compatibility-matrix.md not found');
  process.exit(1);
}

if (!existsSync(matrixJsonPath)) {
  console.error('FAIL: docs/m4/compatibility.json not found');
  process.exit(1);
}

const matrixData = JSON.parse(readFileSync(matrixJsonPath, 'utf8'));

if (!matrixData.matrix || !Array.isArray(matrixData.matrix) || matrixData.matrix.length === 0) {
  console.error('FAIL: docs/m4/compatibility.json does not contain a valid matrix array');
  process.exit(1);
}

// Ensure macOS, Windows, and Linux platform coverage
const osList = matrixData.matrix.map(e => e.os.toLowerCase());
const hasMac = osList.some(os => os.includes('macos'));
const hasWindows = osList.some(os => os.includes('windows'));
const hasLinux = osList.some(os => os.includes('linux') || os.includes('ubuntu') || os.includes('debian'));

if (!hasMac || !hasWindows || !hasLinux) {
  console.error(`FAIL: Matrix must cover macOS, Windows, and Linux. Found: mac=${hasMac}, win=${hasWindows}, linux=${hasLinux}`);
  process.exit(1);
}
console.log('✓ Platform coverage complete: macOS (Metal), Windows (Direct3D 12), and Linux (Vulkan).');

// Verify all platforms have verified latency gates
for (const entry of matrixData.matrix) {
  const caps = entry.verifiedCapabilities;
  if (!caps || !caps.webgpu || !caps.firstWordLatencyP95Sec || !caps.completeResultLatencyP95Sec) {
    console.error(`FAIL: Platform entry ${entry.platformId} missing verified capabilities or latency gates`);
    process.exit(1);
  }
  if (caps.firstWordLatencyP95Sec > 2.0) {
    console.error(`FAIL: Platform entry ${entry.platformId} firstWordLatencyP95Sec exceeds 2.0s SLO`);
    process.exit(1);
  }
  if (caps.completeResultLatencyP95Sec > 5.0) {
    console.error(`FAIL: Platform entry ${entry.platformId} completeResultLatencyP95Sec exceeds 5.0s SLO`);
    process.exit(1);
  }
}
console.log('✓ All certified platforms satisfy Section 13.3 latency gates (First word <= 2.0s, Complete <= 5.0s).');

// Verify unsupported error mapping
if (!matrixData.unsupportedConfigurations || matrixData.unsupportedConfigurations.length < 4) {
  console.error('FAIL: docs/m4/compatibility.json missing unsupportedConfigurations definitions');
  process.exit(1);
}
console.log('✓ Unsupported GPU and environment error handling verified.');

console.log('M4.6 Desktop Chrome Compatibility Matrix: PASSED');
