# Copyright 2024 Google LLC
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
"""The main page of Project VOICE app.
"""

import json
import os

import flask
import secrets_helper
from flask_cors import CORS
from flask_seasurf import SeaSurf

import macro
import model_catalog

app = flask.Flask(__name__)
CORS(app)
csrf = SeaSurf(app)
app.secret_key = secrets_helper.get_secret('SECRET_KEY') or 'localkey'
app.config['ENABLE_M0_HARNESS'] = os.environ.get('ENABLE_M0_HARNESS') == '1'


@app.before_request
def RestrictM0Harness():
  path = flask.request.path
  is_m0_resource = (
      path == '/m0' or path.startswith('/static/m0') or
      path.startswith('/static/litertlm_wasm_') or
      path.startswith('/static/vendor/litert-lm/'))
  if is_m0_resource and not app.config['ENABLE_M0_HARNESS']:
    flask.abort(404)


@app.after_request
def AddM0IsolationHeaders(response):
  path = flask.request.path
  if app.config['ENABLE_M0_HARNESS'] and (
      path == '/m0' or path.startswith('/static/m0') or
      path.startswith('/static/litertlm_wasm_') or
      path.startswith('/static/vendor/litert-lm/')):
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    response.headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
  return response


@app.route('/')
def Root():
  return flask.make_response(flask.render_template('index.jinja'))


@app.route('/m0')
def M0():
  return flask.make_response(flask.render_template('m0.jinja'))


@app.route('/run-macro', methods=['POST'])
def RunMacro():
  request = flask.request
  macro_id = request.form.get('id')
  user_inputs = json.loads(request.form.get('userInputs'))
  temperature = float(request.form.get('temperature'))
  model_id = request.form.get('model_id')

  return macro.RunMacro(macro_id, user_inputs, temperature, model_id)


@app.route('/api/on-device-models/default', methods=['GET'])
def GetDefaultOnDeviceModel():
  catalog = model_catalog.get_catalog()
  try:
    manifest = catalog.get_default_manifest()
  except model_catalog.ModelNotFoundError as err:
    return flask.jsonify({
        'error': 'NO_DEFAULT_MODEL_CONFIGURED',
        'message': str(err)
    }), 404

  response = flask.jsonify(manifest)
  response.headers['Cache-Control'] = 'public, max-age=300'
  return response, 200


@app.route('/api/on-device-models/<model_id>/download-url', methods=['POST'])
def GetSignedDownloadUrl(model_id):
  catalog = model_catalog.get_catalog()
  request = flask.request

  data = request.get_json(silent=True)
  if data is None and request.form:
    data = request.form.to_dict()
  elif data is None:
    data = {}

  version = data.get('version')
  if not version or not isinstance(version, str):
    return flask.jsonify({
        'error': 'MISSING_OR_INVALID_VERSION',
        'message': 'version field is required and must be a string'
    }), 400

  try:
    signed_data = catalog.generate_signed_download_url(
        model_id=model_id, version=version)
  except model_catalog.ModelNotFoundError as err:
    return flask.jsonify({'error': 'MODEL_NOT_FOUND', 'message': str(err)}), 404
  except model_catalog.InvalidModelVersionError as err:
    return flask.jsonify({
        'error': 'INVALID_MODEL_VERSION',
        'message': str(err)
    }), 400
  except Exception:
    app.logger.exception('Failed to generate on-device model download URL')
    return flask.jsonify({
        'error': 'DOWNLOAD_URL_GENERATION_FAILED',
        'message': 'Unable to generate a download URL'
    }), 500

  return flask.jsonify(signed_data), 200


if __name__ == '__main__':
  app.run(debug=True, host=os.environ.get('FLASK_HOST', '127.0.0.1'))
