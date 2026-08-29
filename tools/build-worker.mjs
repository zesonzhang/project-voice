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

import {copyFile, mkdir, readdir} from 'node:fs/promises';
import {build} from 'esbuild';

const common = {
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ['chrome120'],
};

await build({
  ...common,
  entryPoints: ['src/on-device/inference-worker.ts'],
  format: 'iife',
  outfile: 'static/inference-worker.js',
});

const wasmSource = 'node_modules/@litert-lm/core/wasm';
const wasmTarget = 'static/vendor/litert-lm/wasm';
await mkdir(wasmTarget, {recursive: true});
const wasmEntries = await readdir(wasmSource, {withFileTypes: true});
for (const entry of wasmEntries) {
  if (!entry.isFile()) continue;
  await copyFile(`${wasmSource}/${entry.name}`, `${wasmTarget}/${entry.name}`);
  if (entry.name.endsWith('.wasm')) {
    await copyFile(`${wasmSource}/${entry.name}`, `static/${entry.name}`);
  }
}

console.log('Successfully built static/inference-worker.js and synced Wasm assets.');
