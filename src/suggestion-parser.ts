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

/**
 * Normalizes input text for on-device and parity prompting.
 */
export function normalizeLocalInput(
  text: string,
  language: string,
  promptId: string,
): string {
  let normalized = language === 'Japanese' ? text.replaceAll(' ', '§') : text;
  if (promptId === 'WordGeneric20240628') {
    normalized = normalized.replaceAll(' ', '§').replace(/§$/, ' ');
  }
  return normalized;
}

/**
 * Parses raw LLM suggestion output into a deduplicated list of clean suggestion strings.
 */
export function parseSuggestionResponse(
  response: string,
  language: string,
  num = 5,
): string[] {
  let cleaned = response.replaceAll('\\\n', '').replaceAll('*', '');
  if (language === 'Japanese') {
    // Match macro.py's ASCII-mode removal of half-width spaces in Japanese.
    cleaned = cleaned.replace(/([^\w;:,.?]) +(\W)/g, '$1$2');
  }
  cleaned = cleaned.replaceAll('§', ' ');
  return Array.from(
    new Set(
      cleaned
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^\d+\./.test(line))
        .map(line => line.replace(/^\d+\.\s?/, '')),
    ),
  ).slice(0, num);
}
