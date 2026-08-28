"""Tests for the feature flags and rollout controls endpoint."""

import os
import unittest
from unittest import mock

import main


class FeaturesApiTest(unittest.TestCase):

  def setUp(self):
    main.app.config['TESTING'] = True
    self.client = main.app.test_client()

  def test_get_features_default_values(self):
    response = self.client.get('/api/features')
    self.assertEqual(response.status_code, 200)
    data = response.get_json()
    self.assertIn('onDeviceMode', data)
    self.assertIn('debugModelImport', data)
    self.assertIn('rolloutPercentage', data)
    self.assertEqual(data['debugModelImport'], False)
    self.assertEqual(data['rolloutPercentage'], 100)

  def test_get_features_custom_environment(self):
    with mock.patch.dict(
        os.environ,
        {
            'FEATURE_ON_DEVICE_MODE': 'canary',
            'FEATURE_DEBUG_MODEL_IMPORT': '1',
            'ON_DEVICE_ROLLOUT_PERCENTAGE': '25',
        },
    ):
      response = self.client.get('/api/features')
      self.assertEqual(response.status_code, 200)
      data = response.get_json()
      self.assertEqual(data['onDeviceMode'], 'canary')
      self.assertEqual(data['debugModelImport'], True)
      self.assertEqual(data['rolloutPercentage'], 25)

  def test_get_features_clamps_rollout_percentage(self):
    with mock.patch.dict(os.environ, {'ON_DEVICE_ROLLOUT_PERCENTAGE': '150'}):
      response = self.client.get('/api/features')
      self.assertEqual(response.status_code, 200)
      data = response.get_json()
      self.assertEqual(data['rolloutPercentage'], 100)


if __name__ == '__main__':
  unittest.main()
