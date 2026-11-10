import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import {
  cometLinkExtension,
  findLinkMarkRange,
  noteBlockExtensions,
  replaceLinkDisplayText,
  splitHardBreaksBeforeListToggle,
} from '../src/utils/noteExtensions.ts';
import { richTextExtensions } from '../src/utils/richText.ts';
import { cleanNoteMarkdown, countWords, parseBlocks, toggleMarkdownTask } from '../src/utils/markdown.ts';
import {
  extractLinksFromText,
  isEmbedDismissed,
  LinkEmbeds,
  openExternalWebUrl,
  setEmbedDismissed,
} from '../src/utils/linkEmbeds.tsx';
import { VideoEmbeds } from '../src/utils/videoEmbeds.ts';
import {
  droppedBrowserLink,
  parseDroppedShortcutFile,
  serializeShortcut,
} from '../src/utils/links.ts';
import { displayEntryName, preserveRenamedExtension } from '../src/utils/vault.ts';
import { fileKind } from '../src/utils/fileTypes.ts';
import { MediaView } from '../src/MediaView.tsx';
import { CalendarView } from '../src/CalendarView.tsx';
import {
  newestUpdate,
  pickPlatformAsset,
  readUpdatePreferences,
  saveUpdatePreferences,
} from '../src/utils/updates.ts';
import { newWhiteboard, parseWhiteboard, serializeWhiteboard } from '../src/utils/whiteboard.ts';
import { findOpenWhiteboardSpot, resizeWhiteboardItem, Whiteboard } from '../src/Whiteboard.tsx';
import { newTodoDocument, parseTodo, serializeTodo } from '../src/utils/todo.ts';
import { TodoBoard } from '../src/TodoBoard.tsx';
import { BrainExplore } from '../src/ExploreViews.tsx';
import { SAMPLE_ROOT } from '../src/utils/sampleVault.ts';
import { WorkspacePanel, workspacePlacement } from '../src/WorkspacePanel.tsx';
import { emptyWorkspaceMeta, orderItems, renameMeta, reorderChildrenGroup } from '../src/utils/workspaceMeta.ts';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS } from '../src/utils/shortcuts.ts';
import { UndoHistory, undoRedoKey } from '../src/utils/undoHistory.ts';

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`);
  }
}

console.log('\nComet 1.0.1 features and fixes');

// 1. Version & CSS checks (italics, custom checkbox, sticky toolbar, link pointer cursor, no corner dots, shrink-wrapped titles)
const versionText = readFileSync('../VERSION', 'utf8').trim();
const webPkg = JSON.parse(readFileSync('package.json', 'utf8'));
const tauriConf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargoToml = readFileSync('src-tauri/Cargo.toml', 'utf8');
const pkgbuild = readFileSync('../packaging/arch/PKGBUILD', 'utf8');
const css = readFileSync('src/index.css', 'utf8');
const appSource = readFileSync('src/App.tsx', 'utf8');

check(
  'version manifests are synchronized to 1.0.1',
  versionText === '1.0.1' &&
    webPkg.version === '1.0.1' &&
    tauriConf.version === '1.0.1' &&
    /^version = "1\.0\.1"/m.test(cargoToml) &&
    /^pkgver=1\.0\.1$/m.test(pkgbuild),
);
check(
  'variable font allows synthesized oblique italics and explicit italic prose rules',
  css.includes('font-synthesis: style;') &&
    !css.includes('font-synthesis: none;') &&
    css.includes('.comet-editor-prose em'),
);
check(
  'checkboxes use custom themed appearance without overriding settings switches',
  css.includes('input[type="checkbox"]:not(.setting-toggle)') &&
    /input\[type="checkbox"\]:not\(\.setting-toggle\)\s*\{[^}]*appearance:\s*none/.test(css) &&
    css.includes('.comet-editor-prose li > ul, .comet-editor-prose li > ol'),
);
check(
  'note formatting toolbar is a rounded floating sticky dock and note-card does not clip sticky children',
  css.includes('.note-card { overflow: visible; }') &&
    /\.note-card\s*>\s*\.format-toolbar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*\d+(?:px)?;[^}]*border-radius:\s*\d+px;/.test(css) &&
    css.includes('.note-card > .format-toolbar.is-stuck'),
);
check(
  'links in notes always show pointer cursor on hover and open in write mode as well as read mode',
  /\.comet-editor-prose a\s*\{[^}]*cursor:\s*pointer;/.test(css) &&
    !appSource.includes('if (modeRef.current !== "read") return false;'),
);
check(
  'whiteboard resize corners have no visible corner dots and window title uses shrink-wrap auto-sizer',
  !css.includes('.whiteboard-resize::after') &&
    css.includes('.whiteboard-item-header .whiteboard-title-wrap') &&
    css.includes('content: attr(data-sizer)'),
);
check(
  'sidebar YOUR FILES heading is clickable and routes to the folders-only overview',
  appSource.includes('showOverview("folders")') &&
    appSource.includes('entries.filter((entry) => entry.kind === "folder")'),
);

// Set up JSDOM for TipTap + React component interaction checks
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'https://comet.local/',
});
dom.window.EventTarget.prototype.attachEvent = function attachEvent(name, listener) {
  this.addEventListener(name.replace(/^on/, ''), listener);
};
dom.window.EventTarget.prototype.detachEvent = function detachEvent(name, listener) {
  this.removeEventListener(name.replace(/^on/, ''), listener);
};
dom.window.SVGSVGElement.prototype.createSVGPoint = function createSVGPoint() {
  return {
    x: 0,
    y: 0,
    matrixTransform() {
      return { x: this.x, y: this.y };
    },
  };
};
dom.window.SVGSVGElement.prototype.getScreenCTM = () => ({ inverse: () => ({}) });
const prevGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  localStorage: globalThis.localStorage,
  Node: globalThis.Node,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  SVGElement: globalThis.SVGElement,
  HTMLInputElement: globalThis.HTMLInputElement,
  HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
  PointerEvent: globalThis.PointerEvent,
  InputEvent: globalThis.InputEvent,
  FocusEvent: globalThis.FocusEvent,
  MouseEvent: globalThis.MouseEvent,
  KeyboardEvent: globalThis.KeyboardEvent,
  MutationObserver: globalThis.MutationObserver,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  ResizeObserver: globalThis.ResizeObserver,
};

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.InputEvent = dom.window.InputEvent;
globalThis.FocusEvent = dom.window.FocusEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => dom.window.setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

if (!dom.window.PointerEvent) {
  class FakePointerEvent extends dom.window.MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  dom.window.PointerEvent = FakePointerEvent;
}
globalThis.PointerEvent = dom.window.PointerEvent;
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
// ProseMirror coordinate queries in JSDOM
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });

// 2. TipTap notes: italics, code fences, lists, NO &nbsp; / &amp;nbsp; on blank lines, and Discord-style dismissible link embeds
const makeNoteEditor = (markdown = '', scope = 'test-note') =>
  new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({
        paragraph: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        link: false,
      }),
      cometLinkExtension,
      ...noteBlockExtensions,
      ...richTextExtensions,
      LinkEmbeds.configure({ getScope: () => scope }),
      Markdown,
    ],
    content: cleanNoteMarkdown(markdown),
    contentType: 'markdown',
  });

function typeTextWithInputRules(editor, text) {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    let handled = false;
    editor.view.someProp('handleTextInput', (fn) => {
      if (fn(editor.view, from, to, ch)) {
        handled = true;
        return true;
      }
      return false;
    });
    if (!handled) {
      editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
    }
  }
}

{
  // Blank lines must NEVER inject &nbsp; or &amp;nbsp; into Markdown or inflate countWords!
  const blankEditor = makeNoteEditor('Hello world');
  blankEditor.commands.focus('end');
  blankEditor.commands.splitBlock();
  blankEditor.commands.splitBlock();
  blankEditor.commands.splitBlock();
  typeTextWithInputRules(blankEditor, 'Second line');
  const serializedBlankMd = cleanNoteMarkdown(blankEditor.getMarkdown());
  check(
    'multiple blank lines in notes never emit &nbsp; or &amp;nbsp; into Markdown source',
    !serializedBlankMd.includes('nbsp') && countWords(serializedBlankMd) === 4,
  );
  blankEditor.destroy();

  const pollutedMd = 'Alpha beta\n\n&amp;nbsp;\n\n&nbsp;\n\n&amp;amp;nbsp;\n\nGamma';
  const healedEditor = makeNoteEditor(pollutedMd);
  const healedMd = cleanNoteMarkdown(healedEditor.getMarkdown());
  check(
    'existing notes with &amp;nbsp; / &nbsp; blank lines are cleaned and do not inflate word count',
    countWords(pollutedMd) === 3 && !healedMd.includes('nbsp') && countWords(healedMd) === 3,
  );
  healedEditor.destroy();

  // Discord-style link embed decoration + dismiss keeping the normal link intact
  const embedEditor = makeNoteEditor('Check out [Comet](https://example.com/docs) today', 'note-embed-1');
  const widgetBefore = embedEditor.view.dom.querySelector('.comet-link-embed-widget');
  const anchorBefore = embedEditor.view.dom.querySelector('a[href="https://example.com/docs"]');
  setEmbedDismissed('note-embed-1', 'https://example.com/docs', true);
  const widgetAfter = embedEditor.view.dom.querySelector('.comet-link-embed-widget');
  const anchorAfter = embedEditor.view.dom.querySelector('a[href="https://example.com/docs"]');
  check(
    'pasted/written links in notes show a Discord-style preview embed that can be dismissed while keeping the normal link',
    !!widgetBefore &&
      !!anchorBefore &&
      isEmbedDismissed('note-embed-1', 'https://example.com/docs') &&
      !widgetAfter &&
      !!anchorAfter &&
      embedEditor.getMarkdown().includes('[Comet](https://example.com/docs)'),
  );
  embedEditor.destroy();

  const italicEditor = makeNoteEditor('Plain *italic* and _also italic_');
  const emCount = italicEditor.view.dom.querySelectorAll('em').length;
  italicEditor.commands.setTextSelection({ from: 1, to: 6 });
  italicEditor.commands.toggleItalic();
  check(
    'notes parse and toggle italic marks cleanly',
    emCount === 2 && italicEditor.view.dom.querySelectorAll('em').length === 3 && italicEditor.getMarkdown().includes('*Plain*'),
  );
  italicEditor.destroy();

  // Code fence on a line below text after Shift+Enter (hardBreak) via Space AND via Enter
  const fenceAfterHardBreak = makeNoteEditor('');
  typeTextWithInputRules(fenceAfterHardBreak, 'Heading line');
  fenceAfterHardBreak.commands.setHardBreak();
  typeTextWithInputRules(fenceAfterHardBreak, '```ts ');
  const jsonAfterBreak = fenceAfterHardBreak.getJSON();
  check(
    'typing ``` on a Shift+Enter line below text creates a code block while preserving the line above',
    jsonAfterBreak.content?.[0]?.type === 'paragraph' &&
      fenceAfterHardBreak.state.doc.child(0).textContent === 'Heading line' &&
      jsonAfterBreak.content?.[1]?.type === 'codeBlock' &&
      jsonAfterBreak.content?.[1]?.attrs?.language === 'ts',
  );
  fenceAfterHardBreak.destroy();

  const fenceOnEnter = makeNoteEditor('');
  typeTextWithInputRules(fenceOnEnter, 'Above paragraph');
  fenceOnEnter.commands.setHardBreak();
  typeTextWithInputRules(fenceOnEnter, '```python');
  fenceOnEnter.view.someProp('handleKeyDown', (fn) =>
    fn(fenceOnEnter.view, new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
  check(
    'typing ```python + Enter on a line below text opens a code block without needing Space or Tab',
    fenceOnEnter.getJSON().content?.[0]?.type === 'paragraph' &&
      fenceOnEnter.state.doc.child(0).textContent === 'Above paragraph' &&
      fenceOnEnter.getJSON().content?.[1]?.type === 'codeBlock' &&
      fenceOnEnter.getJSON().content?.[1]?.attrs?.language === 'python',
  );
  fenceOnEnter.destroy();

  const fencePlain = makeNoteEditor('');
  typeTextWithInputRules(fencePlain, 'Above paragraph');
  fencePlain.commands.splitBlock();
  typeTextWithInputRules(fencePlain, '``` ');
  check(
    'typing ``` on a new line directly below text opens a code block without Tab workarounds',
    fencePlain.getJSON().content?.[0]?.type === 'paragraph' &&
      fencePlain.state.doc.child(0).textContent === 'Above paragraph' &&
      fencePlain.getJSON().content?.[1]?.type === 'codeBlock',
  );
  fencePlain.destroy();

  const fenceInList = makeNoteEditor('');
  typeTextWithInputRules(fenceInList, '1. First step');
  fenceInList.commands.splitListItem('listItem');
  typeTextWithInputRules(fenceInList, '```js ');
  const listJson = fenceInList.getJSON();
  check(
    'typing ``` inside a numbered list item creates an indented code block inside that item',
    listJson.content?.[0]?.type === 'orderedList' &&
      listJson.content[0].content?.[0]?.content?.some((child) => child.type === 'codeBlock' && child.attrs?.language === 'js'),
  );
  const listWithCodeMd = fenceInList.getMarkdown();
  const reopenedListWithCode = makeNoteEditor(listWithCodeMd);
  check(
    'numbered lists containing code blocks round-trip through Markdown without corrupting fences',
    reopenedListWithCode.getJSON().content?.[0]?.type === 'orderedList' &&
      reopenedListWithCode.getJSON().content[0].content?.[0]?.content?.some((child) => child.type === 'codeBlock'),
  );
  fenceInList.destroy();
  reopenedListWithCode.destroy();

  const listAfterBreak = makeNoteEditor('');
  typeTextWithInputRules(listAfterBreak, 'Intro text');
  listAfterBreak.commands.setHardBreak();
  typeTextWithInputRules(listAfterBreak, '- First bullet');
  check(
    'typing "- " after Shift+Enter starts a bullet list below the intro text',
    listAfterBreak.getJSON().content?.[0]?.type === 'paragraph' &&
      listAfterBreak.state.doc.child(0).textContent === 'Intro text' &&
      listAfterBreak.getJSON().content?.[1]?.type === 'bulletList',
  );
  listAfterBreak.destroy();

  const toolbarListAfterBreak = makeNoteEditor('');
  typeTextWithInputRules(toolbarListAfterBreak, 'Keep paragraph');
  toolbarListAfterBreak.commands.setHardBreak();
  typeTextWithInputRules(toolbarListAfterBreak, 'Turn into numbered item');
  splitHardBreaksBeforeListToggle(toolbarListAfterBreak, 'orderedList');
  toolbarListAfterBreak.commands.toggleOrderedList();
  check(
    'toolbar list toggle splits hard breaks so only the current line becomes a list item',
    toolbarListAfterBreak.getJSON().content?.[0]?.type === 'paragraph' &&
      toolbarListAfterBreak.state.doc.child(0).textContent === 'Keep paragraph' &&
      toolbarListAfterBreak.getJSON().content?.[1]?.type === 'orderedList',
  );
  toolbarListAfterBreak.destroy();

  const abbrevEditor = makeNoteEditor('Dr. Smith met St. Jude.\n\n1. One\n2. Two\n\na. Sub A\nb. Sub B');
  const abbrevTypes = abbrevEditor.getJSON().content?.map((n) => n.type) ?? [];
  check(
    'ordered list Markdown parser preserves paragraphs like "Dr. Smith" while parsing numeric and alpha lists',
    abbrevTypes.join(',') === 'paragraph,orderedList,orderedList' &&
      abbrevEditor.getJSON().content?.[2]?.attrs?.type === 'a',
  );
  abbrevEditor.destroy();
}

// 3. Markdown helper & Orbit-style update helper checks
{
  const blocks = parseBlocks('#### Section 4\n- [ ] Ship **Comet** *1.0.1*\n- [x] Done');
  check(
    'Markdown parser handles level-4 headings and inline formatting inside task list items',
    blocks[0]?.kind === 'h' &&
      blocks[0]?.level === 4 &&
      blocks[1]?.kind === 'ul' &&
      blocks[1]?.items[0]?.box === true &&
      blocks[1]?.items[0]?.inlines.some((r) => r.kind === 'strong' && r.text === 'Comet') &&
      blocks[1]?.items[0]?.inlines.some((r) => r.kind === 'em' && r.text === '1.0.1'),
  );
  const toggled = toggleMarkdownTask('Intro\n- [ ] First\n- [ ] Second', 1);
  check(
    'toggleMarkdownTask flips only the targeted task checkbox line',
    toggled === 'Intro\n- [ ] First\n- [x] Second',
  );

  // Orbit-style cross-platform update asset picking + pre-release opt-in + persisted update preferences
  const sampleReleases = [
    {
      tag_name: 'v1.1.0-beta.1',
      prerelease: true,
      html_url: 'https://github.com/MarchTheDev/Comet/releases/tag/v1.1.0-beta.1',
      assets: [
        {
          name: 'Comet_1.1.0-beta.1_amd64.deb',
          digest: `sha256:${'c'.repeat(64)}`,
          browser_download_url: 'https://github.com/MarchTheDev/Comet/releases/download/v1.1.0-beta.1/Comet_1.1.0-beta.1_amd64.deb',
        },
      ],
    },
    {
      tag_name: 'v1.0.2',
      prerelease: false,
      html_url: 'https://github.com/MarchTheDev/Comet/releases/tag/v1.0.2',
      assets: [
        {
          name: 'Comet_1.0.2_amd64.deb',
          digest: `sha256:${'d'.repeat(64)}`,
          browser_download_url: 'https://github.com/MarchTheDev/Comet/releases/download/v1.0.2/Comet_1.0.2_amd64.deb',
        },
        {
          name: 'Comet-1.0.2-windows-setup.exe',
          digest: `sha256:${'e'.repeat(64)}`,
          browser_download_url: 'https://github.com/MarchTheDev/Comet/releases/download/v1.0.2/Comet-1.0.2-windows-setup.exe',
        },
      ],
    },
  ];
  const stableLinux = newestUpdate(sampleReleases, '1.0.1', { platform: 'linux' });
  const betaLinux = newestUpdate(sampleReleases, '1.0.1', { platform: 'linux', includePrereleases: true });
  saveUpdatePreferences({ checkOnLaunch: false, includePrereleases: true });
  const loadedPrefs = readUpdatePreferences();
  check(
    'Orbit-style update logic selects Linux .deb assets, supports optional pre-releases, and persists update preferences',
    stableLinux?.version === '1.0.2' &&
      stableLinux.platformAsset?.name === 'Comet_1.0.2_amd64.deb' &&
      betaLinux?.version === '1.1.0-beta.1' &&
      betaLinux.platformAsset?.name === 'Comet_1.1.0-beta.1_amd64.deb' &&
      pickPlatformAsset(sampleReleases[1].assets, 'v1.0.2', '1.0.2', 'windows')?.name === 'Comet-1.0.2-windows-setup.exe' &&
      loadedPrefs.checkOnLaunch === false &&
      loadedPrefs.includePrereleases === true,
  );
  dom.window.localStorage.clear();
}

// 4. UndoHistory & shortcut definitions
{
  check(
    'Undo and Redo are registered in customizable shortcuts with Mod+Z and Mod+Shift+Z defaults',
    SHORTCUT_ACTIONS.undo === 'Undo' &&
      SHORTCUT_ACTIONS.redo === 'Redo' &&
      DEFAULT_SHORTCUTS.undo === 'Mod+Z' &&
      DEFAULT_SHORTCUTS.redo === 'Mod+Shift+Z',
  );
  const hist = new UndoHistory(50, 500);
  hist.record('v0', 'typing', 100);
  hist.record('v1', 'typing', 200);
  hist.record('v2', 'discrete', 250);
  const step1 = hist.undo('v3');
  const step2 = hist.undo(step1);
  const redone = hist.redo(step2);
  check(
    'UndoHistory coalesces rapid typing bursts and steps cleanly through undo and redo',
    step1 === 'v2' && step2 === 'v0' && redone === 'v2',
  );
  const ctrlZ = new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true });
  const ctrlY = new dom.window.KeyboardEvent('keydown', { key: 'y', ctrlKey: true });
  check('undoRedoKey recognizes Ctrl+Z and Ctrl+Y', undoRedoKey(ctrlZ) === 'undo' && undoRedoKey(ctrlY) === 'redo');
}

// 5. Whiteboard: 4-corner resize, open-spot placement, front z-order, shrink-wrapped renamable Text/To-do/Link headers, instant live Markdown, and Link embeds
{
  const startCard = { id: 'c1', type: 'text', x: 200, y: 150, width: 260, height: 180, text: 'Hi', color: '#83b8ca' };
  const nw = resizeWhiteboardItem(startCard, 'nw', -40, -30);
  const ne = resizeWhiteboardItem(startCard, 'ne', 50, -20);
  const sw = resizeWhiteboardItem(startCard, 'sw', -30, 40);
  const se = resizeWhiteboardItem(startCard, 'se', 45, 35);
  const nwClamped = resizeWhiteboardItem(startCard, 'nw', 500, 500);
  check(
    'resizeWhiteboardItem resizes accurately from NW, NE, SW, and SE while keeping opposite corners anchored',
    nw.x === 160 && nw.y === 120 && nw.width === 300 && nw.height === 210 &&
      ne.x === 200 && ne.y === 130 && ne.width === 310 && ne.height === 200 &&
      sw.x === 170 && sw.y === 150 && sw.width === 290 && sw.height === 220 &&
      se.x === 200 && se.y === 150 && se.width === 305 && se.height === 215 &&
      nwClamped.x + nwClamped.width === 460 && nwClamped.y + nwClamped.height === 330,
  );

  // Open-spot placement inside scrolled/zoomed viewport
  const occupied = [{ type: 'text', x: 448, y: 348, width: 240, height: 150 }];
  const openSpot = findOpenWhiteboardSpot(occupied, { width: 240, height: 150 }, { x: 400, y: 300, width: 900, height: 600 });
  check(
    'findOpenWhiteboardSpot places new windows in an unoccupied spot within the current zoom viewport',
    openSpot.x >= 448 &&
      openSpot.y >= 348 &&
      (openSpot.x >= 448 + 240 + 16 || openSpot.y >= 348 + 150 + 16),
  );

  const root = createRoot(document.getElementById('root'));
  let savedBoard = newWhiteboard();
  function WhiteboardHarness() {
    const [board, setBoard] = useState(savedBoard);
    return React.createElement(Whiteboard, {
      board,
      name: 'plan.whiteboard',
      path: '/vault/plan.whiteboard',
      saveState: 'saved',
      onChange: (next) => {
        savedBoard = next;
        setBoard(next);
        return true;
      },
      onRename() {},
      onRetry() {},
    });
  }

  const click = async (el) =>
    act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  const setInputValue = async (el, value) =>
    act(async () => {
      try {
        el.focus();
        el.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
      } catch {
        el.focus();
      }
      const proto = el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter.call(el, value);
      const property = new dom.window.Event('propertychange', { bubbles: true });
      Object.defineProperty(property, 'propertyName', { value: 'value' });
      el.dispatchEvent(property);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });

  await act(async () => root.render(React.createElement(WhiteboardHarness)));
  const stage = document.querySelector('[aria-label="Whiteboard canvas"]');
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700 });
  Object.defineProperty(stage, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(stage, 'clientHeight', { value: 700, configurable: true });

  const toolbarButton = (label) =>
    [...document.querySelectorAll('.whiteboard-toolbar button')].find((b) => b.textContent.trim() === label);

  // Add a Text card
  await click(toolbarButton('Text'));
  const textCard = document.querySelector('.whiteboard-text');
  const textTitleWrap = textCard.querySelector('.whiteboard-title-wrap');
  const textTitleInput = textCard.querySelector('.whiteboard-title-input');
  check(
    'Whiteboard text cards render a shrink-wrapped title input without any separate preview-mode toggle button',
    !!textTitleWrap &&
      textTitleWrap.getAttribute('data-sizer') === 'Text' &&
      textTitleInput?.placeholder === 'Text' &&
      !textCard.querySelector('[aria-label="Preview markdown"]'),
  );
  await setInputValue(textTitleInput, 'Sprint Notes');
  check(
    'Whiteboard title wrapper updates its shrink-wrap sizer to match the written name',
    textTitleWrap.getAttribute('data-sizer') === 'Sprint Notes',
  );

  // Verify instant live Markdown editor inside Whiteboard text card
  const wbProse = textCard.querySelector('.whiteboard-prose');
  check('Whiteboard text cards mount an instant live rich-text Markdown editor', !!wbProse && wbProse.getAttribute('contenteditable') === 'true');

  // Verify all 4 corner resize handles exist and NW resize works via pointer drag
  const corners = ['nw', 'ne', 'sw', 'se'].map((c) => textCard.querySelector(`.whiteboard-resize.is-${c}`));
  check('Whiteboard items expose resize handles on all 4 corners', corners.every(Boolean));

  const beforeResize = savedBoard.items[0];
  await act(async () => {
    corners[0].dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 200, clientY: 200 }));
    dom.window.dispatchEvent(new dom.window.PointerEvent('pointermove', { bubbles: true, clientX: 160, clientY: 170 }));
    dom.window.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, clientX: 160, clientY: 170 }));
  });
  const afterResize = savedBoard.items[0];
  check(
    'dragging the top-left (NW) corner handle resizes and repositions the Whiteboard window',
    afterResize.x === beforeResize.x - 40 &&
      afterResize.y === beforeResize.y - 30 &&
      afterResize.width === beforeResize.width + 40 &&
      afterResize.height === beforeResize.height + 30,
  );

  // Ctrl+Z undoes the NW resize, and Ctrl+Shift+Z redoes it!
  await act(async () => {
    document.activeElement?.blur?.();
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  const afterUndoResize = savedBoard.items[0];
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  const afterRedoResize = savedBoard.items[0];
  check(
    'Ctrl+Z and Ctrl+Shift+Z undo and redo Whiteboard actions',
    afterUndoResize.width === beforeResize.width && afterRedoResize.width === beforeResize.width + 40,
  );

  // Add a To-do card: must automatically appear in front of the previously focused Text card, in an open spot, AND have a renamable title!
  await click(toolbarButton('To-do'));
  const todoCard = document.querySelector('.whiteboard-todo');
  const textZ = Number(document.querySelector('.whiteboard-text').style.zIndex || 0);
  const todoZ = Number(todoCard.style.zIndex || 0);
  const todoTitleInput = todoCard.querySelector('input[aria-label="To-do card title"]');
  await setInputValue(todoTitleInput, 'Release Checklist');
  check(
    'newly created Whiteboard To-do window is brought to the front automatically and has a renamable header',
    todoZ > textZ && todoTitleInput?.value === 'Release Checklist',
  );

  let todoInputs = todoCard.querySelectorAll('.whiteboard-todo-input');
  await setInputValue(todoInputs[0], 'First item');
  await click(todoCard.querySelector('.whiteboard-todo-add'));
  todoInputs = todoCard.querySelectorAll('.whiteboard-todo-input');
  await setInputValue(todoInputs[1], 'Second item');
  await act(async () => {
    todoInputs[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  todoInputs = todoCard.querySelectorAll('.whiteboard-todo-input');
  await setInputValue(todoInputs[2], 'Third item');
  await click(todoCard.querySelectorAll('.whiteboard-todo-row input[type="checkbox"]')[1]);

  // Add a Link card via the new "Link" toolbar button, add multiple links at once, and dismiss one embed while keeping the normal link!
  await click(toolbarButton('Link'));
  const linkCard = document.querySelector('.whiteboard-link');
  const linkZ = Number(linkCard.style.zIndex || 0);
  const linkInput = linkCard.querySelector('input[aria-label="Paste one or more links"]');
  check(
    'Whiteboard Link button creates a Link window in front of previous windows',
    !!linkCard && linkZ > todoZ && extractLinksFromText('https://example.com/a https://example.org/b').length === 2,
  );
  await setInputValue(linkInput, 'https://example.com/one https://example.org/two');
  await act(async () => {
    linkCard.querySelector('.whiteboard-link-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  const embedsBeforeDismiss = linkCard.querySelectorAll('.comet-link-embed').length;
  const dismissBtn = linkCard.querySelector('.comet-link-embed-dismiss');
  await click(dismissBtn);
  const embedsAfterDismiss = linkCard.querySelectorAll('.comet-link-embed').length;
  const anchorsAfterDismiss = linkCard.querySelectorAll('.whiteboard-link-anchor').length;

  const roundTrippedBoard = parseWhiteboard(serializeWhiteboard(savedBoard));
  const savedTodo = roundTrippedBoard?.items.find((i) => i.type === 'todo');
  const savedLink = roundTrippedBoard?.items.find((i) => i.type === 'link');
  check(
    'Whiteboard Link window accepts multiple pasted links, dismisses an embed while keeping the normal link, and round-trips v5 schema',
    embedsBeforeDismiss === 2 &&
      embedsAfterDismiss === 1 &&
      anchorsAfterDismiss === 2 &&
      savedTodo?.title === 'Release Checklist' &&
      savedTodo?.todos?.length === 2 &&
      savedLink?.links?.length === 2 &&
      savedLink.links[0].showEmbed === false &&
      savedLink.links[1].showEmbed === true,
  );

  await act(async () => root.unmount());
}

// 6. Ctrl+Z in TodoBoard and BrainExplore
{
  const root = createRoot(document.getElementById('root'));
  let savedTodoBoard = newTodoDocument();
  function TodoHarness() {
    const [board, setBoard] = useState(savedTodoBoard);
    return React.createElement(TodoBoard, {
      board,
      name: 'tasks.todo',
      saveState: 'saved',
      arrowheads: false,
      onChange: (next) => {
        savedTodoBoard = next;
        setBoard(next);
        return true;
      },
      onRetry() {},
    });
  }
  await act(async () => root.render(React.createElement(TodoHarness)));
  const newTodoInput = document.querySelector('[aria-label="New to-do"]');
  await act(async () => {
    newTodoInput.focus();
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(newTodoInput, 'Buy coffee');
    const property = new dom.window.Event('propertychange', { bubbles: true });
    Object.defineProperty(property, 'propertyName', { value: 'value' });
    newTodoInput.dispatchEvent(property);
    newTodoInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    document.querySelector('.todo-create').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  check('TodoBoard adds a new task', parseTodo(serializeTodo(savedTodoBoard))?.tasks.length === 1);
  await act(async () => {
    document.activeElement?.blur?.();
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  check('Ctrl+Z in TodoBoard undoes task creation', savedTodoBoard.tasks.length === 0);
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  check('Ctrl+Y in TodoBoard redoes task creation', savedTodoBoard.tasks.length === 1);
  await act(async () => root.unmount());

  // BrainExplore graph position undo/redo
  dom.window.localStorage.clear();
  const brainRoot = createRoot(document.getElementById('root'));
  await act(async () =>
    brainRoot.render(
      React.createElement(BrainExplore, {
        vault: SAMPLE_ROOT,
        name: 'Sample',
        entries: [
          { path: `${SAMPLE_ROOT}/a.txt`, name: 'a.txt', kind: 'file', children: [] },
          { path: `${SAMPLE_ROOT}/b.txt`, name: 'b.txt', kind: 'file', children: [] },
        ],
        selectedPaths: new Set(),
        onOpen() {},
        onActivate() {},
        onClearSelection() {},
      }),
    ),
  );
  const svgEl = document.querySelector('.brain-stage svg');
  svgEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 1040, right: 1200, bottom: 1040 });
  const nodeGroup = document.querySelector('.brain-node');
  const initialTransform = nodeGroup.getAttribute('transform');
  await act(async () => {
    nodeGroup.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 300, clientY: 250 }));
    dom.window.dispatchEvent(new dom.window.PointerEvent('pointermove', { bubbles: true, clientX: 460, clientY: 360 }));
    dom.window.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, clientX: 460, clientY: 360 }));
  });
  const draggedTransform = document.querySelector('.brain-node').getAttribute('transform');
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  const undoneTransform = document.querySelector('.brain-node').getAttribute('transform');
  check(
    'Ctrl+Z in Brain view undoes dragged node positions',
    draggedTransform !== initialTransform && undoneTransform === initialTransform,
  );
  await act(async () => brainRoot.unmount());
}

// 7. Workspace direct drag-and-drop reordering + folder drop ("into") WITHOUT .workspace-drag-handle grip clutter
{
  const folderEntry = { path: '/vault/Folder', name: 'Folder', kind: 'folder', children: [] };
  const fileA = { path: '/vault/alpha.md', name: 'alpha.md', kind: 'file', children: [] };
  const fileB = { path: '/vault/beta.md', name: 'beta.md', kind: 'file', children: [] };
  const fileC = { path: '/vault/gamma.md', name: 'gamma.md', kind: 'file', children: [] };
  const rect = { left: 100, top: 200, width: 200, height: 100 };

  check(
    'workspacePlacement puts items inside a folder when hovering its center and reorders at its edges',
    workspacePlacement(['/vault/alpha.md'], folderEntry, rect, 200, 250, 'list')?.position === 'into' &&
      workspacePlacement(['/vault/alpha.md'], folderEntry, rect, 200, 210, 'list')?.position === 'before' &&
      workspacePlacement(['/vault/alpha.md'], folderEntry, rect, 200, 290, 'list')?.position === 'after' &&
      workspacePlacement(['/vault/alpha.md'], folderEntry, rect, 120, 250, 'gallery')?.position === 'before' &&
      workspacePlacement(['/vault/alpha.md'], folderEntry, rect, 200, 250, 'gallery')?.position === 'into' &&
      workspacePlacement(['/vault/alpha.md'], folderEntry, rect, 285, 250, 'gallery')?.position === 'after',
  );
  check(
    'workspacePlacement splits file targets into before/after and prevents dropping a folder onto itself or descendants',
    workspacePlacement(['/vault/alpha.md'], fileB, rect, 200, 220, 'list')?.position === 'before' &&
      workspacePlacement(['/vault/alpha.md'], fileB, rect, 200, 280, 'list')?.position === 'after' &&
      workspacePlacement(['/vault/Folder'], folderEntry, rect, 200, 250, 'list') === null &&
      workspacePlacement(['/vault/Folder'], { path: '/vault/Folder/sub.md', name: 'sub.md', kind: 'file', children: [] }, rect, 200, 250, 'list') === null,
  );

  let meta = emptyWorkspaceMeta();
  meta = reorderChildrenGroup(
    meta,
    '/vault',
    [folderEntry.path, fileA.path, fileB.path, fileC.path],
    [fileC.path],
    folderEntry.path,
    false,
  );
  const orderedBeforeRename = orderItems([folderEntry, fileA, fileB, fileC], meta, '/vault').map((e) => e.path);
  const renamedMeta = renameMeta(meta, '/vault/gamma.md', '/vault/aardvark.md');
  const fileRenamed = { ...fileC, path: '/vault/aardvark.md', name: 'aardvark.md' };
  const orderedAfterRename = orderItems([folderEntry, fileA, fileB, fileRenamed], renamedMeta, '/vault').map((e) => e.path);
  check(
    'reordered workspace items can be placed even ahead of folders and preserve custom position across renames',
    orderedBeforeRename.join('|') === '/vault/gamma.md|/vault/Folder|/vault/alpha.md|/vault/beta.md' &&
      orderedAfterRename.join('|') === '/vault/aardvark.md|/vault/Folder|/vault/alpha.md|/vault/beta.md',
  );

  const wsRoot = createRoot(document.getElementById('root'));
  let lastDrop = null;
  function WorkspaceHarness() {
    const [indicator, setIndicator] = useState(null);
    const ordered = orderItems([folderEntry, fileA, fileB], emptyWorkspaceMeta(), '/vault');
    return React.createElement(WorkspacePanel, {
      title: 'All files',
      description: '3 items',
      entries: ordered,
      vault: '/vault',
      destination: '/vault',
      metadata: emptyWorkspaceMeta(),
      layout: 'list',
      iconSize: 180,
      selectedPaths: new Set(),
      dropFolder: indicator?.position === 'into' ? indicator.path : '',
      dropIndicator: indicator,
      onLayout() {},
      onIconSize() {},
      onOpen() {},
      onMenu() {},
      onBackgroundMenu() {},
      onCreate() {},
      onDragStart() {},
      onDragOver() {},
      onDrop() {},
      onDragOverEntry: (e, entry, layout) => {
        e.preventDefault();
        const bounds = e.currentTarget.getBoundingClientRect();
        const nextIndicator = workspacePlacement(['/vault/beta.md'], entry, bounds, e.clientX, e.clientY, layout);
        setIndicator(nextIndicator);
      },
      onDropEntry: (e, entry, layout) => {
        e.preventDefault();
        const bounds = e.currentTarget.getBoundingClientRect();
        const nextIndicator = workspacePlacement(['/vault/beta.md'], entry, bounds, e.clientX, e.clientY, layout);
        lastDrop = nextIndicator;
        setIndicator(null);
      },
    });
  }

  await act(async () => wsRoot.render(React.createElement(WorkspaceHarness)));
  const folderArticle = document.querySelector('[data-workspace-path="/vault/Folder"]');
  const alphaArticle = document.querySelector('[data-workspace-path="/vault/alpha.md"]');
  folderArticle.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 60, right: 600, bottom: 60 });
  alphaArticle.getBoundingClientRect = () => ({ left: 0, top: 70, width: 600, height: 60, right: 600, bottom: 130 });

  await act(async () => {
    folderArticle.dispatchEvent(new dom.window.MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 120, clientY: 30 }));
  });
  const folderHighlightedInto = folderArticle.classList.contains('drop-target');

  await act(async () => {
    alphaArticle.dispatchEvent(new dom.window.MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
  });
  const alphaHighlightedBefore = alphaArticle.classList.contains('drop-before');

  await act(async () => {
    alphaArticle.dispatchEvent(new dom.window.MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
  });

  check(
    'WorkspacePanel has no top-left drag-handle icon while keeping direct draggable reordering and folder drop',
    !document.querySelector('.workspace-drag-handle') &&
      alphaArticle.getAttribute('draggable') === 'true' &&
      folderHighlightedInto &&
      alphaHighlightedBefore &&
      lastDrop?.path === '/vault/alpha.md' &&
      lastDrop?.position === 'before',
  );

  await act(async () => wsRoot.unmount());
}

// 8. Second-round follow-ups: 1-to-1 Enter newlines, Whiteboard write-mode toolbar & Delete pill & Links auto-paste,
//    single-tab link open + right-click hyperlink/embed actions, YouTube drag & video link view & rename, and Calendar wheel navigation
{
  // (a) Item 3: 1-to-1 Enter / blank-line mapping between Write mode and Markdown view
  const lineEditor1 = makeNoteEditor('Hello');
  lineEditor1.commands.focus('end');
  lineEditor1.commands.splitBlock();
  typeTextWithInputRules(lineEditor1, 'World');
  const md1Enter = cleanNoteMarkdown(lineEditor1.getMarkdown());

  const lineEditor3 = makeNoteEditor('Hello');
  lineEditor3.commands.focus('end');
  lineEditor3.commands.splitBlock();
  lineEditor3.commands.splitBlock();
  lineEditor3.commands.splitBlock();
  typeTextWithInputRules(lineEditor3, 'World');
  const md3Enters = cleanNoteMarkdown(lineEditor3.getMarkdown());
  const roundTrip3 = makeNoteEditor(md3Enters);
  const md3RoundTrip = cleanNoteMarkdown(roundTrip3.getMarkdown());
  check(
    'Enter in Notes Write mode maps 1-to-1 to blank lines in Markdown view without multiplying newlines',
    md1Enter === 'Hello\n\nWorld' &&
      md3Enters === 'Hello\n\n\n\nWorld' &&
      md3RoundTrip === 'Hello\n\n\n\nWorld' &&
      roundTrip3.state.doc.childCount === 4,
  );
  lineEditor1.destroy();
  lineEditor3.destroy();
  roundTrip3.destroy();

  // (b) Item 6 & Item 7c: single-tab link opening, right-click "Turn into hyperlink…" & "Show embed", and editing link title without breaking video/link mark
  let openedUrls = [];
  const origWindowOpen = dom.window.open;
  dom.window.open = (url) => {
    openedUrls.push(url);
    return null;
  };
  openExternalWebUrl('https://rclone.org/crypt/');
  openExternalWebUrl('https://rclone.org/crypt/');
  check(
    'openExternalWebUrl deduplicates rapid double dispatches so clicking a link never opens 2 tabs',
    openedUrls.length === 1 && openedUrls[0] === 'https://rclone.org/crypt/',
  );
  dom.window.open = origWindowOpen;

  const linkNoteEditor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({
        paragraph: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          markdownLinks: true,
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
        },
      }),
      ...noteBlockExtensions,
      ...richTextExtensions,
      VideoEmbeds.configure({ getScope: () => 'yt-note-scope' }),
      LinkEmbeds.configure({ getScope: () => 'yt-note-scope' }),
      Markdown,
    ],
    content: '[https://rclone.org/crypt/](https://rclone.org/crypt/)\n\n[https://youtu.be/dQw4w9WgXcQ](https://youtu.be/dQw4w9WgXcQ)',
    contentType: 'markdown',
  });
  let rclonePos = -1;
  linkNoteEditor.state.doc.descendants((node, pos) => {
    if (rclonePos === -1 && node.isText && node.text?.includes('rclone.org')) rclonePos = pos + 2;
  });
  const foundTarget = findLinkMarkRange(linkNoteEditor.state.doc, rclonePos);
  const replacedOk = foundTarget ? replaceLinkDisplayText(linkNoteEditor, foundTarget, 'dwadwa') : false;
  const transformedMd = cleanNoteMarkdown(linkNoteEditor.getMarkdown());

  // Dismiss YouTube video embed, then restore it via setEmbedDismissed(..., false) ("Show embed" option)
  const ytBeforeDismiss = !!linkNoteEditor.view.dom.querySelector('.inline-video iframe');
  setEmbedDismissed('yt-note-scope', 'https://youtu.be/dQw4w9WgXcQ', true);
  const ytAfterDismiss = !!linkNoteEditor.view.dom.querySelector('.inline-video iframe');
  setEmbedDismissed('yt-note-scope', 'https://youtu.be/dQw4w9WgXcQ', false);
  const ytAfterRestore = !!linkNoteEditor.view.dom.querySelector('.inline-video iframe');
  const ytOutsideAnchor = !linkNoteEditor.view.dom.querySelector('a .inline-video');

  // Overtype the full YouTube link text directly in Write mode and verify CometLinkEditGuard keeps its href & video embed intact!
  let ytFrom = -1;
  let ytTo = -1;
  linkNoteEditor.state.doc.descendants((node, pos) => {
    if (ytFrom === -1 && node.isText && node.text?.includes('youtu.be')) {
      ytFrom = pos;
      ytTo = pos + node.nodeSize;
    }
  });
  linkNoteEditor.commands.setTextSelection({ from: ytFrom, to: ytTo });
  typeTextWithInputRules(linkNoteEditor, 'My Cool Video');
  const editedVideoMd = cleanNoteMarkdown(linkNoteEditor.getMarkdown());
  const ytStillEmbedded = !!linkNoteEditor.view.dom.querySelector('.inline-video iframe');

  check(
    'Notes right-click hyperlink transform produces [dwadwa](https://rclone.org/crypt/), Show embed restores video embeds, and editing a video link title keeps its embed intact',
    replacedOk &&
      transformedMd.includes('[dwadwa](https://rclone.org/crypt/)') &&
      ytBeforeDismiss &&
      !ytAfterDismiss &&
      ytAfterRestore &&
      ytOutsideAnchor &&
      editedVideoMd.includes('[My Cool Video](https://youtu.be/dQw4w9WgXcQ)') &&
      ytStillEmbedded,
  );
  linkNoteEditor.destroy();

  // (c) Item 7: Browser-dragged YouTube watch.download detection, clean MediaView video link layout, and .url rename preservation
  const fakeDrop = {
    files: [{ name: 'watch.download', size: 0, type: '' }],
    getData: (fmt) => (fmt === 'text/uri-list' ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' : ''),
  };
  const realFileDrop = {
    files: [{ name: 'slides.pdf', size: 48_000, type: 'application/pdf' }],
    getData: () => '',
  };
  check(
    'droppedBrowserLink & parseDroppedShortcutFile detect dragged YouTube/web links instead of importing .download files',
    droppedBrowserLink(fakeDrop) === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' &&
      droppedBrowserLink(realFileDrop) === null &&
      parseDroppedShortcutFile('watch.download', '[InternetShortcut]\nURL=https://youtu.be/dQw4w9WgXcQ\n') ===
        'https://youtu.be/dQw4w9WgXcQ' &&
      parseDroppedShortcutFile(
        'Clip.webloc',
        '<?xml version="1.0"?><plist><dict><key>URL</key><string>https://www.youtube.com/watch?v=dQw4w9WgXcQ</string></dict></plist>',
      ) === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );
  check(
    'displayEntryName hides .url and preserveRenamedExtension keeps .url / .md / board extensions when renaming titles',
    displayEntryName('YouTube - dQw4w9WgXcQ.url') === 'YouTube - dQw4w9WgXcQ' &&
      preserveRenamedExtension('YouTube - dQw4w9WgXcQ.url', 'Episode 1.2 Highlights') === 'Episode 1.2 Highlights.url' &&
      fileKind(preserveRenamedExtension('YouTube - dQw4w9WgXcQ.url', 'Episode 1.2 Highlights')) === 'link' &&
      preserveRenamedExtension('Welcome.md', 'Project Roadmap') === 'Project Roadmap.md' &&
      preserveRenamedExtension('Tasks.comet-todo', 'Sprint 2.0') === 'Sprint 2.0.comet-todo',
  );

  const mediaRoot = createRoot(document.getElementById('root'));
  await act(async () =>
    mediaRoot.render(
      React.createElement(MediaView, {
        path: '/vault/YouTube - dQw4w9WgXcQ.url',
        vault: '/vault',
        url: '',
        sample: true,
        autoCoverArt: false,
        content: serializeShortcut('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
        onRename() {},
        onOpenWeb() {},
        onOpenExternal() {},
        onEditAsText() {},
      }),
    ),
  );
  check(
    'MediaView renders YouTube player cleanly with stripped .url title and borderless inline link (no boxy .saved-link-address)',
    !document.querySelector('.saved-link-address') &&
      !!document.querySelector('.linked-video iframe') &&
      !!document.querySelector('.saved-link-inline') &&
      document.querySelector('.rename-title')?.textContent === 'YouTube - dQw4w9WgXcQ',
  );
  await act(async () => mediaRoot.unmount());

  // (d) Items 1, 4, 5: Whiteboard Write-mode toolbar + live [text](url) Markdown, narrow Delete button CSS, Links auto-paste without Add button, and > img scoping
  check(
    'Whiteboard CSS uses display:block on ProseMirror, scopes > img so link embed titles stay left-aligned, and keeps Delete confirmation pill unclipped',
    /\.whiteboard-rich-editor\s*>\s*div\s*\{[^}]*display:\s*block;/.test(css) &&
      css.includes('.whiteboard-item > img') &&
      !/\.whiteboard-item\s+img\s*\{/.test(css) &&
      css.includes('.whiteboard-item-header button.whiteboard-delete-confirm') &&
      /button\.whiteboard-delete-confirm\s*\{[^}]*min-width:\s*max-content;[^}]*white-space:\s*nowrap;/.test(css),
  );

  const wbRoot = createRoot(document.getElementById('root'));
  let wbState = newWhiteboard();
  function WbFollowupHarness() {
    const [b, setB] = useState(wbState);
    return React.createElement(Whiteboard, {
      path: '/vault/plan.comet-whiteboard',
      board: b,
      name: 'plan',
      saveState: 'saved',
      onChange: (next) => {
        wbState = next;
        setB(next);
        return true;
      },
      onRename() {},
      onRetry() {},
    });
  }
  await act(async () => wbRoot.render(React.createElement(WbFollowupHarness)));
  const wbBtn = (txt) =>
    [...document.querySelectorAll('.whiteboard-toolbar button')].find((b) => b.textContent.trim() === txt);

  await act(async () => wbBtn('Text').click());
  const wbTextCard = document.querySelector('.whiteboard-text');
  const wbTextToolbar = wbTextCard?.querySelector('.whiteboard-text-toolbar');
  await act(async () => wbBtn('Link').click());
  const wbLinkCard = document.querySelector('.whiteboard-link');
  const hasRemovedAddBtn = !wbLinkCard?.querySelector('.whiteboard-link-submit');
  const wbLinkInput = wbLinkCard?.querySelector('.whiteboard-link-input');
  await act(async () => {
    const pasteEvt = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvt, 'clipboardData', {
      value: { getData: () => 'https://rclone.org/crypt/' },
    });
    wbLinkInput.dispatchEvent(pasteEvt);
  });
  const autoPastedLinks = wbState.items.find((i) => i.type === 'link')?.links?.length ?? 0;

  // Trigger Delete confirmation on Whiteboard card and check .whiteboard-delete-confirm button
  const trashBtn = wbLinkCard.querySelector('button[aria-label="Delete link"]');
  await act(async () => trashBtn.click());
  const deleteConfirmBtn = wbLinkCard.querySelector('button.whiteboard-delete-confirm');

  check(
    'Whiteboard Text card includes Notes-like formatting toolbar, Links card auto-adds pasted URLs with no Add button, and Delete button uses .whiteboard-delete-confirm',
    !!wbTextToolbar &&
      wbTextToolbar.querySelectorAll('button').length >= 9 &&
      hasRemovedAddBtn &&
      autoPastedLinks === 1 &&
      deleteConfirmBtn?.textContent === 'Delete',
  );
  await act(async () => wbRoot.unmount());

  // (e) Item 8: CalendarView scroll-wheel month navigation
  const calRoot = createRoot(document.getElementById('root'));
  await act(async () =>
    calRoot.render(React.createElement(CalendarView, { vault: SAMPLE_ROOT, name: 'Sample' })),
  );
  const calPanel = document.querySelector('.calendar-month');
  const getMonthLabel = () => calPanel.querySelector('.calendar-date-title')?.textContent?.trim() ?? '';
  const initialMonthLabel = getMonthLabel();
  await act(async () => {
    const wheelDown = new dom.window.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    calPanel.dispatchEvent(wheelDown);
  });
  const nextMonthLabel = getMonthLabel();
  await new Promise((r) => setTimeout(r, 200));
  await act(async () => {
    const wheelUp = new dom.window.WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    calPanel.dispatchEvent(wheelUp);
  });
  const backMonthLabel = getMonthLabel();
  check(
    'CalendarView scrolls forward and backward across months with the mouse wheel like Date Calculator',
    Boolean(initialMonthLabel) && nextMonthLabel !== initialMonthLabel && backMonthLabel === initialMonthLabel,
  );
  await act(async () => calRoot.unmount());

  // 14. Third-round follow-up refinements (Whiteboard dotted lists, removed mode-hint bars, MediaView spacing & copy, Whiteboard Link reorder + fixed height + crisp icon, Notes back-to-normal link)
  // (a) Dotted / bullet lists: empty bullet round-trip, loose list round-trip (no injected empty paragraphs), TrailingNode list serialization, and redundant `- ` inside listItem
  const emptyBulletEd = makeNoteEditor('- ');
  const emptyBulletJson = emptyBulletEd.getJSON();
  const emptyBulletMultiEd = makeNoteEditor('- \n- second');
  const emptyBulletMultiJson = emptyBulletMultiEd.getJSON();
  const looseBulletEd = makeNoteEditor('- alpha\n\n- beta\n\n\n- gamma\n- delta');
  const looseBulletMd1 = cleanNoteMarkdown(looseBulletEd.getMarkdown());
  const looseBulletReloaded = makeNoteEditor(looseBulletMd1);
  const looseBulletMd2 = cleanNoteMarkdown(looseBulletReloaded.getMarkdown());

  const redundantDashEd = makeNoteEditor('');
  typeTextWithInputRules(redundantDashEd, '- first');
  redundantDashEd.commands.splitListItem('listItem');
  typeTextWithInputRules(redundantDashEd, '- second');
  const redundantDashMd = cleanNoteMarkdown(redundantDashEd.getMarkdown());

  check(
    'Dotted lists preserve empty bullets, never inject empty paragraphs into loose listItems, omit TrailingNode extra newline, and swallow redundant "- " inside list items',
    emptyBulletJson.content?.[0]?.type === 'bulletList' &&
      emptyBulletMultiJson.content?.[0]?.type === 'bulletList' &&
      emptyBulletMultiJson.content?.[0]?.content?.length === 2 &&
      looseBulletMd1 === looseBulletMd2 &&
      !looseBulletMd2.includes('\n  \n') &&
      redundantDashMd === '- first\n- second',
  );
  emptyBulletEd.destroy();
  emptyBulletMultiEd.destroy();
  looseBulletEd.destroy();
  looseBulletReloaded.destroy();
  redundantDashEd.destroy();

  // (b) Removed "Editing the plain Markdown file" & "Reading view · select Write to make changes" mode-hint boxes in App.tsx
  const appSrc = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const mediaSrc = readFileSync(new URL('../src/MediaView.tsx', import.meta.url), 'utf8');
  const latestCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  check(
    'App.tsx removes Markdown & Read mode-hint boxes and MediaView removes streaming subtitle while spacing .saved-link-view below title',
    !appSrc.includes('Editing the') &&
      !appSrc.includes('Reading view · select Write to make changes') &&
      !mediaSrc.includes('Streams directly from the linked source without downloading a local copy.') &&
      /\.saved-link-view\s*\{[^}]*margin-top:\s*24px;/.test(latestCss),
  );

  // (c) Whiteboard Link card: fixed scrollable height when adding 3+ links, non-shrinking link SVG icon, and link reordering
  const wbLinkRoot = createRoot(document.getElementById('root'));
  let wbLinkBoard = newWhiteboard();
  function WbLinkReorderHarness() {
    const [b, setB] = useState(wbLinkBoard);
    return React.createElement(Whiteboard, {
      path: '/vault/links.comet-whiteboard',
      board: b,
      name: 'links',
      saveState: 'saved',
      onChange: (next) => {
        wbLinkBoard = next;
        setB(next);
        return true;
      },
      onRename() {},
      onRetry() {},
    });
  }
  await act(async () => wbLinkRoot.render(React.createElement(WbLinkReorderHarness)));
  const addLinkCardBtn = [...document.querySelectorAll('.whiteboard-toolbar button')].find(
    (b) => b.textContent.trim() === 'Link',
  );
  await act(async () => addLinkCardBtn.click());
  const initialCardHeight = wbLinkBoard.items[0].height;
  const pasteIntoCard = async (raw) => {
    const inp = document.querySelector('.whiteboard-link-input');
    const pasteEvt = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvt, 'clipboardData', {
      value: { getData: () => raw },
    });
    await act(async () => inp.dispatchEvent(pasteEvt));
  };
  await pasteIntoCard('https://one.example.com');
  await pasteIntoCard('https://two.example.com');
  await pasteIntoCard('https://three.example.com');
  const heightAfterThreeLinks = wbLinkBoard.items[0].height;
  const grips = [...document.querySelectorAll('.whiteboard-link-grip')];
  await act(async () => {
    const downArrow = new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    grips[0].dispatchEvent(downArrow);
  });
  const reorderedUrls = wbLinkBoard.items[0].links.map((l) => l.url);
  check(
    'Whiteboard Link card keeps fixed scrollable height across multiple added links, keeps link SVG icon flex-shrink:0, and reorders links',
    heightAfterThreeLinks === initialCardHeight &&
      grips.length === 3 &&
      reorderedUrls[0] === 'https://two.example.com/' &&
      reorderedUrls[1] === 'https://one.example.com/' &&
      reorderedUrls[2] === 'https://three.example.com/' &&
      /\.whiteboard-link-anchor\s*>\s*svg\s*\{[^}]*flex:\s*0\s+0\s+13px;/.test(latestCss) &&
      latestCss.includes('.comet-editor-prose.whiteboard-prose > p.is-empty:first-child::before') &&
      latestCss.includes('.comet-editor-prose.whiteboard-prose li > p { margin: 0; }'),
  );
  await act(async () => wbLinkRoot.unmount());

  // (d) Notes right-click "Back to normal link" reverts [text](url) back to plain bare URL
  const revertLinkEditor = makeNoteEditor('[dwadwa](https://rclone.org/crypt/)', 'revert-link-note');
  const customRange = findLinkMarkRange(revertLinkEditor.state.doc, 2, 'https://rclone.org/crypt/');
  const revertedOk = Boolean(customRange && replaceLinkDisplayText(revertLinkEditor, customRange, customRange.href));
  const revertedMd = cleanNoteMarkdown(revertLinkEditor.getMarkdown());
  check(
    'Reverting a hyperlinked [text](url) back to normal link restores plain bare URL without hyperlink brackets and App.tsx exposes Back to normal link',
    revertedOk &&
      revertedMd === 'https://rclone.org/crypt/' &&
      appSrc.includes('Back to normal link'),
  );
  revertLinkEditor.destroy();
}

dom.window.close();
delete globalThis.IS_REACT_ACT_ENVIRONMENT;
for (const [k, v] of Object.entries(prevGlobals)) {
  if (v === undefined) delete globalThis[k];
  else globalThis[k] = v;
}

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
