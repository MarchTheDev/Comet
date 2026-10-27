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
  { id: 'first', text: 'First', done: false, notes: '', x: 40, y: 50, categoryId: null },
  { id: 'second', text: 'Second', done: false, notes: '', x: 400, y: 130, categoryId: null },
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
await fire(document.querySelector('.todo-link-hit'), new dom.window.MouseEvent('click', { bubbles: true }));
await fire(document.querySelector('.todo-link-remove'), new dom.window.MouseEvent('click', { bubbles: true }));
check('removing a connection keeps both tasks', current.connections.length === 0 && current.tasks.length === 2);

const categories = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Categories');
await fire(categories, new dom.window.MouseEvent('click', { bubbles: true }));
const addCategory = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Add category');
await fire(addCategory, new dom.window.MouseEvent('click', { bubbles: true }));
check('creates editable categories without creating workflow lines', current.categories.length === 1 && current.connections.length === 0);
await act(async () => root.unmount());
dom.window.close();
delete globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
