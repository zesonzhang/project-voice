/**
 * Identity used while no administrator-provided on-device model manifest has
 * been loaded. M2 will replace this placeholder with the validated manifest
 * identity; production code must not depend on the M0 feasibility candidate.
 */
export const UNCONFIGURED_LOCAL_MODEL_IDENTITY = {
  modelId: 'on-device',
  modelVersion: 'unconfigured',
} as const;
