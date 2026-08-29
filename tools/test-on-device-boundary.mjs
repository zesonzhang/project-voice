/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {access, readFile} from 'node:fs/promises';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const gcloudIgnore = await readFile('.gcloudignore', 'utf8');
const localProvider = await readFile(
  'src/local-suggestion-provider.ts',
  'utf8',
);

await expectMissing('src/m0');
assertDoesNotContain(packageJson.scripts.build, 'build:m0', 'build script');
assertDoesNotContain(packageJson.scripts.watch, 'build:m0', 'watch script');
assertDoesNotContain(localProvider, "'./m0/", 'Local provider');
assertDoesNotContain(localProvider, "'./tests/", 'Local provider');

for (const ignoredPath of [
  '/tools/m0-harness',
  '/templates/m0.jinja',
  '/static/m0.js',
  '/static/m0-inference-worker.js',
  '/static/litertlm_wasm_*.wasm',
]) {
  if (!gcloudIgnore.split('\n').includes(ignoredPath)) {
    throw new Error(`.gcloudignore must exclude ${ignoredPath}`);
  }
}

console.log('On-device production boundary checks passed.');

async function expectMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${path} must not exist; M0 belongs under tools/.`);
}

function assertDoesNotContain(value, forbidden, label) {
  if (value.includes(forbidden)) {
    throw new Error(`${label} must not contain ${forbidden}`);
  }
}
