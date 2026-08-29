/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import '@material/web/checkbox/checkbox.js';
import '@material/web/select/select-option.js';
import '@material/web/button/filled-button.js';
import '@material/web/button/text-button.js';
import '@material/web/switch/switch.js';
import '@material/web/tabs/primary-tab.js';
import '@material/web/tabs/tabs.js';
import '@material/web/textfield/filled-text-field.js';
import '@material/web/select/outlined-select.js';
import '@material/web/dialog/dialog.js';
import '@material/web/slider/slider.js';
import './pv-on-device-model-card.js';

import {localized, msg} from '@lit/localize';
import {SignalWatcher} from '@lit-labs/signals';
import {MdTabs} from '@material/web/tabs/tabs.js';
import {css, html, LitElement} from 'lit';
import {customElement, property, query, state} from 'lit/decorators.js';

import {LANGUAGES} from './language.js';
import {ModelManager} from './on-device/model-manager.js';
import {State} from './state.js';

const EVENT_KEY = {
  okClick: 'ok-click',
} as const;

type EventKey = (typeof EVENT_KEY)[keyof typeof EVENT_KEY];

@localized()
@customElement('pv-setting-panel')
export class PvSettingPanel extends SignalWatcher(LitElement) {
  @property({type: Object})
  state!: State;

  @property({type: Object})
  modelManager?: ModelManager;

  @property({type: Boolean})
  enableDebugModelImport = false;

  @property({type: Boolean})
  localActivationAllowed = false;

  static styles = css`
    :host {
      background: var(--color-background);
      display: flex;

      --md-icon-button-icon-size: 3rem;
      --md-icon-button-state-layer-width: 4rem;
      --md-icon-button-state-layer-height: 4rem;

      --mdc-typography-body2-font-size: 3rem;
      --mdc-typography-body2-line-height: 3.5rem;
    }

    #form-id {
      box-sizing: border-box;
      max-height: min(70vh, 520px);
      overflow-y: auto;
      width: min(80vw, 560px);
    }

    .voice-config-slider {
      display: inline-block;
      width: 350px;
    }

    .form-section {
      margin: 1rem 0;
    }

    .form-section-columns {
      display: flex;
    }

    .form-section-column {
      flex: 1;
    }

    .language-select {
      border: 1px solid var(--md-sys-color-outline, #79747e);
      border-radius: var(--md-sys-shape-corner-extra-small, 4px);
      display: inline-flex;
      height: 5rem;
      overflow-x: hidden;
      overflow-y: scroll;
    }

    .language-option {
      border-color: black;
      display: flex;
      margin: 0.75rem 8px;
    }

    .language-option-label {
      flex: 1;
    }

    .language-option-checkbox {
      flex: 0;
      margin: 0 0 0 0.75rem;
    }

    .pv-persona-text-field,
    .pv-initial-phrase-text-field {
      width: 100%;
    }
  `;

  @property({type: Number, reflect: true})
  private activeSettingsTabIndex = 0;

  @query('#settings-dialog')
  private settingsDialog?: HTMLDialogElement;

  @query('#remove-model-dialog')
  private removeModelDialog?: HTMLDialogElement;

  @state()
  private showRemoveConfirm = false;

  private removeTrigger: HTMLElement | null = null;

  show() {
    this.settingsDialog?.show();
  }

  fireEvent(key: EventKey) {
    this.dispatchEvent(
      new CustomEvent(key, {
        detail: {callee: this},
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async onInferenceModeChange(mode: 'cloud' | 'local') {
    if (
      mode === 'local' &&
      this.state.inferenceMode !== 'local' &&
      !this.localActivationAllowed
    ) {
      return;
    }
    this.state.inferenceMode = mode;
    if (mode === 'local') await this.modelManager?.startup(true);
  }

  private onRequestModelRemoval(event: CustomEvent<{trigger: HTMLElement}>) {
    this.removeTrigger = event.detail.trigger;
    this.showRemoveConfirm = true;
  }

  private onRemoveDialogClosed() {
    this.showRemoveConfirm = false;
    this.removeTrigger?.focus();
    this.removeTrigger = null;
  }

  private async executeRemoveModel() {
    this.showRemoveConfirm = false;
    const manifest = this.modelManager?.getActiveManifest();
    if (manifest) {
      await this.modelManager?.removeModel(manifest.modelId, manifest.version);
    }
    this.removeModelDialog?.close();
  }

  render() {
    // The text field is not re-rendered even when initialPhrases are updated.
    // TODO: Re-render the text field when initialPhrases are updated.
    const profileSettingsPanelTemplate = html`
      <div class="form-section">
        <label>
          ${msg('Persona')}
          <p>
            <md-filled-text-field
              class="pv-persona-text-field"
              type="textarea"
              rows="5"
              @input=${(e: Event) => {
                this.state.persona = (e.target as HTMLTextAreaElement).value;
              }}
              value="${this.state.persona}"
            >
            </md-filled-text-field>
          </p>
        </label>
      </div>
      <div class="form-section">
        <label>
          ${msg('Initial phrases')}
          <p>
            <md-filled-text-field
              class="pv-initial-phrase-text-field"
              type="textarea"
              rows="3"
              value="${this.state.initialPhrases.join('\n')}"
              @input=${(e: Event) => {
                this.state.initialPhrases = (e.target as HTMLInputElement).value
                  .split('\n')
                  .filter(str => str);
              }}
            >
            </md-filled-text-field>
          </p>
        </label>
      </div>
    `;

    const generalSettingsPanelTemplate = html`
      <div class="form-section">
        <md-outlined-select
          label="${msg('Inference Source')}"
          @change=${(e: Event) => {
            const selected = e.composedPath()[0] as HTMLSelectElement;
            void this.onInferenceModeChange(
              selected.value as 'cloud' | 'local',
            );
          }}
        >
          <md-select-option
            ?selected="${this.state.inferenceMode === 'cloud'}"
            value="cloud"
          >
            <div slot="headline">${msg('Cloud (Gemini)')}</div>
          </md-select-option>
          <md-select-option
            ?disabled=${!this.localActivationAllowed &&
            this.state.inferenceMode !== 'local'}
            ?selected="${this.state.inferenceMode === 'local'}"
            title=${!this.localActivationAllowed &&
            this.state.inferenceMode !== 'local'
              ? msg('On-device activation is not available for this rollout.')
              : ''}
            value="local"
          >
            <div slot="headline">${msg('On-device')}</div>
          </md-select-option>
        </md-outlined-select>
        ${!this.localActivationAllowed && this.state.inferenceMode !== 'local'
          ? html`<div role="status" aria-live="polite">
              ${msg('On-device activation is not available for this rollout.')}
            </div>`
          : ''}
      </div>
      ${this.state.inferenceMode === 'cloud'
        ? html`
            <div class="form-section">
              <md-outlined-select
                label="${msg('Cloud AI Model')}"
                @change=${(e: Event) => {
                  const selected = e.composedPath()[0] as HTMLSelectElement;
                  this.state.aiConfig = selected.value;
                }}
              >
                <md-select-option
                  ?selected="${this.state.aiConfig === 'gemini_3_1_flash_lite'}"
                  value="gemini_3_1_flash_lite"
                >
                  <div slot="headline">Gemini 3.1 Flash Lite</div>
                </md-select-option>
                <md-select-option
                  ?selected="${this.state.aiConfig === 'gemini_3_flash'}"
                  value="gemini_3_flash"
                >
                  <div slot="headline">Gemini 3 Flash Preview</div>
                </md-select-option>
              </md-outlined-select>
            </div>
          `
        : html`
            <pv-on-device-model-card
              .modelManager=${this.modelManager}
              .enableDebugModelImport=${this.enableDebugModelImport}
              .allowModelInstallation=${this.localActivationAllowed}
              @switch-to-cloud=${() => void this.onInferenceModeChange('cloud')}
              @request-model-removal=${(
                event: CustomEvent<{trigger: HTMLElement}>,
              ) => this.onRequestModelRemoval(event)}
            ></pv-on-device-model-card>
          `}
      <div class="form-section-columns">
        <div class="form-section-column">
          <div class="form-section">
            <label>
              ${msg('Always expand at origin')}
              <md-switch
                ?selected=${this.state.expandAtOrigin}
                @change=${() => {
                  this.state.expandAtOrigin = !this.state.expandAtOrigin;
                }}
              ></md-switch>
            </label>
          </div>
          <div class="form-section">
            <label>
              ${msg('Use smaller sentence margin')}
              <md-switch
                ?selected=${this.state.sentenceSmallMargin}
                @change=${() => {
                  this.state.sentenceSmallMargin =
                    !this.state.sentenceSmallMargin;
                }}
              ></md-switch>
            </label>
          </div>
          <div class="form-section">
            <label>
              ${msg('Enable earcons')}
              <md-switch
                ?selected=${this.state.enableEarcons}
                @change=${() => {
                  this.state.enableEarcons = !this.state.enableEarcons;
                }}
              ></md-switch>
            </label>
          </div>
        </div>
        <div class="form-section-column"></div>
      </div>
      <div class="form-section">
        <div>
          <label>${msg('Language')}</label>
        </div>
        <div class="language-select">
          <div>
            ${Object.entries(LANGUAGES).map(
              ([label, lang]) =>
                html`<div class="language-option">
                  <div class="language-option-label">
                    <label>${lang.render()}</label>
                  </div>
                  <div class="language-option-checkbox">
                    <md-checkbox
                      ?checked="${this.state.checkedLanguages.includes(label)}"
                      ?disabled="${this.state.checkedLanguages.length === 1 &&
                      this.state.checkedLanguages.includes(label)}"
                      @change=${() => {
                        if (this.state.checkedLanguages.includes(label)) {
                          this.state.checkedLanguages =
                            this.state.checkedLanguages.filter(
                              lang => lang !== label,
                            );
                        } else {
                          this.state.checkedLanguages = [
                            ...this.state.checkedLanguages,
                            label,
                          ];
                        }
                      }}
                    ></md-checkbox>
                  </div>
                </div>`,
            )}
          </div>
        </div>
      </div>
    `;

    const ttsSettingsPanelTemplate = html`
      <div class="form-section">
        <md-outlined-select
          label="${msg('TTS Voice')}"
          @change=${(e: Event) => {
            const selected = e.target;
            this.state.voiceName = (selected as HTMLSelectElement).value;
            this.requestUpdate();
          }}
        >
          <md-select-option
            value="Default"
            ?selected="${this.state.voiceName === ''}"
          >
            <div slot="headline">Default</div>
          </md-select-option>
          ${window.speechSynthesis
            .getVoices()
            .filter(voice => voice.lang.startsWith(this.state.lang.code))
            .map(
              voice =>
                html`<md-select-option
                  value="${voice.name}"
                  ?selected="${this.state.voiceName === voice.name}"
                >
                  <div slot="headline">${voice.name}</div>
                </md-select-option>`,
            )}
        </md-outlined-select>
      </div>

      <div class="form-section">
        <label>
          ${msg('Speaking rate')}
          <md-slider
            class="voice-config-slider"
            min="-10"
            max="10"
            value="${this.state.voiceSpeakingRate}"
            @change=${(e: Event) => {
              this.state.voiceSpeakingRate = Number(
                (e.target as HTMLInputElement).value,
              );
            }}
          >
          </md-slider>
        </label>
      </div>
      <div class="form-section">
        <label>
          ${msg('Pitch')}
          <md-slider
            class="voice-config-slider"
            min="-10"
            max="10"
            value="${this.state.voicePitch}"
            @change=${(e: Event) => {
              this.state.voicePitch = Number(
                (e.target as HTMLInputElement).value,
              );
            }}
          >
          </md-slider>
        </label>
      </div>
    `;

    const tabs = [
      {
        label: msg('General'),
        template: generalSettingsPanelTemplate,
      },
      {
        label: msg('Profile'),
        template: profileSettingsPanelTemplate,
      },
      {
        label: msg('VOICE'),
        template: ttsSettingsPanelTemplate,
      },
    ];

    return html`
      <md-dialog id="settings-dialog">
        <form slot="content" id="form-id" method="dialog">
          <md-tabs
            @change="${(e: Event) => {
              if (e.target instanceof MdTabs) {
                this.activeSettingsTabIndex = e.target.activeTabIndex;
              }
            }}"
          >
            ${tabs.map(
              (tab, index) => html`
                <md-primary-tab
                  ?active="${this.activeSettingsTabIndex === index}"
                >
                  ${tab.label}
                </md-primary-tab>
              `,
            )}
          </md-tabs>
          ${tabs[this.activeSettingsTabIndex]?.template}
        </form>
        <div slot="actions">
          <md-text-button
            form="form-id"
            @click="${() => {
              // TODO: Revert the change when cancelled.
              this.settingsDialog?.close();
              this.fireEvent(EVENT_KEY.okClick);
            }}"
            >OK</md-text-button
          >
        </div>
      </md-dialog>
      <md-dialog
        id="remove-model-dialog"
        role="alertdialog"
        aria-labelledby="remove-model-headline"
        aria-describedby="remove-model-content"
        .open=${this.showRemoveConfirm}
        @closed=${this.onRemoveDialogClosed}
      >
        <div slot="headline" id="remove-model-headline">
          ${msg('Remove Local Model?')}
        </div>
        <div slot="content" id="remove-model-content">
          ${msg(
            'This will delete the downloaded model weights from your device and free storage space. You can download it again at any time.',
          )}
        </div>
        <div slot="actions">
          <md-text-button @click=${() => this.removeModelDialog?.close()}>
            ${msg('Cancel')}
          </md-text-button>
          <md-filled-button @click=${this.executeRemoveModel}>
            ${msg('Remove Model')}
          </md-filled-button>
        </div>
      </md-dialog>
    `;
  }
}
