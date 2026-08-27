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

import {parseNumberedSuggestions} from '../../tools/m0-harness/parse-output.js';
import {
  CANDIDATE_MODEL,
  isM0WorkerRequest,
  M0_PROTOCOL_VERSION,
} from '../../tools/m0-harness/protocol.js';

describe('M0 feasibility harness', () => {
  describe('Worker protocol', () => {
    it('accepts a valid generation request', () => {
      expect(
        isM0WorkerRequest({
          protocolVersion: M0_PROTOCOL_VERSION,
          requestId: 'request-1',
          type: 'GENERATE',
          sequenceId: 3,
          prompt: 'not exported',
          maxOutputTokens: 64,
          temperature: 0,
          topP: 0.95,
        }),
      ).toBeTrue();
    });

    it('rejects unknown protocol versions and malformed payloads', () => {
      expect(
        isM0WorkerRequest({
          protocolVersion: 2,
          requestId: 'request-1',
          type: 'LOAD_MODEL',
        }),
      ).toBeFalse();
      expect(
        isM0WorkerRequest({
          protocolVersion: M0_PROTOCOL_VERSION,
          requestId: 'request-2',
          type: 'GENERATE',
          sequenceId: '3',
        }),
      ).toBeFalse();
    });

    it('pins the candidate to an immutable source and exact metadata', () => {
      expect(CANDIDATE_MODEL.url).toContain(CANDIDATE_MODEL.repositoryCommit);
      expect(CANDIDATE_MODEL.byteSize).toBe(2008432640);
      expect(CANDIDATE_MODEL.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('numbered output parsing', () => {
    it('normalizes, deduplicates, and limits suggestions', () => {
      expect(
        parseNumberedSuggestions(
          'Introduction\n1. Apple\\\n pie\n2. Banana\n3. Apple\n4. Pear',
          3,
        ),
      ).toEqual(['Apple pie', 'Banana', 'Apple']);
    });

    it('returns no suggestion until a complete numbered line appears', () => {
      expect(parseNumberedSuggestions('Thinking…')).toEqual([]);
      expect(parseNumberedSuggestions('1.')).toEqual([]);
      expect(parseNumberedSuggestions('1. ready')).toEqual(['ready']);
    });
  });
});
