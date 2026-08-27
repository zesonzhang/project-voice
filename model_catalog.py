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
"""Model catalog and signed URL generator for on-device models."""

import datetime
import json
import logging
import os
from typing import Any, Callable, Dict, Optional

from google.cloud import storage

from model_manifest import (
    ManifestValidationError,
    get_public_manifest,
    validate_manifest,
)

logger = logging.getLogger(__name__)

# Example/test fixture only. ModelCatalog never loads this implicitly; deployed
# model bindings must come from ON_DEVICE_MODEL_CONFIG_JSON or a config path.
EXAMPLE_MODEL_CONFIG: Dict[str, Any] = {
    'schemaVersion':
        1,
    'modelId':
        'gemma-web-default',
    'version':
        '2026-08-01',
    'displayName':
        'Gemma 4 E2B IT Web',
    'family':
        'gemma',
    'adapterId':
        'litert-lm',
    'format':
        'litertlm',
    'sizeBytes':
        2008432640,
    'sha256':
        '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5',
    'gcsGeneration':
        '1738700000000000',
    'gcsBucket':
        'project-voice-models',
    'gcsObject':
        'models/gemma-4-E2B-it-web.litertlm',
    'capabilities': {
        'textGeneration': True,
        'languages': ['en', 'ja', 'zh', 'fr', 'de', 'sv'],
        'maxInputTokens': 4096,
        'maxOutputTokens': 256,
    },
    'requirements': {
        'webgpu': True,
        'minimumDeviceMemoryGB': 8,
        'minimumFreeStorageBytes': 2500000000,
    },
    'generation': {
        'temperature': 0,
        'topP': 0.5,
        'maxOutputTokens': 256,
    },
}


class ModelCatalogError(Exception):
  """Base exception for model catalog operations."""
  pass


class ModelNotFoundError(ModelCatalogError):
  """Raised when a requested model ID is not configured."""
  pass


class InvalidModelVersionError(ModelCatalogError):
  """Raised when a requested model version is invalid or does not match."""
  pass


class ModelCatalog:
  """Manages configured on-device models and URL signing."""

  def __init__(
      self,
      config_dict: Optional[Dict[str, Any]] = None,
      config_path: Optional[str] = None,
      url_signer: Optional[Callable[[Dict[str, Any], datetime.datetime],
                                    str]] = None):
    self._models: Dict[str, Dict[str, Any]] = {}
    self._default_model_id: Optional[str] = None
    self._url_signer = url_signer or self._generate_gcs_v4_signed_url
    self._load_and_validate_config(config_dict, config_path)

  def _load_and_validate_config(self, config_dict: Optional[Dict[str, Any]],
                                config_path: Optional[str]):
    raw_config = None

    env_config_json = os.environ.get('ON_DEVICE_MODEL_CONFIG_JSON')
    env_config_path = os.environ.get(
        'ON_DEVICE_MODEL_CONFIG_PATH') or config_path

    if config_dict is not None:
      raw_config = config_dict
    elif env_config_json:
      raw_config = json.loads(env_config_json)
    elif env_config_path:
      if not os.path.isfile(env_config_path):
        raise ManifestValidationError(
            f'Model catalog config path does not exist: {env_config_path}')
      with open(env_config_path, 'r', encoding='utf-8') as f:
        raw_config = json.load(f)
    else:
      # Production model metadata must be deployment-configured. Silently
      # falling back to a source-controlled bucket/object can sign the wrong
      # artifact after a deployment or model rotation.
      raw_config = {'defaultModelId': None, 'models': []}

    if not isinstance(raw_config, dict):
      raise ManifestValidationError(
          'Catalog configuration must be a dictionary')

    unknown_keys = set(raw_config) - {'defaultModelId', 'models'}
    if unknown_keys:
      raise ManifestValidationError(
          f'Unknown keys in catalog configuration: {sorted(unknown_keys)}')

    configured_models = raw_config.get('models', [])
    if not isinstance(configured_models, list):
      raise ManifestValidationError('Catalog "models" must be a list')

    for model_entry in configured_models:
      validated = validate_manifest(model_entry, allow_private_fields=True)
      m_id = validated['modelId']
      if m_id in self._models:
        raise ManifestValidationError(f'Duplicate configured modelId: {m_id}')
      if not validated.get('gcsBucket') or not validated.get('gcsObject'):
        raise ManifestValidationError(
            f'Model "{m_id}" must configure gcsBucket and gcsObject')
      self._models[m_id] = validated

    default_id = raw_config.get('defaultModelId')
    if default_id:
      if default_id not in self._models:
        raise ManifestValidationError(
            f'defaultModelId "{default_id}" not found in configured models')
      self._default_model_id = default_id
    elif self._models:
      raise ManifestValidationError(
          'defaultModelId is required when models are configured')

    logger.info(
        'ModelCatalog initialized with %d models. Default model: %s',
        len(self._models),
        self._default_model_id,
    )

  def get_default_manifest(self) -> Dict[str, Any]:
    """Returns the public manifest for the default on-device model."""
    if not self._default_model_id or self._default_model_id not in self._models:
      raise ModelNotFoundError('No default on-device model configured')
    return get_public_manifest(self._models[self._default_model_id])

  def get_model(self, model_id: str) -> Dict[str, Any]:
    """Returns the internal model configuration."""
    if model_id not in self._models:
      raise ModelNotFoundError(f'Model "{model_id}" not found')
    return self._models[model_id]

  def generate_signed_download_url(
      self,
      model_id: str,
      version: str,
  ) -> Dict[str, Any]:
    """Generates a generation-pinned signed download URL with 1-hour TTL.

    Args:
      model_id: Target model ID.
      version: Requested version (must match configured model version).
    Returns:
      Dictionary with url, expiresAt, sizeBytes, sha256, gcsGeneration.
    """
    model = self.get_model(model_id)
    if model['version'] != version:
      raise InvalidModelVersionError(
          f'Requested version "{version}" does not match configured version "{model["version"]}"'
      )

    now = datetime.datetime.now(datetime.timezone.utc)
    expires_at = now + datetime.timedelta(hours=1)
    expires_iso = expires_at.strftime('%Y-%m-%dT%H:%M:%SZ')

    generation = model['gcsGeneration']
    signed_url = self._url_signer(model, expires_at)

    # Log generation of signed URL with URL strictly redacted
    logger.info(
        'Generated signed download URL for model_id=%s version=%s generation=%s expiresAt=%s [URL REDACTED]',
        model_id,
        version,
        generation,
        expires_iso,
    )

    return {
        'url': signed_url,
        'expiresAt': expires_iso,
        'sizeBytes': model['sizeBytes'],
        'sha256': model['sha256'],
        'gcsGeneration': generation,
    }

  @staticmethod
  def _generate_gcs_v4_signed_url(model: Dict[str, Any],
                                  expires_at: datetime.datetime) -> str:
    """Generate a GCS-verifiable V4 URL pinned to one immutable generation."""
    client = storage.Client()
    blob = client.bucket(model['gcsBucket']).blob(
        model['gcsObject'], generation=int(model['gcsGeneration']))
    return blob.generate_signed_url(
        version='v4',
        expiration=expires_at,
        method='GET',
        query_parameters={'generation': model['gcsGeneration']},
    )


# Validate deployment configuration while the application starts, rather than
# deferring failures until the first request.
_catalog_instance: Optional[ModelCatalog] = ModelCatalog()


def get_catalog() -> ModelCatalog:
  global _catalog_instance
  if _catalog_instance is None:
    _catalog_instance = ModelCatalog()
  return _catalog_instance


def reset_catalog_for_testing(catalog: Optional[ModelCatalog] = None) -> None:
  global _catalog_instance
  _catalog_instance = catalog
