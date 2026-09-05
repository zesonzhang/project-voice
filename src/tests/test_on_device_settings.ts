import {ConfigStorage} from '../config-storage.js';
import {CONFIG_DEFAULT} from '../constants.js';
import {PvSettingPanel} from '../pv-setting-panel.js';
import {State} from '../state.js';

describe('On-device settings integration', () => {
  const storageDomain = 'test-on-device-settings';
  let panel: PvSettingPanel;
  let state: State;

  beforeEach(() => {
    for (const key of Object.keys(CONFIG_DEFAULT)) {
      localStorage.removeItem(`${storageDomain}.${key}`);
    }
    state = new State(new ConfigStorage(storageDomain, CONFIG_DEFAULT));
    panel = new PvSettingPanel();
    panel.state = state;
    document.body.appendChild(panel);
  });

  afterEach(() => {
    panel.remove();
    for (const key of Object.keys(CONFIG_DEFAULT)) {
      localStorage.removeItem(`${storageDomain}.${key}`);
    }
  });

  it('keeps new Local activation disabled until rollout allows it', async () => {
    panel.localActivationAllowed = false;
    await panel.updateComplete;

    const localOption = panel.renderRoot.querySelector(
      'md-select-option[value="local"]',
    );
    expect(localOption?.hasAttribute('disabled')).toBeTrue();
    expect(state.inferenceMode).toBe('cloud');
  });

  it('separates the inference source from the Cloud model selector', async () => {
    await panel.updateComplete;
    const content = panel.renderRoot.textContent ?? '';
    const selectors = panel.renderRoot.querySelectorAll('md-outlined-select');

    expect(selectors[0].getAttribute('label')).toBe('Inference Source');
    expect(selectors[1].getAttribute('label')).toBe('Cloud AI Model');
    expect(content).toContain('Gemini 3.1 Flash Lite');
  });

  it('continues to render the model card for an existing Local user', async () => {
    state.inferenceMode = 'local';
    panel.localActivationAllowed = false;
    panel.requestUpdate();
    await panel.updateComplete;

    expect(
      panel.renderRoot.querySelector('pv-on-device-model-card'),
    ).not.toBeNull();
    expect(
      panel.renderRoot
        .querySelector('md-select-option[value="local"]')
        ?.hasAttribute('disabled'),
    ).toBeFalse();
  });

  it('hosts removal confirmation as a sibling of the settings dialog', async () => {
    state.inferenceMode = 'local';
    panel.requestUpdate();
    await panel.updateComplete;
    const card = panel.renderRoot.querySelector('pv-on-device-model-card');
    const trigger = document.createElement('button');

    card?.dispatchEvent(
      new CustomEvent('request-model-removal', {
        bubbles: true,
        composed: true,
        detail: {trigger},
      }),
    );
    await panel.updateComplete;

    const settings = panel.renderRoot.querySelector('#settings-dialog');
    const confirmation = panel.renderRoot.querySelector('#remove-model-dialog');
    expect(confirmation).not.toBeNull();
    expect(settings?.contains(confirmation)).toBeFalse();
    expect(confirmation?.getAttribute('role')).toBe('alertdialog');
  });
});
