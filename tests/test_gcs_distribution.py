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
"""Tests for GCS private distribution verification, CORS, and Range contracts."""

import os
import sys

import pytest

# Ensure tools directory is in sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))

from verify_gcs_distribution import (
    simulate_range_download_contract,
    validate_bucket_security,
    validate_cors_policy,
    validate_generation_pinning,
)


def test_cors_policy_valid_configuration():
  valid_cors = [{
      'origin': ['http://localhost:5000', 'https://voice.example.com'],
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
  ok, issues = validate_cors_policy(valid_cors)
  assert ok is True
  assert not issues


def test_cors_policy_rejects_wildcards_and_unapproved_origins():
  wildcard_cors = [{
      'origin': ['*'],
      'method': ['GET', 'HEAD'],
      'responseHeader':
          list({
              'Range', 'Content-Range', 'Content-Length', 'ETag',
              'Accept-Ranges', 'x-goog-generation'
          }),
  }]
  ok, issues = validate_cors_policy(wildcard_cors)
  assert ok is False
  assert any('unsafe origin' in issue for issue in issues)

  explicit_cors = [{
      **wildcard_cors[0],
      'origin': ['https://voice.example.com'],
  }]
  ok, issues = validate_cors_policy(
      explicit_cors, allowed_origins=['https://staging.example.com'])
  assert ok is False
  assert any('do not exactly match' in issue for issue in issues)


@pytest.mark.parametrize('origin', [
    'https://voice.example.com/path',
    'https://user@voice.example.com',
    'https://voice.example.com?redirect=evil',
    'http://voice.example.com',
    'http://localhost.evil.example',
    'https://voice.example.com\nhttps://evil.example',
])
def test_cors_policy_rejects_values_that_are_not_exact_origins(origin):
  cors = [{
      'origin': [origin],
      'method': ['GET', 'HEAD'],
      'responseHeader': [
          'Range', 'Content-Range', 'Content-Length', 'ETag', 'Accept-Ranges',
          'x-goog-generation'
      ],
  }]
  ok, issues = validate_cors_policy(cors)
  assert ok is False
  assert any('unsafe origin' in issue for issue in issues)


def test_cors_policy_rejects_missing_exposed_headers():
  invalid_cors = [{
      'origin': ['http://localhost:5000'],
      'method': ['GET', 'HEAD'],
      'responseHeader': ['Content-Length'],  # Missing Content-Range, ETag, etc.
  }]
  ok, issues = validate_cors_policy(invalid_cors)
  assert ok is False
  assert any('missing required exposed headers' in issue for issue in issues)


def test_bucket_security_requires_ubla():
  non_ubla_bucket = {
      'iamConfiguration': {
          'uniformBucketLevelAccess': {
              'enabled': False
          }
      },
      'defaultObjectAcl': [],
  }
  ok, issues = validate_bucket_security(non_ubla_bucket)
  assert ok is False
  assert any('Uniform bucket-level access' in issue for issue in issues)


def test_bucket_security_rejects_public_acl():
  public_bucket = {
      'iamConfiguration': {
          'uniformBucketLevelAccess': {
              'enabled': True
          }
      },
      'defaultObjectAcl': [{
          'entity': 'allUsers',
          'role': 'READER'
      }],
  }
  ok, issues = validate_bucket_security(public_bucket)
  assert ok is False
  assert any('Public entity' in issue for issue in issues)


def test_bucket_security_rejects_public_iam_binding():
  public_bucket = {
      'iamConfiguration': {
          'uniformBucketLevelAccess': {
              'enabled': True
          }
      },
      'iamBindings': [{
          'role': 'roles/storage.objectViewer',
          'members': ['allUsers'],
      }],
  }
  ok, issues = validate_bucket_security(public_bucket)
  assert ok is False
  assert any('Public IAM member' in issue for issue in issues)


def test_bucket_security_enforces_runtime_identity_least_privilege():
  runtime_member = 'serviceAccount:voice@appspot.gserviceaccount.com'
  bucket = {
      'iamConfiguration': {
          'uniformBucketLevelAccess': {
              'enabled': True
          }
      },
      'iamBindings': [{
          'role': 'roles/storage.objectViewer',
          'members': [runtime_member],
      }],
  }
  ok, issues = validate_bucket_security(bucket, runtime_member)
  assert ok is True
  assert not issues

  bucket['iamBindings'].append({
      'role': 'roles/storage.admin',
      'members': [runtime_member],
  })
  ok, issues = validate_bucket_security(bucket, runtime_member)
  assert ok is False
  assert any('excessive bucket roles' in issue for issue in issues)


def test_generation_pinning_validation():
  url = 'https://storage.googleapis.com/test-bucket/model.litertlm?generation=1738700000000000&X-Goog-Signature=sig'
  ok, err = validate_generation_pinning(url, '1738700000000000')
  assert ok is True
  assert err is None

  # Mismatched generation
  ok_mismatch, err_mismatch = validate_generation_pinning(
      url, '9999999999999999')
  assert ok_mismatch is False
  assert err_mismatch is not None

  spoofed_url = ('https://storage.googleapis.com/test-bucket/model.litertlm?'
                 'notgeneration=1738700000000000&X-Goog-Signature=sig')
  ok_spoofed, _ = validate_generation_pinning(spoofed_url, '1738700000000000')
  assert ok_spoofed is False


def test_range_download_contract_full_get():
  payload = b'0123456789' * 10
  status, hdrs, body = simulate_range_download_contract(payload, None)
  assert status == 200
  assert hdrs['Content-Length'] == str(len(payload))
  assert body == payload


def test_range_download_contract_partial_content():
  payload = b'abcdefghijklmnopqrstuvwxyz'
  status, hdrs, body = simulate_range_download_contract(payload, 'bytes=5-9')
  assert status == 206
  assert hdrs['Content-Range'] == f'bytes 5-9/{len(payload)}'
  assert hdrs['Content-Length'] == '5'
  assert body == b'fghij'


def test_range_download_contract_out_of_bounds():
  payload = b'small'
  status, hdrs, body = simulate_range_download_contract(payload,
                                                        'bytes=100-200')
  assert status == 416
  assert hdrs['Content-Range'] == f'bytes */{len(payload)}'
  assert body == b''
