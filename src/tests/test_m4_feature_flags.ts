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

import {
  DEFAULT_FEATURE_FLAGS,
  FeatureFlags,
  FeatureFlagsManager,
  hashClientIdToBucket,
  isClientInOnDeviceCohort,
  resolveSafeInferenceMode,
} from '../feature-flags.js';

describe('M4.10 Feature-Flag and Rollout Controls', () => {
  it('defaults to Cloud mode, disables debug import, and enables general cohort', () => {
    expect(DEFAULT_FEATURE_FLAGS.onDeviceMode).toBe('all');
    expect(DEFAULT_FEATURE_FLAGS.debugModelImport).toBeFalse();
    expect(DEFAULT_FEATURE_FLAGS.rolloutPercentage).toBe(100);
  });

  it('computes deterministic client buckets across repeated calls', () => {
    const bucketA1 = hashClientIdToBucket('client-alpha');
    const bucketA2 = hashClientIdToBucket('client-alpha');
    const bucketB = hashClientIdToBucket('client-beta');

    expect(bucketA1).toBe(bucketA2);
    expect(bucketA1).toBeGreaterThanOrEqual(0);
    expect(bucketA1).toBeLessThan(100);
    expect(bucketB).toBeGreaterThanOrEqual(0);
    expect(bucketB).toBeLessThan(100);
  });

  it('correctly filters cohorts across disabled, internal, canary, and percentage rollouts', () => {
    const disabledFlags: FeatureFlags = {
      onDeviceMode: 'disabled',
      debugModelImport: false,
      rolloutPercentage: 100,
    };
    expect(
      isClientInOnDeviceCohort(disabledFlags, 'any-client', true),
    ).toBeFalse();

    const internalFlags: FeatureFlags = {
      onDeviceMode: 'internal',
      debugModelImport: false,
      rolloutPercentage: 100,
    };
    expect(
      isClientInOnDeviceCohort(internalFlags, 'client-1', false),
    ).toBeFalse();
    expect(
      isClientInOnDeviceCohort(internalFlags, 'client-1', true),
    ).toBeTrue();

    const canaryFlags: FeatureFlags = {
      onDeviceMode: 'canary',
      debugModelImport: false,
      rolloutPercentage: 10,
    };
    // Canary restricts to bucket < 10
    const results = [
      'c1',
      'c2',
      'c3',
      'c4',
      'c5',
      'c6',
      'c7',
      'c8',
      'c9',
      'c10',
    ].map(id => isClientInOnDeviceCohort(canaryFlags, id));
    expect(results).toContain(true);
  });

  it('STRICT PRIVACY INVARIANT: never silently routes installed Local users to Cloud when rollout is disabled', () => {
    const killSwitchedFlags: FeatureFlags = {
      onDeviceMode: 'disabled',
      debugModelImport: false,
      rolloutPercentage: 0,
    };

    // Case 1: Existing user already has a local model installed and active
    const localResolution = resolveSafeInferenceMode(
      'local',
      true, // model installed
      killSwitchedFlags,
      'test-client-123',
    );

    // MUST remain local!
    expect(localResolution.effectiveMode).toBe('local');
    expect(localResolution.killSwitchActive).toBeTrue();
    expect(localResolution.isLocalAllowedForNewActivations).toBeFalse();
    expect(localResolution.statusMessage).toContain('remains active offline');

    // Case 2: New user in Cloud mode attempting to use local mode
    const cloudResolution = resolveSafeInferenceMode(
      'cloud',
      false, // not installed
      killSwitchedFlags,
      'test-client-123',
    );
    expect(cloudResolution.effectiveMode).toBe('cloud');
    expect(cloudResolution.isLocalAllowedForNewActivations).toBeFalse();
  });

  it('fetches server feature flags and parses cohort configurations', async () => {
    const mockFetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/features');
      return new Response(
        JSON.stringify({
          onDeviceMode: 'canary',
          debugModelImport: true,
          rolloutPercentage: 15,
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      );
    }) as unknown as typeof fetch;

    const manager = new FeatureFlagsManager(mockFetch);
    const flags = await manager.fetchFlags();

    expect(flags.onDeviceMode).toBe('canary');
    expect(flags.debugModelImport).toBeTrue();
    expect(flags.rolloutPercentage).toBe(15);
  });
});
