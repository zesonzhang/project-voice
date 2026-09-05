/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import '../pv-on-device-model-card.js';

import {ModelManager} from '../on-device/model-manager.js';
import {ModelManifest} from '../on-device/model-manifest.js';
import {PvOnDeviceModelCard} from '../pv-on-device-model-card.js';

const MANIFEST: ModelManifest = {
  schemaVersion: 1,
  modelId: 'gemma-card-test',
  version: '1',
  displayName: 'Gemma Card Test',
  family: 'gemma',
  adapterId: 'litert-lm',
  format: 'litertlm',
  sizeBytes: 1024,
  sha256: 'a'.repeat(64),
  gcsGeneration: '1',
  capabilities: {
    textGeneration: true,
    languages: ['en'],
    maxInputTokens: 128,
    maxOutputTokens: 32,
  },
  requirements: {
    webgpu: true,
    minimumDeviceMemoryGB: 8,
    minimumFreeStorageBytes: 2048,
  },
  generation: {temperature: 0, topP: 0.5, maxOutputTokens: 32},
};

describe('On-device model card', () => {
  let card: PvOnDeviceModelCard;
  let managerSpies: {
    updateModel: jasmine.Spy;
  };

  beforeEach(async () => {
    managerSpies = {updateModel: jasmine.createSpy().and.resolveTo()};
    const manager = {
      getState: () => 'ready',
      getActiveManifest: () => MANIFEST,
      getError: () => null,
      getRuntimeAdapter: () => undefined,
      getActiveVersionMetadata: async () => null,
      onStateChange: () => () => {},
      onDownloadProgress: () => () => {},
      checkCapabilities: async () => ({
        supported: true,
        webgpuSupported: true,
        fallbackAdapter: false,
        opfsSupported: true,
        workerSupported: true,
        httpsOrLocal: true,
        crossOriginIsolated: true,
        persistenceGranted: true,
        deviceMemoryGB: 8,
        quotaAvailableBytes: 4096,
        quotaTotalBytes: 8192,
      }),
      updateModel: managerSpies.updateModel,
    } as unknown as ModelManager;

    card = document.createElement(
      'pv-on-device-model-card',
    ) as PvOnDeviceModelCard;
    card.modelManager = manager;
    document.body.append(card);
    await card.updateComplete;
  });

  afterEach(() => card.remove());

  it('uses encapsulated styles and exposes an announced lifecycle status', () => {
    expect(card.shadowRoot).not.toBeNull();
    const badge = card.renderRoot.querySelector('.model-badge');
    expect(badge?.getAttribute('role')).toBe('status');
    expect(badge?.getAttribute('aria-live')).toBe('polite');
  });

  it('requests a parent-owned removal dialog instead of nesting one', async () => {
    let trigger: HTMLElement | null = null;
    card.addEventListener('request-model-removal', event => {
      trigger = (event as CustomEvent<{trigger: HTMLElement}>).detail.trigger;
    });
    const removeButton = Array.from(
      card.renderRoot.querySelectorAll('md-text-button'),
    ).find(button => button.textContent?.trim() === 'Remove');

    removeButton?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    expect<HTMLElement | null>(trigger).toBe(removeButton as HTMLElement);
    expect(card.renderRoot.querySelector('md-dialog')).toBeNull();
  });

  it('installs the exact update candidate returned by the catalog', async () => {
    const candidate = {...MANIFEST, version: '2'};
    (card as unknown as {pendingUpdate: ModelManifest | null}).pendingUpdate =
      candidate;

    await card.onUpdateClick();

    expect(managerSpies.updateModel).toHaveBeenCalledOnceWith(candidate);
  });
});
