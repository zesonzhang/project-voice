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

import {BrowserTabCoordinator} from '../on-device/tab-coordinator.js';

describe('BrowserTabCoordinator', () => {
  const originalLocks = navigator.locks;

  afterEach(() => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: originalLocks,
    });
  });

  it('propagates a queued Web Lock rejection after contention', async () => {
    let requestCount = 0;
    const expectedError = new Error('lock service failed');
    const fakeLocks = {
      request: async (
        _name: string,
        optionsOrCallback: LockOptions | ((lock: Lock | null) => unknown),
        maybeCallback?: (lock: Lock | null) => unknown,
      ) => {
        requestCount++;
        if (typeof optionsOrCallback !== 'function') {
          return await maybeCallback?.(null);
        }
        throw expectedError;
      },
    };
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: fakeLocks,
    });

    const coordinator = new BrowserTabCoordinator();
    let contended = false;
    let caught: unknown;
    try {
      await coordinator.acquireDownloadLock(
        'model',
        'v1',
        async () => 'done',
        () => {
          contended = true;
        },
      );
    } catch (error) {
      caught = error;
    } finally {
      coordinator.close();
    }

    expect(requestCount).toBe(2);
    expect(contended).toBeTrue();
    expect(caught).toBe(expectedError);
  });
});
