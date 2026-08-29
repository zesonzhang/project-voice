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

import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

console.log('Verifying M4.5 static privacy boundary invariants...');

// 1. SuggestionProviderRouter: Strict No-Fallback Check
const routerPath = resolve(ROOT, 'src/suggestion-provider-router.ts');
if (!existsSync(routerPath)) {
  console.error('FAIL: src/suggestion-provider-router.ts not found');
  process.exit(1);
}
const routerContent = readFileSync(routerPath, 'utf8');
if (
  routerContent.includes('catch') &&
  routerContent.includes('getCloudProvider')
) {
  console.error(
    'FAIL: Detected fallback to cloud provider inside SuggestionProviderRouter!',
  );
  process.exit(1);
}
console.log(
  '✓ SuggestionProviderRouter strictly enforces zero fallback to Cloud on Local failure.',
);

// 2. LocalSuggestionProvider: Zero network fetch / MacroApiClient dependency
const localProviderPath = resolve(ROOT, 'src/local-suggestion-provider.ts');
const localProviderContent = readFileSync(localProviderPath, 'utf8');
if (
  localProviderContent.includes('/run-macro') ||
  localProviderContent.includes('MacroApiClient')
) {
  console.error(
    'FAIL: LocalSuggestionProvider contains references to /run-macro or MacroApiClient!',
  );
  process.exit(1);
}
console.log(
  '✓ LocalSuggestionProvider contains zero references to /run-macro or MacroApiClient.',
);

// 3. Inference Web Worker: Zero external network calls
const workerPath = resolve(ROOT, 'src/on-device/inference-worker.ts');
const workerContent = readFileSync(workerPath, 'utf8');
if (
  workerContent.includes('fetch(') ||
  workerContent.includes('XMLHttpRequest') ||
  workerContent.includes('/run-macro')
) {
  console.error('FAIL: Inference worker contains network fetch calls!');
  process.exit(1);
}
console.log('✓ Dedicated inference worker contains zero network fetch calls.');

// 4. Test Suite presence: test_m4_privacy_network.ts
const testPrivacyPath = resolve(ROOT, 'src/tests/test_m4_privacy_network.ts');
if (!existsSync(testPrivacyPath)) {
  console.error('FAIL: src/tests/test_m4_privacy_network.ts not found');
  process.exit(1);
}
console.log('✓ M4.5 browser privacy regression suite is present.');

console.log(
  'M4.5 static boundary checks PASSED. This source inspection does not measure wire bytes; run the browser suite and an independent deployed-origin network audit.',
);
