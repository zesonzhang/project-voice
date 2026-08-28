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

import flask
import pytest

import main


@pytest.fixture
def m0_client():
  previous = main.app.config['ENABLE_M0_HARNESS']
  main.app.config['ENABLE_M0_HARNESS'] = True
  try:
    yield main.app.test_client()
  finally:
    main.app.config['ENABLE_M0_HARNESS'] = previous


def test_m0_route_is_disabled_by_default():
  previous = main.app.config['ENABLE_M0_HARNESS']
  main.app.config['ENABLE_M0_HARNESS'] = False
  try:
    response = main.app.test_client().get('/m0')
  finally:
    main.app.config['ENABLE_M0_HARNESS'] = previous

  assert response.status_code == 404


def test_m0_route_is_cross_origin_isolated(m0_client):
  response = m0_client.get('/m0')

  assert response.status_code == 200
  assert response.headers['Cross-Origin-Opener-Policy'] == 'same-origin'
  assert response.headers['Cross-Origin-Embedder-Policy'] == 'require-corp'
  assert b'/static/m0.js' in response.data
  assert b'pattern="[a-z0-9\\-]+"' in response.data


def test_m0_worker_is_cross_origin_isolated():
  previous = main.app.config['ENABLE_M0_HARNESS']
  main.app.config['ENABLE_M0_HARNESS'] = True
  try:
    with main.app.test_request_context('/static/m0-inference-worker.js'):
      flask.g.request_id = 'test-request'
      response = main.AddSecurityHeaders(flask.Response())
  finally:
    main.app.config['ENABLE_M0_HARNESS'] = previous

  assert response.headers['Cross-Origin-Opener-Policy'] == 'same-origin'
  assert response.headers['Cross-Origin-Embedder-Policy'] == 'require-corp'


def test_m0_wasm_binary_is_cross_origin_isolated():
  previous = main.app.config['ENABLE_M0_HARNESS']
  main.app.config['ENABLE_M0_HARNESS'] = True
  try:
    with main.app.test_request_context('/static/litertlm_wasm_internal.wasm'):
      flask.g.request_id = 'test-request'
      response = main.AddSecurityHeaders(flask.Response())
  finally:
    main.app.config['ENABLE_M0_HARNESS'] = previous

  assert response.headers['Cross-Origin-Embedder-Policy'] == 'require-corp'


@pytest.mark.parametrize('path, expected_status', [
    ('/', 200),
    ('/does-not-exist', 404),
    ('/static/index.css', 200),
])
def test_all_flask_response_paths_have_isolation_and_security_headers(
    path, expected_status):
  response = main.app.test_client().get(path)

  assert response.status_code == expected_status
  assert response.headers['Cross-Origin-Opener-Policy'] == 'same-origin'
  assert response.headers['Cross-Origin-Embedder-Policy'] == 'require-corp'
  assert response.headers['Cross-Origin-Resource-Policy'] == 'same-origin'
  assert response.headers['X-Content-Type-Options'] == 'nosniff'
  assert response.headers['Referrer-Policy'] == 'no-referrer'
  assert response.headers['X-Request-ID']


def test_csp_restricts_executable_resources_and_allows_required_connections():
  response = main.app.test_client().get('/')
  csp = response.headers['Content-Security-Policy']

  assert "script-src 'self'" in csp
  assert "worker-src 'self'" in csp
  assert "connect-src 'self' https://storage.googleapis.com" in csp
  assert "object-src 'none'" in csp
  assert "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com" in csp
  assert "font-src 'self' https://fonts.gstatic.com" in csp
  assert response.headers['Cache-Control'] == 'no-store'


def test_runtime_assets_are_self_hosted_and_present():
  response = main.app.test_client().get('/')

  assert b'https://fonts.googleapis.com' in response.data
  assert b'https://fonts.gstatic.com' in response.data
  assert b'crossorigin="anonymous"' in response.data
  for path in (
      '/static/inference-worker.js',
      '/static/vendor/litert-lm/wasm/litertlm_wasm_internal.wasm',
  ):
    asset = main.app.test_client().get(path)
    assert asset.status_code == 200, path


def test_app_engine_static_handler_declares_isolation_and_csp():
  with open('app.yaml', encoding='utf-8') as app_config:
    yaml_text = app_config.read()

  static_handler = yaml_text.split('- url: /*', maxsplit=1)[0]
  assert 'Cross-Origin-Opener-Policy: same-origin' in static_handler
  assert 'Cross-Origin-Embedder-Policy: require-corp' in static_handler
  assert 'Content-Security-Policy:' in static_handler
  assert "worker-src 'self'" in static_handler
