import {copyFile, mkdir, readdir} from 'node:fs/promises';
import {build, context} from 'esbuild';

import './build-worker.mjs';

// LiteRT-LM 0.15 resolves the binary relative to the classic Worker's URL,
// even when its JS loader is imported from the vendor directory.
await mkdir('static/litert-debug', {recursive: true});
for (const name of await readdir('node_modules/@litert-lm/core/wasm')) {
  if (name.endsWith('.wasm')) {
    await copyFile(
      `node_modules/@litert-lm/core/wasm/${name}`,
      `static/litert-debug/${name}`,
    );
  }
}
const options = {bundle: true, sourcemap: true, target: ['chrome120']};
const entries = [
  {
    ...options,
    entryPoints: ['src/litert-debug/index.ts'],
    loader: {'.jinja2': 'text'},
    outfile: 'static/litert-debug/index.js',
  },
  {
    ...options,
    entryPoints: ['src/on-device/inference-worker.ts'],
    format: 'iife',
    outfile: 'static/litert-debug/worker.js',
  },
];
for (const entry of entries) {
  if (process.argv.includes('--watch')) await (await context(entry)).watch();
  else await build(entry);
}
