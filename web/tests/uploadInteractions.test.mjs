import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FolderTreePicker, MovePicker } from '../src/MovePicker.tsx';
import { UploadProgress, UPLOAD_FEEDBACK_MS, UPLOAD_EXIT_MS } from '../src/UploadProgress.tsx';
import { readFileSync } from 'node:fs';

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
check('manual dismissal cancels feedback and retains an inert card for its exit',![...scheduled.values()].some(timer=>timer.ms===UPLOAD_FEEDBACK_MS)&&document.querySelector('.upload-card.is-leaving')?.hasAttribute('inert')&&document.querySelector('.upload-card.is-leaving')?.getAttribute('aria-hidden')==='true');
check('leaving lasts just long enough for the exit animation',[...scheduled.values()].some(timer=>timer.ms===UPLOAD_EXIT_MS)&&UPLOAD_EXIT_MS>0&&UPLOAD_EXIT_MS<1000);
// Reappearing with the same ID must cancel the pending removal.
dismissed='';await act(async()=>root.render(React.createElement(UploadProgress,{uploads:[{...base,phase:'done'}],onDismiss:id=>{dismissed=id;}})));
check('re-adding a card cancels its exit without duplicating it',document.querySelectorAll('.upload-card').length===1&&!document.querySelector('.is-leaving')&&![...scheduled.values()].some(timer=>timer.ms===UPLOAD_EXIT_MS));
const feedback=[...scheduled.entries()].find(([,timer])=>timer.ms===UPLOAD_FEEDBACK_MS);scheduled.delete(feedback[0]);await act(async()=>feedback[1].callback());
check('successful feedback also dismisses automatically',dismissed==='batch'&&feedback[1].ms===UPLOAD_FEEDBACK_MS);
await act(async()=>root.render(React.createElement(UploadProgress,{uploads:[{...base,id:'other',phase:'copying'}],onDismiss(){}})));
check('one card can leave while another upload remains active',document.querySelectorAll('.upload-card').length===2&&document.querySelector('.upload-card.is-leaving')&&document.querySelector('.upload-card.copying:not(.is-leaving)'));
const exit=[...scheduled.entries()].find(([,timer])=>timer.ms===UPLOAD_EXIT_MS);scheduled.delete(exit[0]);await act(async()=>exit[1].callback());
check('the exited card is removed without interrupting the active upload',document.querySelectorAll('.upload-card').length===1&&document.querySelector('.upload-card.copying'));
const css=readFileSync('src/index.css','utf8');
check('upload cards define enter and exit animation with reduced-motion support',css.includes('upload-card-in')&&css.includes('upload-card-out')&&/prefers-reduced-motion:reduce[^}]*\.upload-card/.test(css));
await act(async()=>root.render(React.createElement(UploadProgress,{uploads:[],onDismiss(){}})));
await act(async () => root.unmount());check('unmount cleans up pending exit and feedback timers',scheduled.size===0);
// Reduced motion removes immediately instead of retaining a non-animated card.
dom.window.matchMedia=()=>({matches:true});
const reducedRoot=createRoot(document.getElementById('root'));await act(async()=>reducedRoot.render(React.createElement(UploadProgress,{uploads:[base],onDismiss(){}})));
await act(async()=>reducedRoot.render(React.createElement(UploadProgress,{uploads:[],onDismiss(){}})));
check('reduced motion removes cards immediately without an exit timer',!document.querySelector('.upload-card')&&scheduled.size===0);
await act(async()=>reducedRoot.unmount());dom.window.setTimeout=realTimeout;dom.window.clearTimeout=realClear; dom.window.close(); delete globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
