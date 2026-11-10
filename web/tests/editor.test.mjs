import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { loadMarkdownNote } from '../src/utils/editor.ts';

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}`); }
}

console.log('\neditor history');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
let updates = 0;
const editor = new Editor({
  element: document.createElement('div'),
  extensions: [StarterKit, Markdown],
  content: '# First note\n\nOriginal content',
  contentType: 'markdown',
  onUpdate: () => { updates += 1; },
});
editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' previous edit');
check('edits in a note are undoable', editor.can().undo());
const updatesBeforeSwitch = updates;
loadMarkdownNote(editor, '# Second note\n\nDifferent content');
check('loading a note does not emit an edit', updates === updatesBeforeSwitch);
check('undo history does not cross note boundaries', !editor.can().undo() && editor.getMarkdown().includes('Second note'));
editor.commands.undo();
check('undo cannot restore content from the previous note', !editor.getMarkdown().includes('previous edit'));
editor.commands.insertContent(' new edit');
check('undo is available again after editing the new note', editor.can().undo());
editor.commands.undo();
check('undo still works within the current note', !editor.getMarkdown().includes('new edit') && editor.getMarkdown().includes('Second note'));
editor.destroy();
dom.window.close();

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
