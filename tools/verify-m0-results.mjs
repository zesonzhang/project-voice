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

import {readFile, readdir} from 'node:fs/promises';
import {basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {verifyM0Results} from './m0-result-verifier.mjs';

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifact = JSON.parse(
  await readFile(resolve(workspace, 'docs/m0/artifact.json'), 'utf8'),
);
let paths = process.argv.slice(2).map(path => resolve(path));
if (paths.length === 0) {
  const resultsDirectory = resolve(workspace, 'docs/m0/results');
  paths = (await readdir(resultsDirectory))
    .filter(name => name.endsWith('.json'))
    .map(name => resolve(resultsDirectory, name));
}

const documents = [];
for (const path of paths) {
  documents.push([basename(path), JSON.parse(await readFile(path, 'utf8'))]);
}

const result = verifyM0Results(documents, artifact);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.passed ? 0 : 1;
