import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TodoBoard } from '../src/TodoBoard.tsx';
import { newTodoDocument } from '../src/utils/todo.ts';

let failures = 0;
function check(name, ok) { if (ok) console.log(`  ok   ${name}`); else { failures++; console.log(`  FAIL ${name}`); } }
console.log('\nto-do canvas interactions');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'https://comet.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
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
let current = initial;
function Harness() {
  const [board, setBoard] = useState(initial);
  return React.createElement(TodoBoard, { board, name: 'Plan', saveState: 'saved', onRetry() {}, onChange(next) { current = next; setBoard(next); return true; } });
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
await fire(document.querySelector('.todo-link-remove'), new dom.window.MouseEvent('click', { bubbles: true }));
check('removing a connection keeps both tasks', current.connections.length === 0 && current.tasks.length === 2);
await fire(document.querySelector('[data-todo-id="first"]'), new dom.window.MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 40, clientY: 40 }));
check('right-click exposes useful to-do actions', document.querySelector('.todo-context-menu')?.textContent.includes('Add item'));
const addItem = [...document.querySelectorAll('.todo-context-menu button')].find(button => button.textContent === 'Add item');
await fire(addItem, new dom.window.MouseEvent('click', { bubbles: true }));
const itemInput = document.querySelector('[aria-label="New item for First"]');
await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(itemInput, 'Meeting'); itemInput.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
await fire(document.querySelector('.todo-subtask-add'), new dom.window.Event('submit', { bubbles: true, cancelable: true }));
check('adds a named sub-item without changing the parent title', current.tasks[0].text === 'First' && current.tasks[0].subtasks[0]?.text === 'Meeting');
await fire(document.querySelector('[aria-label="Zoom board in"]'), new dom.window.MouseEvent('click', { bubbles: true }));
check('board has working zoom controls', document.querySelector('.todo-zoom-reset').textContent === '120%');

const categories = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Categories');
await fire(categories, new dom.window.MouseEvent('click', { bubbles: true }));
const addCategory = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Add category');
await fire(addCategory, new dom.window.MouseEvent('click', { bubbles: true }));
check('creates editable categories without creating workflow lines', current.categories.length === 1 && current.connections.length === 0);
await act(async () => root.unmount());
dom.window.close();
delete globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
