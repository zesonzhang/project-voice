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
import secrets

import flask
import secrets_helper
from flask_seasurf import SeaSurf

from app_security import SlidingWindowRateLimiter
import macro
import model_catalog

app = flask.Flask(__name__)
configured_secret = secrets_helper.get_secret('SECRET_KEY')
if not configured_secret and os.environ.get('GAE_ENV') == 'standard':
  raise RuntimeError(
      'SECRET_KEY must be configured in the deployed environment')
app.secret_key = configured_secret or secrets.token_hex(32)
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = (
    os.environ.get('GAE_ENV') == 'standard' or
    os.environ.get('SESSION_COOKIE_SECURE') == '1')
app.config['ENABLE_M0_HARNESS'] = os.environ.get('ENABLE_M0_HARNESS') == '1'
app.config['SIGNED_URL_RATE_LIMIT'] = int(
    os.environ.get('SIGNED_URL_RATE_LIMIT', '10'))

SIGNED_URL_RATE_LIMITER = SlidingWindowRateLimiter(
    app.config['SIGNED_URL_RATE_LIMIT'], 60)

CONTENT_SECURITY_POLICY = '; '.join([
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self' https://storage.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "worker-src 'self'",
    "form-action 'self'",
])


@app.before_request
def SetRequestId():
  """Adds a non-sensitive correlation ID for security audit events."""
  flask.g.request_id = secrets.token_hex(8)


# Register CSRF after request correlation so rejected requests are auditable.
csrf = SeaSurf(app)


@app.before_request
def RestrictM0Harness():
  path = flask.request.path
  is_m0_resource = (path == '/m0' or path.startswith('/static/m0'))
  if is_m0_resource and not app.config['ENABLE_M0_HARNESS']:
    flask.abort(404)


@app.after_request
def AddSecurityHeaders(response):
  """Applies isolation and browser security policy to every Flask response."""
  response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
  response.headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
  response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
  response.headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY
  response.headers['X-Content-Type-Options'] = 'nosniff'
  response.headers['Referrer-Policy'] = 'no-referrer'
  response.headers['Permissions-Policy'] = (
      'camera=(), geolocation=(), microphone=(self)')
  response.headers['X-Request-ID'] = flask.g.get('request_id', 'unknown')

  if flask.request.path in ('/', '/m0') or response.status_code >= 400:
    response.headers['Cache-Control'] = 'no-store'
  return response


# Compatibility alias retained for M0 callers and downstream integrations.
AddM0IsolationHeaders = AddSecurityHeaders


@app.errorhandler(403)
def HandleForbidden(error):
  app.logger.warning(
      'security_denied request_id=%s method=%s path=%s status=403',
      flask.g.get('request_id', 'unknown'),
      flask.request.method,
      flask.request.path,
  )
  if flask.request.path.startswith('/api/'):
    return flask.jsonify({
        'error': 'FORBIDDEN',
        'message': 'Request authorization or CSRF validation failed',
    }), 403
  return error


@app.route('/')
def Root():
  # The model signing endpoint requires an application-created session in
  # addition to CSRF. This prevents direct, sessionless use as a signing oracle.
  flask.session['model_download_authorized'] = True
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


@app.route('/api/features', methods=['GET'])
def GetFeatures():
  """Returns feature flags and rollout controls for on-device and experimental features."""
  on_device_mode = os.environ.get('FEATURE_ON_DEVICE_MODE', 'all')
  debug_import = os.environ.get('FEATURE_DEBUG_MODEL_IMPORT', '0') == '1'
  try:
    rollout_pct = int(os.environ.get('ON_DEVICE_ROLLOUT_PERCENTAGE', '100'))
  except ValueError:
    rollout_pct = 100

  response = flask.jsonify({
      'onDeviceMode': on_device_mode,
      'debugModelImport': debug_import,
      'rolloutPercentage': max(0, min(100, rollout_pct)),
  })
  response.headers['Cache-Control'] = 'public, max-age=60'
  return response, 200


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

  if flask.session.get('model_download_authorized') is not True:
    flask.abort(403)

  if (not model_id or len(model_id) > 64 or
      any(character not in 'abcdefghijklmnopqrstuvwxyz0123456789-'
          for character in model_id)):
    return flask.jsonify({
        'error': 'MODEL_NOT_FOUND',
        'message': 'Requested model is not allowlisted',
    }), 404

  client_key = request.remote_addr or 'unknown'
  retry_after = SIGNED_URL_RATE_LIMITER.check(client_key)
  if retry_after:
    app.logger.warning(
        'signed_url_rate_limited request_id=%s client=%s model_id=%s',
        flask.g.get('request_id', 'unknown'),
        client_key,
        model_id[:64],
    )
    response = flask.jsonify({
        'error': 'RATE_LIMITED',
        'message': 'Too many download URL requests; retry later',
    })
    response.headers['Retry-After'] = str(retry_after)
    return response, 429

  data = request.get_json(silent=True)
  if data is None and request.form:
    data = request.form.to_dict()
  elif data is None:
    data = {}

  version = data.get('version')
  if (not isinstance(version, str) or not version or len(version) > 64 or
      any(character not in 'abcdefghijklmnopqrstuvwxyz0123456789.-'
          for character in version)):
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

  response = flask.jsonify(signed_data)
  response.headers['Cache-Control'] = 'private, no-store'
  response.headers['Pragma'] = 'no-cache'
  response.headers['Vary'] = 'Cookie'
  return response, 200


if __name__ == '__main__':
  app.run(debug=True, host=os.environ.get('FLASK_HOST', '127.0.0.1'))
