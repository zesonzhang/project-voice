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

import pytest

import main


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


def test_app_engine_static_handler_declares_isolation_and_csp():
  with open('app.yaml', encoding='utf-8') as app_config:
    yaml_text = app_config.read()

  static_handler = yaml_text.split('- url: /*', maxsplit=1)[0]
  assert 'Cross-Origin-Opener-Policy: same-origin' in static_handler
  assert 'Cross-Origin-Embedder-Policy: require-corp' in static_handler
  assert 'Content-Security-Policy:' in static_handler
  assert "worker-src 'self'" in static_handler
