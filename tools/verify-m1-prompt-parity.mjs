#!/usr/bin/env node
/** Compare the browser renderer against macro.py's canonical Jinja settings. */
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'project-voice-m1-'));
const bundle = join(directory, 'renderer.cjs');
const base = {
  language: 'English',
  num: '5',
  text: 'alpha § beta 日本語 🙂 <tag> & value',
  persona: '',
  lastOutputSpeech: '',
  lastInputSpeech: '',
  conversationHistory: '',
  sentenceEmotion: '',
};
const cases = ['English', 'Japanese', 'Mandarin'].flatMap(language => [
  {...base, language},
  {...base, language, persona: 'profile <not escaped> & 人'},
  {...base, language, lastInputSpeech: '相手'},
  {...base, language, lastOutputSpeech: 'me'},
  {...base, language, conversationHistory: 'history\n履歴'},
  {...base, language, sentenceEmotion: 'question'},
  {
    ...base,
    language,
    persona: 'profile',
    lastInputSpeech: 'partner',
    lastOutputSpeech: 'me',
    conversationHistory: 'history',
    sentenceEmotion: 'question',
  },
]);
const python = String.raw`
import json, os, sys, jinja2
payload = json.load(sys.stdin)
environment = jinja2.Environment(loader=jinja2.FileSystemLoader('templates/prompts'), trim_blocks=True, lstrip_blocks=True)
print(json.dumps({prompt_id: [environment.get_template(prompt_id + '.jinja2').render(case) for case in payload['cases']] for prompt_id in payload['prompt_ids']}, ensure_ascii=False))
`;
try {
  execFileSync(
    'npx',
    [
      'esbuild',
      'src/prompt-renderer.ts',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--loader:.jinja2=text',
      `--outfile=${bundle}`,
    ],
    {stdio: 'pipe'},
  );
  const {getPromptIds, renderPrompt} = await import(bundle);
  const promptIds = getPromptIds();
  const templateIds = readdirSync('templates/prompts')
    .filter(name => name.endsWith('.jinja2'))
    .map(name => name.replace(/\.jinja2$/, ''))
    .sort();
  if (JSON.stringify([...promptIds].sort()) !== JSON.stringify(templateIds)) {
    throw new Error(
      `Bundled prompt IDs do not match canonical templates.\nbundled=${JSON.stringify(promptIds)}\ncanonical=${JSON.stringify(templateIds)}`,
    );
  }
  const languageSource = readFileSync('src/language.ts', 'utf8');
  const referencedPromptIds = Array.from(
    languageSource.matchAll(/(?:sentence|word):\s*'([^']+)'/g),
    match => match[1],
  );
  for (const referencedPromptId of referencedPromptIds) {
    if (!promptIds.includes(referencedPromptId)) {
      throw new Error(
        `Language configuration references an unbundled prompt: ${referencedPromptId}`,
      );
    }
  }
  const expected = JSON.parse(
    execFileSync('uv', ['run', 'python', '-c', python], {
      input: JSON.stringify({prompt_ids: promptIds, cases}),
      encoding: 'utf8',
    }),
  );
  for (const promptId of promptIds) {
    for (const [index, variables] of cases.entries()) {
      const actual = renderPrompt(promptId, variables);
      if (actual !== expected[promptId][index]) {
        throw new Error(
          `Prompt parity failed: ${promptId}, fixture ${index}\nexpected=${JSON.stringify(expected[promptId][index])}\nactual=${JSON.stringify(actual)}`,
        );
      }
    }
  }
  console.log(
    `M1 prompt parity passed for ${promptIds.length} templates and ${cases.length} fixtures each.`,
  );
} finally {
  rmSync(directory, {recursive: true, force: true});
}
