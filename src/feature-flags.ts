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

export type OnDeviceRolloutMode = 'disabled' | 'internal' | 'canary' | 'all';

export interface FeatureFlags {
  onDeviceMode: OnDeviceRolloutMode;
  debugModelImport: boolean;
  rolloutPercentage: number;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  onDeviceMode: 'all',
  debugModelImport: false,
  rolloutPercentage: 100,
};

/**
 * Computes a deterministic bucket (0-99) for a client identifier.
 */
export function hashClientIdToBucket(clientId: string): number {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = (hash << 5) - hash + clientId.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash) % 100;
}

/**
 * Evaluates whether a client is eligible for On-device mode based on rollout cohort.
 */
export function isClientInOnDeviceCohort(
  flags: FeatureFlags,
  clientId: string,
  isInternalUser = false,
): boolean {
  if (flags.onDeviceMode === 'disabled') {
    return false;
  }

  if (flags.onDeviceMode === 'internal') {
    return isInternalUser;
  }

  const bucket = hashClientIdToBucket(clientId);

  if (flags.onDeviceMode === 'canary') {
    // Canary cohort defaults to 10% bucket cap or configured percentage
    const canaryLimit = Math.min(flags.rolloutPercentage, 10);
    return bucket < canaryLimit;
  }

  // 'all' mode: evaluates percentage rollout (0 - 100)
  return bucket < flags.rolloutPercentage;
}

/**
 * Resolves safe inference mode enforcing the critical privacy rule:
 * Disabling or pausing On-device rollout must NEVER silently reroute an
 * already-installed Local user's keystrokes/prompts to Cloud Gemini.
 */
export function resolveSafeInferenceMode(
  currentMode: 'cloud' | 'local',
  isInstalledLocally: boolean,
  flags: FeatureFlags,
  clientId: string,
  isInternalUser = false,
): {
  effectiveMode: 'cloud' | 'local';
  isLocalAllowedForNewActivations: boolean;
  killSwitchActive: boolean;
  statusMessage?: string;
} {
  const allowed = isClientInOnDeviceCohort(flags, clientId, isInternalUser);
  const killSwitchActive = flags.onDeviceMode === 'disabled';

  if (currentMode === 'local') {
    // CRITICAL PRIVACY INVARIANT:
    // If the user already installed the model and chose Local mode,
    // they retain Local mode regardless of rollout flag changes.
    // Keystrokes are NEVER silently redirected to Cloud.
    return {
      effectiveMode: 'local',
      isLocalAllowedForNewActivations: allowed,
      killSwitchActive,
      statusMessage: !allowed
        ? 'On-device inference is paused for new activations; your installed local model remains active offline.'
        : undefined,
    };
  }

  // Current mode is cloud (default)
  return {
    effectiveMode: 'cloud',
    isLocalAllowedForNewActivations: allowed,
    killSwitchActive,
  };
}

/**
 * Client-side feature flags manager that fetches and caches server flags.
 */
export class FeatureFlagsManager {
  private flags: FeatureFlags = {...DEFAULT_FEATURE_FLAGS};
  private fetchPromise: Promise<FeatureFlags> | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = typeof fetch !== 'undefined'
      ? fetch
      : (null as unknown as typeof fetch),
  ) {}

  getFlags(): FeatureFlags {
    return this.flags;
  }

  setFlags(flags: Partial<FeatureFlags>): void {
    this.flags = {...this.flags, ...flags};
  }

  async fetchFlags(forceRefresh = false): Promise<FeatureFlags> {
    if (!forceRefresh && this.fetchPromise) {
      return this.fetchPromise;
    }

    this.fetchPromise = (async () => {
      try {
        const response = await this.fetchImpl('/api/features');
        if (response.ok) {
          const data = (await response.json()) as Partial<FeatureFlags>;
          this.flags = {
            onDeviceMode: data.onDeviceMode || 'all',
            debugModelImport: !!data.debugModelImport,
            rolloutPercentage:
              typeof data.rolloutPercentage === 'number'
                ? data.rolloutPercentage
                : 100,
          };
        }
      } catch {
        // Retain current/default flags on fetch failure
      }
      return this.flags;
    })();

    return this.fetchPromise;
  }
}
