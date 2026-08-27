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
      response = main.AddM0IsolationHeaders(flask.Response())
  finally:
    main.app.config['ENABLE_M0_HARNESS'] = previous

  assert response.headers['Cross-Origin-Opener-Policy'] == 'same-origin'
  assert response.headers['Cross-Origin-Embedder-Policy'] == 'require-corp'


def test_m0_wasm_binary_is_cross_origin_isolated():
  previous = main.app.config['ENABLE_M0_HARNESS']
  main.app.config['ENABLE_M0_HARNESS'] = True
  try:
    with main.app.test_request_context('/static/litertlm_wasm_internal.wasm'):
      response = main.AddM0IsolationHeaders(flask.Response())
  finally:
    main.app.config['ENABLE_M0_HARNESS'] = previous

  assert response.headers['Cross-Origin-Embedder-Policy'] == 'require-corp'
