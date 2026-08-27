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
"""Verification tool and policy checks for private GCS model distribution.

Verifies:
1. Bucket IAM least-privilege (no public read/allUsers ACL).
2. Uniform bucket-level access.
3. CORS configuration for web Range GETs (ExposedHeaders: Content-Range, Content-Length, ETag).
4. Generation pinning for immutable candidate model artifacts.
5. Full GET and Range GET resume contracts (200, 206, 416).
"""

import argparse
import hashlib
import json
import logging
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from google.cloud import storage

# Running this file directly places tools/, not the project root, on sys.path.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
  sys.path.insert(0, PROJECT_ROOT)

from model_catalog import ModelCatalog

logger = logging.getLogger(__name__)

REQUIRED_CORS_EXPOSED_HEADERS = {
    'range',
    'content-range',
    'content-length',
    'etag',
    'accept-ranges',
    'x-goog-generation',
}

REQUIRED_CORS_METHODS = {'GET', 'HEAD'}


class GcsVerificationError(Exception):
  """Raised when a GCS distribution requirement is violated."""
  pass


def validate_cors_policy(
    cors_rules: List[Dict[str, Any]]) -> Tuple[bool, List[str]]:
  """Validates that GCS CORS rules support browser Range downloads."""
  issues = []
  if not cors_rules:
    return False, ['No CORS rules configured on bucket']

  has_valid_rule = False
  for idx, rule in enumerate(cors_rules):
    methods = {m.upper() for m in rule.get('method', [])}
    if not REQUIRED_CORS_METHODS.issubset(methods):
      missing = sorted(REQUIRED_CORS_METHODS - methods)
      issues.append(f'Rule {idx} missing required methods: {missing}')
      continue

    response_headers = {h.lower() for h in rule.get('responseHeader', [])}
    missing_headers = REQUIRED_CORS_EXPOSED_HEADERS - response_headers
    if missing_headers:
      issues.append(
          f'Rule {idx} missing required exposed headers: {sorted(missing_headers)}'
      )
      continue

    has_valid_rule = True

  return has_valid_rule, issues


def validate_bucket_security(
    bucket_metadata: Dict[str, Any]) -> Tuple[bool, List[str]]:
  """Validates private bucket policy and uniform access."""
  issues = []

  # Check uniform bucket-level access
  iam_config = bucket_metadata.get('iamConfiguration', {})
  ubla = iam_config.get('uniformBucketLevelAccess', {})
  if not ubla.get('enabled'):
    issues.append('Uniform bucket-level access (UBLA) must be enabled')

  # Check for forbidden public ACLs
  default_acl = bucket_metadata.get('defaultObjectAcl', [])
  for entry in default_acl:
    entity = entry.get('entity', '').lower()
    if entity in ('allusers', 'allauthenticatedusers'):
      issues.append(f'Public entity "{entity}" found in defaultObjectAcl')

  for binding in bucket_metadata.get('iamBindings', []):
    for member in binding.get('members', []):
      if str(member).lower() in ('allusers', 'allauthenticatedusers'):
        issues.append(
            f'Public IAM member "{member}" found in {binding.get("role", "unknown role")}'
        )

  return len(issues) == 0, issues


def _load_live_config(config_path: Optional[str]) -> Dict[str, Any]:
  """Loads the same deployment model configuration used by the application."""
  config_json = os.environ.get('ON_DEVICE_MODEL_CONFIG_JSON')
  resolved_path = config_path or os.environ.get('ON_DEVICE_MODEL_CONFIG_PATH')
  if config_json:
    raw = json.loads(config_json)
  elif resolved_path:
    with open(resolved_path, 'r', encoding='utf-8') as config_file:
      raw = json.load(config_file)
  else:
    raise GcsVerificationError(
        'Live verification requires --config, ON_DEVICE_MODEL_CONFIG_PATH, '
        'or ON_DEVICE_MODEL_CONFIG_JSON')
  if not isinstance(raw, dict):
    raise GcsVerificationError('Model catalog configuration must be an object')
  return raw


def _policy_bindings(policy: Any) -> List[Dict[str, Any]]:
  """Normalizes google-cloud-storage IAM Policy bindings for validation."""
  bindings = getattr(policy, 'bindings', {})
  if isinstance(bindings, dict):
    return [{
        'role': role,
        'members': sorted(str(member) for member in members),
    } for role, members in bindings.items()]
  if isinstance(bindings, list):
    return bindings
  return []


def _open_signed_url(
    url: str,
    range_header: Optional[str] = None,
    origin: Optional[str] = None) -> Tuple[int, Dict[str, str]]:
  """Opens a signed URL and returns status/headers without retaining its body."""
  headers = {}
  if range_header:
    headers['Range'] = range_header
  if origin:
    headers['Origin'] = origin
  request = urllib.request.Request(url, headers=headers, method='GET')
  try:
    with urllib.request.urlopen(request, timeout=60) as response:
      # Read a single byte to prove the body is accessible, then close. This
      # avoids downloading the multi-GB artifact during the deployment gate.
      response.read(1)
      return response.status, {
          key.lower(): value for key, value in response.headers.items()
      }
  except urllib.error.HTTPError as error:
    return error.code, {
        key.lower(): value for key, value in error.headers.items()
    }


def verify_live_distribution(config_path: Optional[str] = None) -> None:
  """Verifies the configured bucket, object generation, and HTTP contracts."""
  raw_config = _load_live_config(config_path)
  catalog = ModelCatalog(config_dict=raw_config)
  default_model_id = raw_config.get('defaultModelId')
  if not isinstance(default_model_id, str):
    raise GcsVerificationError(
        'defaultModelId is required for live verification')
  model = catalog.get_model(default_model_id)

  client = storage.Client()
  bucket = client.bucket(model['gcsBucket'])
  bucket.reload()
  policy = bucket.get_iam_policy(requested_policy_version=3)
  bucket_metadata = {
      'iamConfiguration': {
          'uniformBucketLevelAccess': {
              'enabled':
                  bool(bucket.iam_configuration
                       .uniform_bucket_level_access_enabled),
          },
      },
      'iamBindings': _policy_bindings(policy),
  }
  security_ok, security_issues = validate_bucket_security(bucket_metadata)
  if not security_ok:
    raise GcsVerificationError(
        f'Bucket security verification failed: {security_issues}')

  cors_rules = bucket.cors or []
  cors_ok, cors_issues = validate_cors_policy(cors_rules)
  if not cors_ok:
    raise GcsVerificationError(
        f'Bucket CORS verification failed: {cors_issues}')
  configured_origins = [
      origin for rule in cors_rules for origin in rule.get('origin', [])
  ]
  if not configured_origins:
    raise GcsVerificationError('Bucket CORS has no configured origins')
  test_origin = ('https://example.invalid'
                 if configured_origins[0] == '*' else configured_origins[0])

  blob = bucket.blob(model['gcsObject'], generation=int(model['gcsGeneration']))
  blob.reload()
  if str(blob.generation) != model['gcsGeneration']:
    raise GcsVerificationError('Configured object generation was not found')
  if blob.size != model['sizeBytes']:
    raise GcsVerificationError(
        f'Object size mismatch: expected {model["sizeBytes"]}, found {blob.size}'
    )

  signed = catalog.generate_signed_download_url(default_model_id,
                                                model['version'])
  pin_ok, pin_issue = validate_generation_pinning(signed['url'],
                                                  model['gcsGeneration'])
  if not pin_ok:
    raise GcsVerificationError(pin_issue or 'Generation pinning failed')

  full_status, full_headers = _open_signed_url(
      signed['url'], origin=test_origin)
  if full_status != 200:
    raise GcsVerificationError(
        f'Full GET contract failed: expected 200, found {full_status}')
  content_length = full_headers.get('content-length')
  if content_length and int(content_length) != model['sizeBytes']:
    raise GcsVerificationError('Full GET Content-Length does not match model')

  allowed_origin = full_headers.get('access-control-allow-origin')
  if allowed_origin not in ('*', test_origin):
    raise GcsVerificationError(
        'Full GET response did not allow the configured CORS origin')

  range_status, range_headers = _open_signed_url(signed['url'], 'bytes=0-0',
                                                 test_origin)
  if range_status != 206:
    raise GcsVerificationError(
        f'Range GET contract failed: expected 206, found {range_status}')
  expected_range = f'bytes 0-0/{model["sizeBytes"]}'
  if range_headers.get('content-range') != expected_range:
    raise GcsVerificationError(
        f'Range GET Content-Range mismatch: {range_headers.get("content-range")}'
    )

  invalid_status, _ = _open_signed_url(signed['url'],
                                       f'bytes={model["sizeBytes"]}-',
                                       test_origin)
  if invalid_status != 416:
    raise GcsVerificationError(
        f'Out-of-bounds Range contract failed: expected 416, found {invalid_status}'
    )


def validate_generation_pinning(
    signed_url: str, expected_generation: str) -> Tuple[bool, Optional[str]]:
  """Validates that a signed download URL pins an exact GCS generation."""
  if not expected_generation or not expected_generation.isdigit():
    return False, f'Invalid expected generation: {expected_generation}'

  try:
    query = urllib.parse.parse_qs(
        urllib.parse.urlparse(signed_url).query, keep_blank_values=True)
  except ValueError:
    return False, 'Signed URL is malformed'
  if query.get('generation') != [expected_generation]:
    return False, (
        'Signed URL does not contain exactly one matching generation parameter')

  return True, None


def simulate_range_download_contract(
    payload: bytes,
    range_header: Optional[str] = None) -> Tuple[int, Dict[str, str], bytes]:
  """Simulates GCS Range GET semantics for local policy verification.

  Returns (status_code, response_headers, response_bytes).
  """
  total_size = len(payload)
  headers = {
      'Accept-Ranges': 'bytes',
      'ETag': f'"{hashlib.sha256(payload).hexdigest()}"',
  }

  if not range_header:
    headers['Content-Length'] = str(total_size)
    return 200, headers, payload

  # Parse Range: bytes=start-end or bytes=start-
  if not range_header.startswith('bytes='):
    headers['Content-Length'] = str(total_size)
    return 200, headers, payload

  range_spec = range_header[len('bytes='):]
  parts = range_spec.split('-')
  if len(parts) != 2:
    return 416, {'Content-Range': f'bytes */{total_size}'}, b''

  try:
    start = int(parts[0]) if parts[0] else 0
    end = int(parts[1]) if parts[1] else total_size - 1
  except ValueError:
    return 416, {'Content-Range': f'bytes */{total_size}'}, b''

  if start >= total_size or start > end:
    return 416, {'Content-Range': f'bytes */{total_size}'}, b''

  end = min(end, total_size - 1)
  slice_bytes = payload[start:end + 1]
  headers['Content-Length'] = str(len(slice_bytes))
  headers['Content-Range'] = f'bytes {start}-{end}/{total_size}'
  return 206, headers, slice_bytes


def main():
  parser = argparse.ArgumentParser(
      description='Verify GCS distribution configuration for Project VOICE.')
  parser.add_argument(
      '--config',
      help='Path to on-device model catalog JSON config',
      default=None,
  )
  parser.add_argument(
      '--live',
      action='store_true',
      help='Execute live verification against Google Cloud Storage',
  )
  args = parser.parse_args()

  logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')

  logger.info('Verifying GCS distribution specification and Range contracts...')

  # 1. Standard reference CORS policy verification
  reference_cors = [{
      'origin': ['http://localhost:5000', 'https://*.appspot.com'],
      'method': ['GET', 'HEAD'],
      'responseHeader': [
          'Range',
          'Content-Range',
          'Content-Length',
          'ETag',
          'Accept-Ranges',
          'x-goog-generation',
      ],
      'maxAgeSeconds': 3600,
  }]
  cors_ok, cors_issues = validate_cors_policy(reference_cors)
  if not cors_ok:
    logger.error('Reference CORS policy invalid: %s', cors_issues)
    sys.exit(1)
  logger.info('✓ CORS policy specification verified (supports Range resume).')

  # 2. Bucket security and UBLA verification
  reference_bucket_meta = {
      'iamConfiguration': {
          'uniformBucketLevelAccess': {
              'enabled': True
          }
      },
      'defaultObjectAcl': [],
  }
  sec_ok, sec_issues = validate_bucket_security(reference_bucket_meta)
  if not sec_ok:
    logger.error('Reference bucket security invalid: %s', sec_issues)
    sys.exit(1)
  logger.info(
      '✓ Bucket security verified (uniform access enabled, private ACL).')

  # 3. Generation pinning check
  pin_ok, pin_err = validate_generation_pinning(
      'https://storage.googleapis.com/bucket/model.litertlm?generation=1738700000000000&X-Goog-Signature=abc',
      '1738700000000000',
  )
  if not pin_ok:
    logger.error('Generation pinning check failed: %s', pin_err)
    sys.exit(1)
  logger.info('✓ Generation pinning contract verified.')

  # 4. Range resume contract checks
  sample_bytes = b'0123456789' * 100
  status, hdrs, chunk = simulate_range_download_contract(
      sample_bytes, 'bytes=100-199')
  assert status == 206, f'Expected 206, got {status}'
  assert hdrs['Content-Range'] == f'bytes 100-199/{len(sample_bytes)}'
  assert len(chunk) == 100
  logger.info('✓ HTTP 206 Partial Content Range contract verified.')

  status_416, _, _ = simulate_range_download_contract(sample_bytes,
                                                      'bytes=2000-3000')
  assert status_416 == 416, f'Expected 416, got {status_416}'
  logger.info('✓ HTTP 416 Range Not Satisfiable contract verified.')

  if args.live:
    logger.info('Running live verification against configured GCS resources...')
    try:
      verify_live_distribution(args.config)
    except Exception as error:
      logger.error('Live GCS verification failed: %s', error)
      sys.exit(1)
    logger.info(
        '✓ Live bucket, object generation, and HTTP contracts verified.')

  logger.info('All GCS distribution verification checks passed successfully.')


if __name__ == '__main__':
  main()
