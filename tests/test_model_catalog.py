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
"""Tests for model manifest validation, model catalog, and backend APIs."""

import copy
import datetime
import logging
import re
import pytest

import main
from model_catalog import (
    EXAMPLE_MODEL_CONFIG as DEFAULT_FROZEN_MODEL_CONFIG,
    InvalidModelVersionError,
    ModelCatalog,
    ModelNotFoundError,
    reset_catalog_for_testing,
)
from model_manifest import (
    ManifestValidationError,
    get_public_manifest,
    validate_manifest,
)


def fake_url_signer(model, expires_at):
  del expires_at
  return (
      f'https://storage.googleapis.com/{model["gcsBucket"]}/{model["gcsObject"]}'
      f'?generation={model["gcsGeneration"]}'
      '&X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=test-signature')


def configured_catalog(config_dict=None):
  if config_dict is None:
    config_dict = {
        'defaultModelId': DEFAULT_FROZEN_MODEL_CONFIG['modelId'],
        'models': [copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)],
    }
  return ModelCatalog(config_dict=config_dict, url_signer=fake_url_signer)


@pytest.fixture(autouse=True)
def reset_catalog():
  reset_catalog_for_testing(configured_catalog())
  yield
  reset_catalog_for_testing(None)


def test_valid_manifest_passes_validation():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  validated = validate_manifest(manifest, allow_private_fields=True)
  assert validated['modelId'] == 'gemma-web-default'
  assert validated['version'] == '2026-08-01'
  assert validated['sizeBytes'] == 2008432640


def test_public_manifest_strips_private_fields():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  public = get_public_manifest(manifest)
  assert 'gcsBucket' not in public
  assert 'gcsObject' not in public
  assert 'modelId' in public
  assert 'sha256' in public
  assert 'gcsGeneration' in public


def test_manifest_rejects_unknown_fields():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['unknownProperty'] = 'bad'
  with pytest.raises(ManifestValidationError, match='Unknown keys in manifest'):
    validate_manifest(manifest, allow_private_fields=True)


def test_manifest_rejects_urls_in_manifest():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['displayName'] = 'https://malicious-site.com/exploit'
  with pytest.raises(
      ManifestValidationError, match='must not contain URL schemes'):
    validate_manifest(manifest, allow_private_fields=True)


def test_manifest_rejects_invalid_schema_version():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['schemaVersion'] = 99
  with pytest.raises(
      ManifestValidationError, match='Invalid or unsupported schemaVersion'):
    validate_manifest(manifest, allow_private_fields=True)


def test_manifest_rejects_invalid_adapter():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['adapterId'] = 'custom-exec-adapter'
  with pytest.raises(
      ManifestValidationError, match='Unsupported or dangerous adapterId'):
    validate_manifest(manifest, allow_private_fields=True)


def test_manifest_rejects_negative_or_oversized_bytes():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['sizeBytes'] = -10
  with pytest.raises(
      ManifestValidationError, match='sizeBytes must be between'):
    validate_manifest(manifest, allow_private_fields=True)


def test_manifest_rejects_malformed_sha256():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['sha256'] = 'not-a-valid-sha'
  with pytest.raises(
      ManifestValidationError,
      match='sha256 must be a 64-character hex digest'):
    validate_manifest(manifest, allow_private_fields=True)


def test_manifest_rejects_unsupported_language():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['capabilities']['languages'].append('klingon')
  with pytest.raises(ManifestValidationError, match='unsupported language'):
    validate_manifest(manifest, allow_private_fields=True)


def test_manifest_rejects_insufficient_storage_bound():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['requirements'][
      'minimumFreeStorageBytes'] = manifest['sizeBytes'] - 1
  with pytest.raises(ManifestValidationError, match='must be >= sizeBytes'):
    validate_manifest(manifest, allow_private_fields=True)


def test_manifest_rejects_out_of_bound_temperature():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['generation']['temperature'] = 3.5
  with pytest.raises(
      ManifestValidationError, match='temperature must be between 0.0 and 2.0'):
    validate_manifest(manifest, allow_private_fields=True)


def test_model_catalog_initialization_and_default_model():
  catalog = configured_catalog()
  manifest = catalog.get_default_manifest()
  assert manifest['modelId'] == 'gemma-web-default'
  assert 'gcsBucket' not in manifest
  assert manifest['sizeBytes'] == 2008432640


def test_model_catalog_generate_signed_download_url():
  catalog = configured_catalog()
  signed = catalog.generate_signed_download_url('gemma-web-default',
                                                '2026-08-01')
  assert 'url' in signed
  assert 'generation=' in signed['url']
  assert 'X-Goog-Algorithm=GOOG4-RSA-SHA256' in signed['url']
  assert 'X-Goog-Signature=' in signed['url']
  assert signed['gcsGeneration'] == '1738700000000000'
  assert signed['sizeBytes'] == 2008432640
  assert 'T' in signed['expiresAt']


def test_model_catalog_rejects_mismatched_version():
  catalog = configured_catalog()
  with pytest.raises(
      InvalidModelVersionError, match='does not match configured version'):
    catalog.generate_signed_download_url('gemma-web-default', '9999-99-99')


def test_model_catalog_rejects_unknown_model():
  catalog = configured_catalog()
  with pytest.raises(ModelNotFoundError, match='not found'):
    catalog.generate_signed_download_url('non-existent-model', '2026-08-01')


@pytest.fixture
def csrf_client():
  client = main.app.test_client()
  client.get('/')
  cookie = client.get_cookie('_csrf_token')
  client.environ_base['HTTP_X_CSRFTOKEN'] = cookie.value if cookie else ''
  return client


def test_api_get_default_model():
  client = main.app.test_client()
  response = client.get('/api/on-device-models/default')
  assert response.status_code == 200
  assert response.headers['Cache-Control'] == 'public, max-age=300'
  data = response.get_json()
  assert data['modelId'] == 'gemma-web-default'
  assert data['schemaVersion'] == 1
  assert 'gcsBucket' not in data


def test_api_get_default_model_unconfigured():
  empty_catalog = configured_catalog(config_dict={
      'defaultModelId': None,
      'models': []
  })
  reset_catalog_for_testing(empty_catalog)
  client = main.app.test_client()
  response = client.get('/api/on-device-models/default')
  assert response.status_code == 404
  data = response.get_json()
  assert data['error'] == 'NO_DEFAULT_MODEL_CONFIGURED'


def test_api_post_signed_download_url(csrf_client):
  response = csrf_client.post(
      '/api/on-device-models/gemma-web-default/download-url',
      json={'version': '2026-08-01'},
  )
  assert response.status_code == 200
  data = response.get_json()
  assert 'url' in data
  assert data['sizeBytes'] == 2008432640
  assert data['gcsGeneration'] == '1738700000000000'
  assert data[
      'sha256'] == '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5'


def test_api_post_signed_download_url_requires_csrf():
  raw_client = main.app.test_client()
  response = raw_client.post(
      '/api/on-device-models/gemma-web-default/download-url',
      json={'version': '2026-08-01'},
  )
  assert response.status_code == 403


def test_api_post_signed_download_url_invalid_version(csrf_client):
  response = csrf_client.post(
      '/api/on-device-models/gemma-web-default/download-url',
      json={'version': 'invalid-version'},
  )
  assert response.status_code == 400
  data = response.get_json()
  assert data['error'] == 'INVALID_MODEL_VERSION'


def test_api_post_signed_download_url_model_not_found(csrf_client):
  response = csrf_client.post(
      '/api/on-device-models/non-existent-model/download-url',
      json={'version': '2026-08-01'},
  )
  assert response.status_code == 404
  data = response.get_json()
  assert data['error'] == 'MODEL_NOT_FOUND'


def test_signed_download_url_logs_are_redacted(caplog):
  caplog.set_level(logging.INFO)
  catalog = configured_catalog()
  signed = catalog.generate_signed_download_url('gemma-web-default',
                                                '2026-08-01')

  # Assert the actual signed URL signature is NOT logged in caplog
  sig_match = re.search(r'X-Goog-Signature=([^&]+)', signed['url'])
  assert sig_match is not None
  secret_sig = sig_match.group(1)

  for record in caplog.records:
    assert secret_sig not in record.message
    if 'Generated signed download URL' in record.message:
      assert '[URL REDACTED]' in record.message


def test_catalog_requires_deployment_configuration():
  catalog = ModelCatalog(config_dict=None, url_signer=fake_url_signer)
  with pytest.raises(ModelNotFoundError, match='No default'):
    catalog.get_default_manifest()


def test_catalog_rejects_missing_private_object_binding():
  model = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  del model['gcsObject']
  with pytest.raises(ManifestValidationError, match='gcsBucket and gcsObject'):
    configured_catalog({
        'defaultModelId': model['modelId'],
        'models': [model],
    })


def test_catalog_rejects_duplicate_model_ids():
  model = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  with pytest.raises(ManifestValidationError, match='Duplicate'):
    configured_catalog({
        'defaultModelId': model['modelId'],
        'models': [model, copy.deepcopy(model)],
    })


def test_manifest_rejects_unknown_nested_fields_and_non_finite_numbers():
  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['capabilities']['scriptUrl'] = 'data:text/javascript,alert(1)'
  with pytest.raises(
      ManifestValidationError, match='Unknown keys in capabilities'):
    validate_manifest(manifest, allow_private_fields=True)

  manifest = copy.deepcopy(DEFAULT_FROZEN_MODEL_CONFIG)
  manifest['generation']['temperature'] = float('nan')
  with pytest.raises(ManifestValidationError, match='temperature'):
    validate_manifest(manifest, allow_private_fields=True)


def test_default_gcs_signer_pins_generation(monkeypatch):
  observed = {}

  class FakeBlob:

    def generate_signed_url(self, **kwargs):
      observed.update(kwargs)
      return 'https://storage.googleapis.com/signed'

  class FakeBucket:

    def blob(self, object_name, generation):
      observed['object_name'] = object_name
      observed['blob_generation'] = generation
      return FakeBlob()

  class FakeClient:

    def bucket(self, bucket_name):
      observed['bucket_name'] = bucket_name
      return FakeBucket()

  monkeypatch.setattr('model_catalog.storage.Client', FakeClient)
  expires_at = datetime.datetime.now(datetime.timezone.utc)
  url = ModelCatalog._generate_gcs_v4_signed_url(DEFAULT_FROZEN_MODEL_CONFIG,
                                                 expires_at)

  assert url.endswith('/signed')
  assert observed['bucket_name'] == DEFAULT_FROZEN_MODEL_CONFIG['gcsBucket']
  assert observed['blob_generation'] == int(
      DEFAULT_FROZEN_MODEL_CONFIG['gcsGeneration'])
  assert observed['version'] == 'v4'
  assert observed['expiration'] == expires_at
  assert observed['query_parameters'][
      'generation'] == DEFAULT_FROZEN_MODEL_CONFIG['gcsGeneration']
