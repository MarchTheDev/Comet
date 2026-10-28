import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FolderTreePicker, MovePicker } from '../src/MovePicker.tsx';
import { UploadProgress, UPLOAD_FEEDBACK_MS } from '../src/UploadProgress.tsx';

let failures = 0;
function check(name, ok) { if (ok) console.log(`  ok   ${name}`); else { failures++; console.log(`  FAIL ${name}`); } }
console.log('\nfolder picker and upload feedback');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'https://comet-upload.test/' });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.Node = dom.window.Node; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const root = createRoot(document.getElementById('root'));
const vault = 'comet-sample://vault';
const file = { path: `${vault}/Folder/old.md`, name: 'old.md', kind: 'file', children: [] };
const nested = { path: `${vault}/Folder/Nested`, name: 'Nested', kind: 'folder', children: [] };
const tree = [{ path: `${vault}/Folder`, name: 'Folder', kind: 'folder', children: [nested, file] }];
let destination = vault;
function Capture() {
  const [selected, setSelected] = useState(vault);
  return React.createElement(FolderTreePicker, { tree, vault, name: 'Workspace', destination: selected, onDestination: value => { destination = value; setSelected(value); } });
}
const click = async element => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
await act(async () => root.render(React.createElement(Capture)));
check('capture picker displays an expandable folder tree without selectable files', !!document.querySelector('.move-folder-list') && !document.querySelector('[data-move-file]'));
await click([...document.querySelectorAll('.move-folder-select')].find(element => element.textContent.trim() === 'Nested'));
check('capture picker selects nested destinations', destination === nested.path && document.querySelector('.move-folder-select[aria-pressed="true"]')?.textContent.includes('Nested'));
await act(async () => root.render(React.createElement(MovePicker, { item: file, tree, vault, name: 'Workspace', destination: vault, onDestination() {}, onClose() {}, onMove() {} })));
check('Move to still shows files under expanded folders', !!document.querySelector(`[data-move-file="${file.path}"]`));
const scheduled=new Map(), realTimeout=dom.window.setTimeout, realClear=dom.window.clearTimeout;let nextTimer=0;
dom.window.setTimeout=(callback,ms)=>{const id=++nextTimer;scheduled.set(id,{callback,ms});return id;};dom.window.clearTimeout=id=>scheduled.delete(id);
const base = { id: 'batch', total: 2, completed: 0, current: 'large.bin', phase: 'copying' };
let dismissed = '';
await act(async () => root.render(React.createElement(UploadProgress, { uploads: [base], onDismiss: id => { dismissed = id; } })));
check('native copying is shown as indeterminate rather than fake byte progress', document.querySelector('progress') && !document.querySelector('progress').hasAttribute('value') && document.querySelector('.upload-card').textContent.includes('large.bin'));
await act(async () => root.render(React.createElement(UploadProgress, { uploads: [{ ...base, phase: 'reading', loaded: 35, bytes: 100 }], onDismiss() {} })));
check('measured browser reads display their real fraction', document.querySelector('progress').value === .35);
await act(async () => root.render(React.createElement(UploadProgress, { uploads: [{ ...base, phase: 'failed', completed: 1, errors: ['existing.md already exists'] }], onDismiss: id => { dismissed = id; } })));
check('partial failures retain file counts and errors', document.querySelector('.upload-card').textContent.includes('1 of 2') && document.querySelector('.upload-errors').textContent.includes('existing.md'));
check('failed feedback is scheduled for automatic dismissal within 5–10 seconds',UPLOAD_FEEDBACK_MS>=5000&&UPLOAD_FEEDBACK_MS<=10000&&[...scheduled.values()].some(timer=>timer.ms===UPLOAD_FEEDBACK_MS));
await click(document.querySelector('[aria-label="Dismiss upload"]'));
check('completed or failed upload feedback can be dismissed', dismissed === 'batch');
await act(async()=>root.render(React.createElement(UploadProgress,{uploads:[],onDismiss(){}})));
check('manual dismissal clears its pending timer',scheduled.size===0);
dismissed='';await act(async()=>root.render(React.createElement(UploadProgress,{uploads:[{...base,phase:'done'}],onDismiss:id=>{dismissed=id;}})));
const timer=[...scheduled.values()][0];await act(async()=>timer.callback());
check('successful feedback also dismisses automatically',dismissed==='batch'&&timer.ms===UPLOAD_FEEDBACK_MS);
await act(async () => root.unmount());dom.window.setTimeout=realTimeout;dom.window.clearTimeout=realClear; dom.window.close(); delete globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
