/**
 * Board cards: sideways scrolling, the connector dot that follows the pointer,
 * to-dos that wrap and carry links, and the link dialog.
 */
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { Whiteboard, sidewaysWheelDistance } from '../src/Whiteboard.tsx';
import { TodoBoard } from '../src/TodoBoard.tsx';
import { connectorPlacement, trackConnectorDots, CONNECTOR_OUTSET } from '../src/utils/connectorDot.ts';
import {
  formatInlineLink,
  inlineLinkAt,
  insertInlineLink,
  normalizeLinkInput,
  parseInlineLinks,
  removeInlineLink,
} from '../src/utils/inlineLinks.ts';
import { newWhiteboard, newWhiteboardItem, parseWhiteboard, serializeWhiteboard } from '../src/utils/whiteboard.ts';
import { newTodoDocument, parseTodo, serializeTodo } from '../src/utils/todo.ts';

let failures = 0;
const check = (name, ok) => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`);
  }
};
const css = readFileSync('src/index.css', 'utf8');

// ---------------------------------------------------------------------------
console.log('\nlinks inside to-do text');
{
  const links = (text) => parseInlineLinks(text).filter((part) => part.kind === 'link');
  const bare = parseInlineLinks('Read https://example.com/a?b=1, then www.example.org.');
  check(
    'bare addresses become links and the punctuation after them stays text',
    bare.map((part) => part.kind).join() === 'text,link,text,link,text' &&
      bare[1].href === 'https://example.com/a?b=1' &&
      bare[1].text === 'https://example.com/a?b=1' &&
      bare[3].href === 'https://www.example.org/' &&
      bare[4].text === '.',
  );
  check(
    'every part maps back onto the saved text',
    bare.every((part) => 'Read https://example.com/a?b=1, then www.example.org.'.slice(part.start, part.end).includes(part.text)) &&
      bare.at(-1).end === 'Read https://example.com/a?b=1, then www.example.org.'.length,
  );
  const named = parseInlineLinks('See the [guide](https://example.com/guide) first');
  check(
    'a named link shows only its words',
    named.length === 3 && named[1].kind === 'link' && named[1].text === 'guide' && named[1].markdown === true &&
      named[1].href === 'https://example.com/guide' && named[1].labelStart === 9,
  );
  check(
    'only web addresses are ever turned into links',
    links('[x](javascript:alert(1)) [y](data:text/html,hi) file:///etc/passwd mailto:a@b.c').length === 0 &&
      normalizeLinkInput('javascript:alert(1)') === null &&
      normalizeLinkInput('mailto:someone@example.com') === null &&
      normalizeLinkInput('not a link') === null &&
      normalizeLinkInput('') === null,
  );
  check(
    'an address typed without https:// is completed',
    normalizeLinkInput(' example.com/docs ') === 'https://example.com/docs' &&
      normalizeLinkInput('http://example.com') === 'http://example.com/' &&
      normalizeLinkInput('localhost:1420') === 'https://localhost:1420/',
  );
  check(
    'a link with no words of its own is written as the bare address',
    formatInlineLink('', 'https://example.com/') === 'https://example.com/' &&
      formatInlineLink('the docs', 'https://example.com/') === '[the docs](https://example.com/)',
  );
  const linked = insertInlineLink('read the guide today', 9, 14, 'guide', 'https://example.com/g');
  check(
    'linking selected words keeps the rest of the to-do and puts the caret after the link',
    linked.text === 'read the [guide](https://example.com/g) today' && linked.caret === linked.text.indexOf(' today'),
  );
  const spaced = insertInlineLink('ab', 1, 1, '', 'https://example.com/');
  check('a bare address is kept apart from the words around it', spaced.text === 'a https://example.com/ b');
  const found = inlineLinkAt(linked.text, 12);
  const removed = found && removeInlineLink(linked.text, found);
  check(
    'the link under the caret can be found and removed, keeping its words',
    found?.href === 'https://example.com/g' && removed.text === 'read the guide today' && inlineLinkAt(linked.text, 2) === null,
  );
  const tricky = insertInlineLink('', 0, 0, 'a [b] c', 'https://example.com/wiki/Thing_(disambiguation)');
  const reparsed = links(tricky.text);
  check(
    'brackets in the words or the address do not break the link',
    reparsed.length === 1 && reparsed[0].href === new URL('https://example.com/wiki/Thing_%28disambiguation%29').href,
  );
}

// ---------------------------------------------------------------------------
console.log('\nconnector dot placement');
{
  const size = { width: 240, height: 150 };
  const at = (x, y, options) => connectorPlacement(size, { x, y }, options);
  check(
    'the dot goes to the edge nearest the pointer',
    at(5, 75).side === 'left' && at(235, 75).side === 'right' && at(120, 4).side === 'top' && at(120, 146).side === 'bottom',
  );
  check(
    'it sits just outside that edge, level with the pointer',
    at(235, 60).x === 240 + CONNECTOR_OUTSET && at(235, 60).y === 60 && at(100, 146).y === 150 + CONNECTOR_OUTSET && at(100, 146).x === 100 &&
      at(5, 75).x === -CONNECTOR_OUTSET && at(120, 4).y === -CONNECTOR_OUTSET,
  );
  check(
    'it stops short of the corners, where the resize handles are',
    at(239, 149, { previous: 'right' }).y < 150 - 10 && at(1, 1, { previous: 'top' }).x > 10,
  );
  check(
    'it does not flicker between two sides along a diagonal',
    at(120, 80, { previous: 'bottom' }).side === 'bottom' && at(120, 80, { previous: 'top' }).side === 'top' && at(120, 20, { previous: 'bottom' }).side === 'top',
  );
  check(
    'a side can be ruled out',
    at(120, 4, { sides: ['right', 'bottom', 'left'] }).side !== 'top',
  );
}

// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'https://comet-boards.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Element = dom.window.Element;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
// Animation frames are run by hand, so that eased scrolling settles inside a check.
let frames = [];
let frameId = 0;
dom.window.requestAnimationFrame = (callback) => {
  frames.push({ id: ++frameId, callback });
  return frameId;
};
dom.window.cancelAnimationFrame = (id) => {
  frames = frames.filter((frame) => frame.id !== id);
};
const settle = () => {
  for (let turn = 0; turn < 200 && frames.length; turn++) {
    const due = frames;
    frames = [];
    for (const frame of due) frame.callback(0);
  }
};
// React is loaded before this document exists, so it watches text fields the
// way it does in old browsers: through attachEvent and "propertychange".
dom.window.EventTarget.prototype.attachEvent = function attachEvent(name, listener) {
  this.addEventListener(name.replace(/^on/, ''), listener);
};
dom.window.EventTarget.prototype.detachEvent = function detachEvent(name, listener) {
  this.removeEventListener(name.replace(/^on/, ''), listener);
};
const opened = [];
dom.window.open = (url) => {
  opened.push(String(url));
  return null;
};

const fire = async (element, event) =>
  act(async () => {
    element.dispatchEvent(event);
    settle();
  });
const click = async (element) => fire(element, new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const pointer = (type, x, y, extra = {}) => {
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...extra });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: extra.pointerType ?? 'mouse' });
  return event;
};
const type = async (element, value) =>
  act(async () => {
    element.focus();
    const proto = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    const property = new dom.window.Event('propertychange', { bubbles: true });
    Object.defineProperty(property, 'propertyName', { value: 'value' });
    element.dispatchEvent(property);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
const key = (name, extra = {}) => new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra });
const box = (element, left, top, width, height) => {
  element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  for (const [name, value] of Object.entries({ offsetWidth: width, offsetHeight: height, offsetLeft: left, offsetTop: top, clientLeft: 1, clientTop: 1 })) {
    Object.defineProperty(element, name, { value, configurable: true });
  }
};

console.log('\nconnector dot tracking');
{
  const stage = document.createElement('div');
  stage.innerHTML =
    '<article class="card" id="a"><p>text</p><button class="todo-connect-dot"></button></article>' +
    '<article class="card" id="b"><button class="todo-connect-dot"></button></article>';
  document.body.append(stage);
  const [a, b] = stage.querySelectorAll('.card');
  box(a, 100, 100, 240, 150);
  box(b, 500, 100, 240, 150);
  const dotA = a.querySelector('.todo-connect-dot');
  const stop = trackConnectorDots(stage, '.card');
  a.querySelector('p').dispatchEvent(pointer('pointermove', 105, 160)); settle();
  check(
    'moving over a card brings its dot to the pointer',
    dotA.dataset.side === 'left' && dotA.classList.contains('is-following') && dotA.style.top === `${60 - 1 - 10.5}px` && dotA.style.left === `${-7 - 1 - 10.5}px`,
  );
  a.querySelector('p').dispatchEvent(pointer('pointermove', 220, 246)); settle();
  check('it follows the pointer on to another side', dotA.dataset.side === 'bottom' && dotA.style.left === `${120 - 1 - 10.5}px`);
  const placed = dotA.style.cssText;
  a.dispatchEvent(pointer('pointermove', 300, 110, { buttons: 1 })); settle();
  a.dispatchEvent(pointer('pointermove', 300, 110, { pointerType: 'touch' })); settle();
  check('a drag in progress or a finger does not move it', dotA.style.cssText === placed);
  // Half the size on screen: the board is zoomed out.
  a.getBoundingClientRect = () => ({ left: 100, top: 100, width: 120, height: 75, right: 220, bottom: 175 });
  a.dispatchEvent(pointer('pointermove', 217, 130)); settle();
  check('the position allows for the board being zoomed', dotA.dataset.side === 'right' && dotA.style.top === `${60 - 1 - 10.5}px`);
  b.dispatchEvent(pointer('pointermove', 510, 150)); settle();
  check(
    'moving to another card hands over to that card’s dot',
    !dotA.classList.contains('is-following') && b.querySelector('.todo-connect-dot').classList.contains('is-following'),
  );
  stage.dispatchEvent(pointer('pointermove', 900, 600)); settle();
  check('leaving the cards lets the dot go', !stage.querySelector('.is-following'));
  stop();
  a.dispatchEvent(pointer('pointermove', 105, 160)); settle();
  check('tracking stops when the board closes', !stage.querySelector('.is-following'));
  stage.remove();
  check(
    'the dot keeps its resting place for keyboard and touch, and shows while it follows',
    /\.todo-connect-dot\s*\{[^}]*top:\s*37px/.test(css) && /\.todo-connect-dot\.is-following\s*\{[^}]*opacity:\s*1/.test(css),
  );
}

// ---------------------------------------------------------------------------
console.log('\nwhiteboard cards');
let current = newWhiteboard();
current = {
  ...current,
  items: [
    { ...newWhiteboardItem('text', 60, 60), text: '' },
    { ...newWhiteboardItem('todo', 360, 60), text: 'Read the guide' },
  ],
};
check('the test board is one the app would open', !!parseWhiteboard(serializeWhiteboard(current)));
function Harness() {
  const [board, setBoard] = useState(current);
  return React.createElement(Whiteboard, {
    board,
    name: 'Canvas',
    path: 'vault/Cards.comet-whiteboard',
    saveState: 'saved',
    onChange(next) {
      if (!parseWhiteboard(serializeWhiteboard(next))) return false;
      current = next;
      setBoard(next);
      return true;
    },
    onRename() {},
    onRetry() {},
  });
}
const root = createRoot(document.getElementById('root'));
await act(async () => root.render(React.createElement(Harness)));
const stage = document.querySelector('.whiteboard-stage');
const todoCard = () => document.querySelector('.whiteboard-item.whiteboard-todo');
const todoItem = () => current.items.find((item) => item.type === 'todo');

{
  check(
    'a turn of the wheel is measured in pixels whichever way the device reports it',
    sidewaysWheelDistance({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 800) === 120 &&
      sidewaysWheelDistance({ deltaX: -30, deltaY: 0, deltaMode: 0 }, 800) === -30 &&
      sidewaysWheelDistance({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 800) === 120 &&
      sidewaysWheelDistance({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 800) === -720,
  );
  Object.defineProperty(stage, 'clientWidth', { value: 500, configurable: true });
  Object.defineProperty(stage, 'scrollWidth', { value: 1800, configurable: true });
  stage.scrollLeft = 200;
  stage.scrollTop = 90;
  const wheel = (init) => new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  const plain = wheel({ deltaY: 120 });
  await fire(stage, plain);
  check('the wheel on its own is left to scroll up and down as before', !plain.defaultPrevented && stage.scrollLeft === 200);
  const right = wheel({ deltaY: 120, altKey: true });
  await fire(stage, right);
  check('Alt + wheel down moves the whiteboard to the right', right.defaultPrevented && stage.scrollLeft === 320 && stage.scrollTop === 90);
  await fire(stage, wheel({ deltaY: -120, altKey: true }));
  await fire(stage, wheel({ deltaY: -120, altKey: true }));
  check('Alt + wheel up moves it back to the left', stage.scrollLeft === 80);
  await fire(stage, wheel({ deltaY: -400, altKey: true }));
  check('it stops at the left edge', stage.scrollLeft === 0);
  await fire(stage, wheel({ deltaY: 5000, altKey: true }));
  check('and at the right edge', stage.scrollLeft === 1300);
  const inside = wheel({ deltaY: -120, altKey: true });
  await fire(todoCard().querySelector('.whiteboard-todo-list'), inside);
  check('with Alt held, a list under the pointer does not take the scroll instead', inside.defaultPrevented && stage.scrollLeft === 1180);
  const release = new dom.window.KeyboardEvent('keyup', { key: 'Alt', bubbles: true, cancelable: true });
  await fire(document.body, release);
  const later = new dom.window.KeyboardEvent('keyup', { key: 'Alt', bubbles: true, cancelable: true });
  await fire(document.body, later);
  check('letting go of Alt after scrolling does not open the window menu', release.defaultPrevented && !later.defaultPrevented);
  const zoomBefore = document.querySelector('.todo-canvas-inner')?.style.transform;
  const zoom = wheel({ deltaY: -120, ctrlKey: true });
  await fire(stage, zoom);
  check('Ctrl + wheel still zooms', zoom.defaultPrevented && stage.scrollLeft === 1180 && /11[0-9]%/.test(document.querySelector('.whiteboard')?.textContent ?? '') && zoomBefore !== undefined);
}

{
  const input = () => todoCard().querySelector('.whiteboard-todo-input');
  check(
    'a to-do is edited in a text area, which can wrap, and still shows its text when idle',
    input().tagName === 'TEXTAREA' && input().getAttribute('aria-label') === 'To-do text' &&
      todoCard().querySelector('.whiteboard-todo-shown').textContent === 'Read the guide',
  );
  check(
    'to-do text wraps to the card and the row grows with it',
    /\.whiteboard-todo-shown,\s*\.whiteboard-todo-field > \.whiteboard-todo-input\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/.test(css) &&
      /\.whiteboard-todo-field\s*\{[^}]*display:\s*grid/.test(css),
  );
  await type(input(), 'Read https://example.com/guide and\nthe [notes](https://example.org/notes).');
  check('a pasted line break becomes a space: one to-do is one line of thought', todoItem().text === 'Read https://example.com/guide and the [notes](https://example.org/notes).');
  check('while it is being edited the to-do shows exactly what is saved', todoCard().querySelector('.whiteboard-todo-field').classList.contains('is-editing') && !todoCard().querySelector('.whiteboard-todo-shown a'));
  await act(async () => input().blur());
  const anchors = [...todoCard().querySelectorAll('.whiteboard-todo-shown a')];
  check(
    'once editing ends, the addresses in it are links',
    anchors.length === 2 && anchors[0].getAttribute('href') === 'https://example.com/guide' && anchors[1].textContent === 'notes' &&
      todoCard().querySelector('.whiteboard-todo-shown').textContent === 'Read https://example.com/guide and the notes.',
  );
  await click(anchors[1]);
  check('clicking a link opens it', opened.length === 1 && opened[0] === 'https://example.org/notes' && document.activeElement !== input());
  const press = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  await fire(todoCard().querySelector('.whiteboard-todo-shown span'), press);
  check('clicking the words edits the to-do', document.activeElement === input() && press.defaultPrevented);

  // Link the selected words through the card's Link button.
  await type(input(), 'Read the guide');
  await act(async () => input().setSelectionRange(9, 14));
  await click(todoCard().querySelector('[aria-label="Add link to to-do"]'));
  const dialog = () => document.querySelector('.link-dialog');
  check(
    'the Link button asks for an address, with the selected words filled in',
    dialog()?.getAttribute('role') === 'dialog' && document.querySelector('#link-dialog-text').value === 'guide' &&
      document.activeElement === document.querySelector('#link-dialog-url') && dialog().parentElement.parentElement === document.body,
  );
  const submit = async () => fire(dialog(), new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await type(document.querySelector('#link-dialog-url'), 'javascript:alert(1)');
  await submit();
  check('an address that is not a web address is refused, and the to-do is untouched', !!dialog()?.querySelector('[role="alert"]') && todoItem().text === 'Read the guide');
  await type(document.querySelector('#link-dialog-url'), 'example.com/guide');
  await submit();
  check(
    'a web address links the selected words and returns to the to-do',
    !dialog() && todoItem().text === 'Read the [guide](https://example.com/guide)' && document.activeElement === input() &&
      input().selectionStart === todoItem().text.length,
  );
  check('the link is saved in the board file as ordinary text', parseWhiteboard(serializeWhiteboard(current))?.items[1].text === todoItem().text && current.version === newWhiteboard().version);

  // With the caret in a link, the same button edits or removes it.
  await act(async () => input().setSelectionRange(12, 12));
  await click(todoCard().querySelector('[aria-label="Add link to to-do"]'));
  const remove = [...(dialog()?.querySelectorAll('button') ?? [])].find((item) => item.textContent === 'Remove link');
  check('with the caret in a link, the button offers to change or remove it', dialog()?.querySelector('h2').textContent === 'Edit link' && document.querySelector('#link-dialog-url').value === 'https://example.com/guide' && !!remove);
  await click(remove);
  check('removing a link keeps its words', !dialog() && todoItem().text === 'Read the guide');

  // Escape leaves everything as it was.
  await click(todoCard().querySelector('[aria-label="Add link to to-do"]'));
  await fire(document.querySelector('#link-dialog-url'), key('Escape'));
  check('Escape closes the dialog without changing anything', !dialog() && todoItem().text === 'Read the guide');

  // With no to-do being edited, the link becomes a to-do of its own.
  await act(async () => document.activeElement.blur());
  await click(todoCard().querySelector('[aria-label="Add link to to-do"]'));
  await type(document.querySelector('#link-dialog-url'), 'https://example.net/');
  await type(document.querySelector('#link-dialog-text'), 'Changelog');
  await submit();
  check(
    'with no to-do selected, the link is added as a new to-do',
    todoItem().todos?.length === 1 && todoItem().todos[0].text === '[Changelog](https://example.net/)' &&
      document.activeElement.getAttribute('aria-label') === 'To-do item 2 text',
  );

  const heightBefore = todoItem().height;
  await fire(document.activeElement, key('Enter'));
  await fire(document.activeElement, key('Enter'));
  await click(todoCard().querySelector('[aria-label="Add to-do item"]'));
  check(
    'adding to-dos no longer stretches the card: the list scrolls inside it',
    todoItem().todos.length === 4 && todoItem().height === heightBefore && newWhiteboardItem('todo', 0, 0).height >= 190,
  );
  const composing = key('Enter');
  Object.defineProperty(composing, 'isComposing', { value: true });
  await fire(document.activeElement, composing);
  check('Enter that confirms an input-method word does not add a to-do', todoItem().todos.length === 4);
  check(
    'text boxes and to-do lists scroll like a Links card',
    /\.whiteboard-rich-editor,\s*\.whiteboard-todo-list,\s*\.whiteboard-link-list\s*\{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/.test(css),
  );
  check(
    'long words, addresses and link previews wrap inside a text box',
    /\.comet-editor-prose\.whiteboard-prose\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css.replace(/\.whiteboard-rich-editor > div,\s*/, '')) &&
      /\.whiteboard-prose \.comet-link-embed\s*\{[^}]*min-width:\s*0/.test(css),
  );
}

{
  const textCard = document.querySelector('.whiteboard-item.whiteboard-text');
  const add = textCard.querySelector('.whiteboard-text-toolbar [aria-label="Add link"]');
  check('a text box has an Add link button in its toolbar', !!add);
  await click(add);
  check(
    'with nothing selected it asks for the words as well as the address',
    !!document.querySelector('.link-dialog #link-dialog-text') && !!document.querySelector('.link-dialog #link-dialog-url'),
  );
  await type(document.querySelector('#link-dialog-url'), 'example.com/docs');
  await type(document.querySelector('#link-dialog-text'), 'the docs');
  await fire(document.querySelector('.link-dialog'), new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  const anchor = textCard.querySelector('.whiteboard-prose a[href]');
  check(
    'the link is written into the text box and saved with the board',
    !document.querySelector('.link-dialog') && anchor?.textContent === 'the docs' && anchor.getAttribute('href') === 'https://example.com/docs' &&
      /example\.com\/docs/.test(serializeWhiteboard(current)) && !!parseWhiteboard(serializeWhiteboard(current)),
  );
}

{
  const dot = todoCard().querySelector(':scope > .todo-connect-dot');
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 400 });
  Object.defineProperty(stage, 'offsetWidth', { value: 500, configurable: true });
  stage.scrollLeft = 0;
  stage.scrollTop = 0;
  box(todoCard(), 360, 60, 240, 200);
  await fire(todoCard(), pointer('pointermove', 480, 256));
  check('on a whiteboard the dot follows the pointer round its card', dot.dataset.side === 'bottom' && dot.classList.contains('is-following'));
  const textCard = document.querySelector('.whiteboard-item.whiteboard-text');
  document.elementFromPoint = () => textCard;
  await fire(dot, pointer('pointerdown', 480, 267));
  check('dragging from the dot starts a connection wherever the dot has moved to', !!document.querySelector('.todo-link-preview'));
  await fire(window, pointer('pointermove', 200, 120, { buttons: 1 }));
  await fire(window, pointer('pointerup', 200, 120));
  check(
    'dropping it on another card connects the two',
    current.connections.length === 1 && current.connections[0].from === todoItem().id && !document.querySelector('.todo-link-preview'),
  );
}
await act(async () => root.unmount());

// ---------------------------------------------------------------------------
console.log('\n.todo board cards');
{
  let todo = parseTodo(
    serializeTodo({ ...newTodoDocument(), tasks: [] }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  function TodoHarness() {
    const [board, setBoard] = useState(todo);
    return React.createElement(TodoBoard, {
      board,
      name: 'Tasks',
      path: 'vault/Tasks.comet-todo',
      saveState: 'saved',
      onChange(next) {
        todo = next;
        setBoard(next);
        return true;
      },
      onRename() {},
      onRetry() {},
    });
  }
  const todoRoot = createRoot(host);
  await act(async () => todoRoot.render(React.createElement(TodoHarness)));
  await type(host.querySelector('[aria-label="New to-do"]'), 'Plan the release');
  await fire(host.querySelector('.todo-create'), new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  const card = host.querySelector('.todo-card');
  const dot = card?.querySelector(':scope > .todo-connect-dot');
  check('a .todo card has a connector dot', !!dot);
  if (card && dot) {
    box(card, 100, 100, 270, 140);
    await fire(card, pointer('pointermove', 104, 170));
    const left = dot.dataset.side;
    await fire(card, pointer('pointermove', 240, 104));
    check('on a .todo board the dot follows the pointer round its card too', left === 'left' && dot.dataset.side === 'top' && dot.classList.contains('is-following'));
  }
  check(
    'text in a .todo card no longer gets the squared focus outline',
    /\.todo-card \.todo-task-text:focus-visible,\s*\.todo-subtask input:not\(\[type="checkbox"\]\):focus-visible,\s*\.todo-subtask-add input:focus-visible\s*\{\s*outline:\s*none/.test(css),
  );
  const rowStyle = (selector) => css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1].replace(/\s+/g, ' ').trim();
  check(
    'the row being edited is highlighted the same way as a whiteboard to-do',
    !!rowStyle('\\.whiteboard-todo-row:hover, \\.whiteboard-todo-row:focus-within') &&
      rowStyle('\\.todo-card-main:hover, \\.todo-card-main:focus-within,\\s*\\.todo-subtask:hover, \\.todo-subtask:focus-within') ===
        rowStyle('\\.whiteboard-todo-row:hover, \\.whiteboard-todo-row:focus-within') &&
      /\.todo-card-main, \.todo-subtask\s*\{\s*padding:\s*2px 3px;\s*border-radius:\s*6px/.test(css),
  );
  await act(async () => todoRoot.unmount());
}

dom.window.close();
delete globalThis.localStorage;
delete globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
