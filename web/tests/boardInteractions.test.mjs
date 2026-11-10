import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TodoBoard } from '../src/TodoBoard.tsx';
import { newTodoDocument } from '../src/utils/todo.ts';

let failures = 0;
function check(name, ok) { if (ok) console.log(`  ok   ${name}`); else { failures++; console.log(`  FAIL ${name}`); } }
console.log('\nto-do canvas interactions');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'https://comet.test/' });
dom.window.HTMLElement.prototype.attachEvent = function(name, listener) { this.addEventListener(name.replace(/^on/, ''), listener); };
dom.window.HTMLElement.prototype.detachEvent = function(name, listener) { this.removeEventListener(name.replace(/^on/, ''), listener); };
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const initial = newTodoDocument();
initial.tasks = [
  { id: 'first', text: 'First', done: false, notes: '', x: 40, y: 50, categoryId: null, subtasks: [] },
  { id: 'second', text: 'Second', done: false, notes: '', x: 400, y: 130, categoryId: null, subtasks: [] },
];
let current = initial, rejectChange = false, setTestBoard;
function Harness() {
  const [board, setBoard] = useState(initial);
  setTestBoard = setBoard;
  return React.createElement(TodoBoard, { board, name: 'Plan', saveState: 'saved', onRetry() {}, onChange(next) { if (rejectChange) return false; current = next; setBoard(next); return true; } });
}
const root = createRoot(document.getElementById('root'));
await act(async () => root.render(React.createElement(Harness)));
const pointer = (type, x, y) => { const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }); Object.defineProperty(event, 'pointerId', { value: 1 }); return event; };
const fire = async (element, event) => { await act(async () => { element.dispatchEvent(event); }); };
check('opens without workflow connections or default lines', !document.querySelector('.todo-link-line') && !document.querySelector('.todo-connections'));
await fire(document.querySelector('[aria-label="Drag First"]'), pointer('pointerdown', 10, 10));
await fire(window, pointer('pointermove', 90, 70));
await fire(window, pointer('pointerup', 90, 70));
check('dragging a task saves its freeform position', current.tasks[0].x === 120 && current.tasks[0].y === 110);

document.elementFromPoint = () => document.querySelector('[data-todo-id="second"]');
await fire(document.querySelector('[aria-label="Connect First to another to-do"]'), pointer('pointerdown', 20, 20));
await fire(window, pointer('pointermove', 80, 80));
await fire(window, pointer('pointerup', 80, 80));
check('dragging the dot connects two tasks', current.connections.length === 1 && current.connections[0].from === 'first' && current.connections[0].to === 'second' && !!document.querySelector('.todo-link-line'));
check('connection arrowheads are off by default', !document.querySelector('.todo-link-line').hasAttribute('marker-end'));
await fire(document.querySelector('.todo-link-hit'), new dom.window.MouseEvent('click', { bubbles: true }));
await fire(document.querySelector('[aria-label="Color connection from First to Second"]'), new dom.window.MouseEvent('click', { bubbles: true }));
await fire(document.querySelector('[aria-label="Choose #e78383"]'), new dom.window.MouseEvent('click', { bubbles: true }));
check('connection color is editable and persisted in the board', current.connections[0].color === '#e78383');
check('selection highlight is an SVG path following the curve', document.querySelector('.todo-link-selection')?.getAttribute('d') === document.querySelector('.todo-link-line')?.getAttribute('d'));
await fire(document.querySelector('.todo-canvas-inner'), pointer('pointerdown', 1000, 900));
check('clicking blank canvas after a color change deselects the connection', !document.querySelector('.todo-link-controls') && !document.querySelector('.todo-connections-svg g.selected'));
await fire(document.querySelector('.todo-link-hit'), new dom.window.MouseEvent('click', { bubbles: true }));
await fire(document.querySelector('.todo-link-remove'), new dom.window.MouseEvent('click', { bubbles: true }));
check('removing a connection keeps both tasks', current.connections.length === 0 && current.tasks.length === 2);
await fire(document.querySelector('[data-todo-id="first"]'), new dom.window.MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 40, clientY: 40 }));
check('right-click exposes useful to-do actions', document.querySelector('.todo-context-menu')?.textContent.includes('Add item'));
const addItem = [...document.querySelectorAll('.todo-context-menu button')].find(button => button.textContent === 'Add item');
await fire(addItem, new dom.window.MouseEvent('click', { bubbles: true }));
const itemInput = document.querySelector('[aria-label="New item for First"]');
await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(itemInput, 'Meeting'); const property = new dom.window.Event('propertychange', { bubbles: true }); Object.defineProperty(property, 'propertyName', { value: 'value' }); itemInput.dispatchEvent(property); itemInput.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
await fire(document.querySelector('.todo-subtask-add'), new dom.window.Event('submit', { bubbles: true, cancelable: true }));
check('adds a named sub-item without changing the parent title', current.tasks[0].text === 'First' && current.tasks[0].subtasks[0]?.text === 'Meeting');
await fire(document.querySelector('[aria-label="Zoom board in"]'), new dom.window.MouseEvent('click', { bubbles: true }));
check('board has working zoom controls', document.querySelector('.todo-zoom-reset').textContent === '120%');

const categories = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Categories');
await fire(categories, new dom.window.MouseEvent('click', { bubbles: true }));
const addCategory = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Add category');
await fire(addCategory, new dom.window.MouseEvent('click', { bubbles: true }));
check('creates editable categories without creating workflow lines', current.categories.length === 1 && current.connections.length === 0);
// Include both current task links and legacy list links in the clear-all fixture.
const category = current.categories[0].id;
const populated = { ...current, categories: [...current.categories, { id: 'legacy-category', title: 'Legacy', color: '#9c9fe1' }], connections: [{ from: 'first', to: 'second', color: '#9c9fe1' }], legacyListConnections: [{ from: category, to: 'legacy-category' }] };
await act(async () => { current = populated; setTestBoard(populated); });
check('clear-all fixture includes both current and legacy connections', current.connections.length === 1 && current.legacyListConnections.length === 1);
const beforeClear = JSON.stringify(current);
await fire([...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Clear board'), new dom.window.MouseEvent('click', { bubbles: true }));
check('clear to-do board asks for confirmation and focuses Cancel', document.querySelector('[role="alertdialog"]')?.textContent.includes('categories and connections') && document.activeElement.textContent === 'Cancel');
await fire(document.querySelector('[role="alertdialog"]'), new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
check('Escape cancels clearing without changing the to-do board', !document.querySelector('[role="alertdialog"]') && JSON.stringify(current) === beforeClear);
await fire([...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Clear board'), new dom.window.MouseEvent('click', { bubbles: true }));
rejectChange = true; await fire([...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Clear board'), new dom.window.MouseEvent('click', { bubbles: true }));
check('a rejected clear keeps to-dos and categories intact', !!document.querySelector('[role="alertdialog"] [role="alert"]') && JSON.stringify(current) === beforeClear);
rejectChange = false; await fire([...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Clear board'), new dom.window.MouseEvent('click', { bubbles: true }));
check('confirmed clear removes tasks, categories and both types of links, not the board', current.format === 'comet-todo' && !current.tasks.length && !current.categories.length && !current.connections.length && !current.legacyListConnections.length && [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Clear board').disabled);
await act(async () => root.unmount());
dom.window.close();
delete globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
