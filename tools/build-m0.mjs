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

import {copyFile, mkdir, readFile, readdir} from 'node:fs/promises';

import {build} from 'esbuild';

const common = {
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ['chrome120'],
};

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/m0/index.ts'],
    format: 'esm',
    outfile: 'static/m0.js',
  }),
  build({
    ...common,
    entryPoints: ['src/m0/inference-worker.ts'],
    format: 'iife',
    outfile: 'static/m0-inference-worker.js',
  }),
]);

const wasmSource = 'node_modules/@litert-lm/core/wasm';
const wasmTarget = 'static/vendor/litert-lm/wasm';
await mkdir(wasmTarget, {recursive: true});
const wasmEntries = await readdir(wasmSource, {withFileTypes: true});
for (const entry of wasmEntries) {
  if (!entry.isFile()) continue;
  await copyFile(`${wasmSource}/${entry.name}`, `${wasmTarget}/${entry.name}`);
  if (entry.name.endsWith('.wasm')) {
    // Emscripten resolves binaries relative to the classic Worker's URL,
    // even though its loader script is imported from the vendor directory.
    await copyFile(`${wasmSource}/${entry.name}`, `static/${entry.name}`);
  }
}

const workerBundle = await readFile('static/m0-inference-worker.js', 'utf8');
const unusedUpstreamDefault =
  'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.15.0/wasm';
const workerWithoutUnusedDefault = workerBundle.replaceAll(
  unusedUpstreamDefault,
  '',
);
if (!workerBundle.includes('/static/vendor/litert-lm/wasm/')) {
  throw new Error(
    'M0 Worker does not contain the required same-origin Wasm path.',
  );
}
for (const forbiddenRuntimeHost of ['cdn.jsdelivr.net', 'unpkg.com']) {
  if (workerWithoutUnusedDefault.includes(forbiddenRuntimeHost)) {
    throw new Error(
      `M0 Worker contains forbidden runtime CDN: ${forbiddenRuntimeHost}`,
    );
  }
}
