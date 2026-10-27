import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPage } from '../src/SettingsPage.tsx';
import { DEFAULT_SETTINGS } from '../src/utils/settings.ts';

let failures = 0;
function check(name, ok) { if (ok) console.log(`  ok   ${name}`); else { failures++; console.log(`  FAIL ${name}`); } }
console.log('\nscale slider interactions');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'https://comet-settings.test/' });
dom.window.HTMLElement.prototype.attachEvent = function(name, listener) { this.addEventListener(name.replace(/^on/, ''), listener); };
dom.window.HTMLElement.prototype.detachEvent = function(name, listener) { this.removeEventListener(name.replace(/^on/, ''), listener); };
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.Node = dom.window.Node; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
let current = DEFAULT_SETTINGS;
function Harness() { const [settings, setSettings] = useState(DEFAULT_SETTINGS); return React.createElement(SettingsPage, { settings, persisted: true, isSample: true, modifier: 'Ctrl', desktop: false, trayAvailable: false, onBack() {}, onOpenVault() {}, onChange(patch) { setSettings(previous => { current = { ...previous, ...patch }; return current; }); } }); }
const root = createRoot(document.getElementById('root')); await act(async () => root.render(React.createElement(Harness)));
const slider = document.querySelector('[aria-label="App scale"]');
await act(async () => { slider.focus(); slider.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(slider, '130'); const property = new dom.window.Event('propertychange', { bubbles: true }); Object.defineProperty(property, 'propertyName', { value: 'value' }); slider.dispatchEvent(property); slider.dispatchEvent(new dom.window.Event('input', { bubbles: true })); slider.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
check('dragging the slider does not apply the new app scale yet', current.interfaceScale === 100 && slider.value === '130');
await act(async () => slider.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 })));
check('releasing the slider commits its last value', current.interfaceScale === 130);
check('desktop-only startup and tray controls are unavailable in the browser sample', [...document.querySelectorAll('[aria-label="Launch at system login"], [aria-label="Start in the system tray"], [aria-label="Close to the system tray"]')].every(input => input.disabled));
await act(async () => root.unmount()); dom.window.close(); delete globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
