# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Model manifest schema validation and definitions for on-device models."""

import copy
import math
import re
from typing import Any, Dict, List

ALLOWED_SCHEMA_VERSIONS = {1}
ALLOWED_FAMILIES = {'gemma'}
ALLOWED_ADAPTERS = {'litert-lm'}
ALLOWED_FORMATS = {'litertlm'}
ALLOWED_LANGUAGES = {'en', 'ja', 'zh', 'fr', 'de', 'sv'}

MODEL_ID_REGEX = re.compile(r'^[a-z0-9\-]+$')
VERSION_REGEX = re.compile(r'^[a-z0-9.\-]+$')
SHA256_REGEX = re.compile(r'^[a-f0-9]{64}$')
GCS_GENERATION_REGEX = re.compile(r'^[0-9]+$')

PUBLIC_TOP_LEVEL_KEYS = {
    'schemaVersion',
    'modelId',
    'version',
    'displayName',
    'family',
    'adapterId',
    'format',
    'sizeBytes',
    'sha256',
    'gcsGeneration',
    'capabilities',
    'requirements',
    'generation',
}

NESTED_KEYS = {
    'capabilities': {
        'textGeneration', 'languages', 'maxInputTokens', 'maxOutputTokens'
    },
    'requirements': {
        'webgpu', 'minimumDeviceMemoryGB', 'minimumFreeStorageBytes'
    },
    'generation': {'temperature', 'topP', 'maxOutputTokens'},
}


class ManifestValidationError(ValueError):
  """Raised when a model manifest fails schema or security validation."""
  pass


def validate_manifest(raw: Dict[str, Any],
                      allow_private_fields: bool = False) -> Dict[str, Any]:
  """Validates a model manifest dictionary.

  Args:
    raw: Raw manifest dictionary to validate.
    allow_private_fields: If True, allows private server-only fields (gcsBucket, gcsObject).

  Returns:
    A normalized copy of the validated manifest dictionary.

  Raises:
    ManifestValidationError: If the manifest fails schema or safety rules.
  """
  if not isinstance(raw, dict):
    raise ManifestValidationError('Manifest must be a dictionary')

  allowed_keys = set(PUBLIC_TOP_LEVEL_KEYS)
  if allow_private_fields:
    allowed_keys.update({'gcsBucket', 'gcsObject'})

  unknown_keys = set(raw.keys()) - allowed_keys
  if unknown_keys:
    raise ManifestValidationError(
        f'Unknown keys in manifest: {sorted(unknown_keys)}')

  for section, section_keys in NESTED_KEYS.items():
    value = raw.get(section)
    if isinstance(value, dict):
      unknown_nested = set(value) - section_keys
      if unknown_nested:
        raise ManifestValidationError(
            f'Unknown keys in {section}: {sorted(unknown_nested)}')

  # Check for prohibited executable or URL fields
  for key, value in raw.items():
    if isinstance(value, str) and ('http://' in value or 'https://' in value or
                                   'javascript:' in value):
      raise ManifestValidationError(
          f'Field "{key}" must not contain URL schemes')

  # 1. schemaVersion
  schema_version = raw.get('schemaVersion')
  if type(schema_version
         ) is not int or schema_version not in ALLOWED_SCHEMA_VERSIONS:
    raise ManifestValidationError(
        f'Invalid or unsupported schemaVersion: {schema_version}')

  # 2. modelId
  model_id = raw.get('modelId')
  if not isinstance(model_id, str) or not MODEL_ID_REGEX.match(model_id):
    raise ManifestValidationError(f'Invalid modelId: {model_id}')

  # 3. version
  version = raw.get('version')
  if not isinstance(version, str) or not VERSION_REGEX.match(version):
    raise ManifestValidationError(f'Invalid version: {version}')

  # 4. displayName
  display_name = raw.get('displayName')
  if not isinstance(display_name, str) or not display_name.strip():
    raise ManifestValidationError('displayName must be a non-empty string')

  # 5. family
  family = raw.get('family')
  if not isinstance(family, str) or family not in ALLOWED_FAMILIES:
    raise ManifestValidationError(f'Unsupported model family: {family}')

  # 6. adapterId
  adapter_id = raw.get('adapterId')
  if not isinstance(adapter_id, str) or adapter_id not in ALLOWED_ADAPTERS:
    raise ManifestValidationError(
        f'Unsupported or dangerous adapterId: {adapter_id}')

  # 7. format
  model_format = raw.get('format')
  if not isinstance(model_format, str) or model_format not in ALLOWED_FORMATS:
    raise ManifestValidationError(f'Unsupported model format: {model_format}')

  # 8. sizeBytes
  size_bytes = raw.get('sizeBytes')
  if type(
      size_bytes) is not int or size_bytes <= 0 or size_bytes > 20_000_000_000:
    raise ManifestValidationError(
        f'sizeBytes must be between 1 and 20,000,000,000: {size_bytes}')

  # 9. sha256
  sha256 = raw.get('sha256')
  if not isinstance(sha256, str):
    raise ManifestValidationError('sha256 must be a string')
  sha256_lower = sha256.lower()
  if not SHA256_REGEX.match(sha256_lower):
    raise ManifestValidationError(
        f'sha256 must be a 64-character hex digest: {sha256}')

  # 10. gcsGeneration
  gcs_generation = raw.get('gcsGeneration')
  if not isinstance(gcs_generation,
                    str) or not GCS_GENERATION_REGEX.match(gcs_generation):
    raise ManifestValidationError(
        f'gcsGeneration must be a non-empty numeric string: {gcs_generation}')

  # 11. capabilities
  capabilities = raw.get('capabilities')
  if not isinstance(capabilities, dict):
    raise ManifestValidationError('capabilities must be a dictionary')
  if not capabilities.get('textGeneration') is True:
    raise ManifestValidationError('capabilities.textGeneration must be True')
  languages = capabilities.get('languages')
  if not isinstance(languages, list) or not languages:
    raise ManifestValidationError(
        'capabilities.languages must be a non-empty list')
  for lang in languages:
    if not isinstance(lang, str) or lang not in ALLOWED_LANGUAGES:
      raise ManifestValidationError(
          f'capabilities.languages contains unsupported language: {lang}')
  max_input_tokens = capabilities.get('maxInputTokens')
  if type(max_input_tokens) is not int or max_input_tokens <= 0:
    raise ManifestValidationError(
        'capabilities.maxInputTokens must be a positive integer')
  max_output_tokens = capabilities.get('maxOutputTokens')
  if type(max_output_tokens) is not int or max_output_tokens <= 0:
    raise ManifestValidationError(
        'capabilities.maxOutputTokens must be a positive integer')

  # 12. requirements
  requirements = raw.get('requirements')
  if not isinstance(requirements, dict):
    raise ManifestValidationError('requirements must be a dictionary')
  if not requirements.get('webgpu') is True:
    raise ManifestValidationError('requirements.webgpu must be True')
  min_ram = requirements.get('minimumDeviceMemoryGB')
  if (isinstance(min_ram, bool) or not isinstance(min_ram, (int, float)) or
      not math.isfinite(min_ram) or min_ram <= 0):
    raise ManifestValidationError(
        'requirements.minimumDeviceMemoryGB must be positive')
  min_storage = requirements.get('minimumFreeStorageBytes')
  if type(min_storage) is not int or min_storage < size_bytes:
    raise ManifestValidationError(
        f'requirements.minimumFreeStorageBytes ({min_storage}) must be >= sizeBytes ({size_bytes})'
    )

  # 13. generation
  generation = raw.get('generation')
  if not isinstance(generation, dict):
    raise ManifestValidationError('generation must be a dictionary')
  temp = generation.get('temperature')
  if (isinstance(temp, bool) or not isinstance(temp, (int, float)) or
      not math.isfinite(temp) or temp < 0.0 or temp > 2.0):
    raise ManifestValidationError(
        'generation.temperature must be between 0.0 and 2.0')
  top_p = generation.get('topP')
  if (isinstance(top_p, bool) or not isinstance(top_p, (int, float)) or
      not math.isfinite(top_p) or top_p < 0.0 or top_p > 1.0):
    raise ManifestValidationError('generation.topP must be between 0.0 and 1.0')
  gen_max_output = generation.get('maxOutputTokens')
  if type(gen_max_output) is not int or gen_max_output <= 0:
    raise ManifestValidationError(
        'generation.maxOutputTokens must be a positive integer')

  # Private fields validation if allowed
  if allow_private_fields:
    gcs_bucket = raw.get('gcsBucket')
    if gcs_bucket is not None and (not isinstance(gcs_bucket, str) or
                                   not gcs_bucket.strip()):
      raise ManifestValidationError('gcsBucket must be a non-empty string')
    gcs_object = raw.get('gcsObject')
    if gcs_object is not None and (not isinstance(gcs_object, str) or
                                   not gcs_object.strip()):
      raise ManifestValidationError('gcsObject must be a non-empty string')

  validated = copy.deepcopy(raw)
  validated['sha256'] = sha256_lower
  return validated


def get_public_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
  """Strips private backend-only fields from a manifest before returning to clients."""
  return {
      k: copy.deepcopy(v)
      for k, v in manifest.items()
      if k in PUBLIC_TOP_LEVEL_KEYS
  }
