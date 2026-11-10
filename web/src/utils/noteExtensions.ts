import { Extension, InputRule, wrappingInputRule, type Editor, type ExtendedRegExpMatchArray, type JSONContent } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import Link from "@tiptap/extension-link";
import { BulletList, OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import { MarkdownManager } from "@tiptap/markdown";
import { Fragment, type Mark, type Node as ProseMirrorNode, type NodeType } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { canJoin } from "@tiptap/pm/transform";

const CODE_FENCE_LINE = /^(?:```|~~~)([a-z0-9_+-]*)?[\s\n]$/i;
const CODE_FENCE_ENTER = /^(?:```|~~~)([a-z0-9_+-]*)?$/i;
const BULLET_LINE = /^([-+*])\s$/;
const ORDERED_LINE = /^(\d+)[.)]\s$/;
const TASK_LINE = /^(?:[-+*]\s+)?\[([ xX])\]\s$/;
const TYPED_ORDERED_SEQUENCE =
  /^\s*(?:[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)]\s+\S[^\n]*\n\s*(?:[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)]\s+/;

function lineStartMatch(pattern: RegExp) {
  return (text: string) => {
    const breakIndex = text.length >= 2 ? text.lastIndexOf("\n", text.length - 2) : -1;
    const lineStart = breakIndex + 1;
    const line = text.slice(lineStart);
    const hit = pattern.exec(line);
    if (!hit) return null;
    return {
      index: lineStart,
      text: hit[0],
      data: { groups: hit.slice(1), afterBreak: breakIndex >= 0 },
    };
  };
}

function joinAdjacentLists(state: EditorState, pos: number, listType: NodeType): number {
  let cursor = pos;
  const $pos = state.tr.doc.resolve(cursor);
  const listDepth = $pos.depth - 2;
  if (listDepth < 1 || $pos.node(listDepth).type !== listType) return cursor;

  const beforePos = $pos.before(listDepth);
  if (beforePos > 0 && canJoin(state.tr.doc, beforePos)) {
    const $before = state.tr.doc.resolve(beforePos);
    if ($before.nodeBefore?.type === listType) {
      state.tr.join(beforePos);
      cursor = state.tr.mapping.map(pos, -1);
    }
  }

  const $afterCheck = state.tr.doc.resolve(cursor);
  const nextDepth = $afterCheck.depth - 2;
  if (nextDepth >= 1 && $afterCheck.node(nextDepth).type === listType) {
    const afterPos = $afterCheck.after(nextDepth);
    if (afterPos < state.tr.doc.content.size && canJoin(state.tr.doc, afterPos)) {
      const $after = state.tr.doc.resolve(afterPos);
      if ($after.nodeAfter?.type === listType) {
        state.tr.join(afterPos);
      }
    }
  }
  return cursor;
}

function convertFenceRangeToCodeBlock(
  state: EditorState,
  tr: EditorState["tr"],
  fenceFrom: number,
  fenceTo: number,
  language: string | null,
  codeBlockType: NodeType,
): boolean {
  const $start = state.doc.resolve(fenceFrom);
  if (!$start.parent.isTextblock) return false;

  const tailText =
    fenceTo < $start.end() ? state.doc.textBetween(fenceTo, $start.end(), "\n", "\n") : "";
  const codeContent = tailText ? state.schema.text(tailText) : undefined;
  const createCodeNode = (): ProseMirrorNode => codeBlockType.create({ language }, codeContent);

  // Case 1: Directly on a new line after Shift+Enter (`hardBreak`).
  if ($start.nodeBefore?.type.name === "hardBreak" && $start.depth >= 1) {
    const parentDepth = $start.depth - 1;
    const insertIndex = $start.index(parentDepth) + 1;
    if (!$start.node(parentDepth).canReplaceWith(insertIndex, insertIndex, codeBlockType)) {
      return false;
    }
    tr.delete(fenceFrom - 1, $start.end());
    const insertPos = tr.mapping.map($start.after());
    tr.insert(insertPos, createCodeNode());
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
    return true;
  }

  if ($start.parentOffset !== 0) return false;

  // Case 2: Standard paragraph that can be directly converted to a codeBlock.
  if (
    $start.depth >= 1 &&
    $start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), codeBlockType)
  ) {
    tr.delete(fenceFrom, fenceTo).setBlockType(fenceFrom, fenceFrom, codeBlockType, {
      language,
    });
    return true;
  }

  // Case 3: First paragraph inside a `listItem` or `taskItem` (`paragraph block*`).
  const itemDepth = $start.depth - 1;
  const listDepth = $start.depth - 2;
  if (itemDepth < 1 || listDepth < 1) return false;
  const itemNode = $start.node(itemDepth);
  const listNode = $start.node(listDepth);
  if (
    (itemNode.type.name !== "listItem" && itemNode.type.name !== "taskItem") ||
    $start.index(itemDepth) !== 0
  ) {
    return false;
  }

  const itemIndex = $start.index(listDepth);
  const codeNode = createCodeNode();

  // 3a: Single-item list (either top-level or nested via Tab) -> replace the empty list wrapper.
  if (listNode.childCount === 1 && itemNode.childCount === 1) {
    const outerDepth = listDepth - 1;
    const listIndex = $start.index(outerDepth);
    if ($start.node(outerDepth).canReplaceWith(listIndex, listIndex + 1, codeBlockType)) {
      const listPos = $start.before(listDepth);
      tr.replaceWith(listPos, $start.after(listDepth), codeNode);
      tr.setSelection(TextSelection.create(tr.doc, listPos + 1));
      return true;
    }
  }

  // 3b: Newly split item after an existing list item -> attach the code block under the previous item.
  if (itemIndex > 0 && itemNode.childCount === 1) {
    const itemBefore = $start.before(itemDepth);
    const prevItemEnd = itemBefore - 1;
    const $prevEnd = state.doc.resolve(prevItemEnd);
    if (
      $prevEnd.parent.canReplaceWith(
        $prevEnd.parent.childCount,
        $prevEnd.parent.childCount,
        codeBlockType,
      )
    ) {
      tr.delete(itemBefore, $start.after(itemDepth));
      tr.insert(prevItemEnd, codeNode);
      tr.setSelection(TextSelection.create(tr.doc, prevItemEnd + 1));
      return true;
    }
  }

  // 3c: First item of a multi-item list -> place code block right above the remaining items.
  if (itemIndex === 0 && itemNode.childCount === 1) {
    const outerDepth = listDepth - 1;
    const listIndex = $start.index(outerDepth);
    if ($start.node(outerDepth).canReplaceWith(listIndex, listIndex, codeBlockType)) {
      const listPos = $start.before(listDepth);
      tr.delete($start.before(itemDepth), $start.after(itemDepth));
      tr.insert(listPos, codeNode);
      tr.setSelection(TextSelection.create(tr.doc, listPos + 1));
      return true;
    }
  }

  return false;
}

function createCodeFenceInputRule(codeBlockType: NodeType): InputRule {
  return new InputRule({
    find: lineStartMatch(CODE_FENCE_LINE),
    handler: ({ state, range, match }) => {
      const groups = (match.data?.groups as (string | undefined)[] | undefined) ?? [];
      const language = groups[0] || null;
      if (!convertFenceRangeToCodeBlock(state, state.tr, range.from, range.to, language, codeBlockType)) {
        return null;
      }
    },
  });
}

function createListLineInputRule(options: {
  pattern: RegExp;
  listType: NodeType;
  itemName: "listItem" | "taskItem";
  getListAttrs?: (groups: (string | undefined)[]) => Record<string, unknown>;
  getItemAttrs?: (groups: (string | undefined)[]) => Record<string, unknown>;
  fallbackRule: InputRule;
}): InputRule {
  const { pattern, listType, itemName, getListAttrs, getItemAttrs, fallbackRule } = options;
  return new InputRule({
    find: lineStartMatch(pattern),
    handler: (props) => {
      const { state, range, match } = props;
      const groups = (match.data?.groups as (string | undefined)[] | undefined) ?? [];
      const $start = state.doc.resolve(range.from);
      const paragraphType = state.schema.nodes.paragraph;
      const itemType = state.schema.nodes[itemName];
      if (!$start.parent.isTextblock || !paragraphType || !itemType) return null;

      const listAttrs = getListAttrs ? getListAttrs(groups) : {};
      const itemAttrs = getItemAttrs ? getItemAttrs(groups) : {};
      const tailContent =
        range.to < $start.end() ? state.doc.slice(range.to, $start.end()).content : Fragment.empty;

      const createSingleList = (): ProseMirrorNode =>
        listType.create(listAttrs, itemType.create(itemAttrs, paragraphType.create(null, tailContent)));

      // Case 1: List marker typed directly below text after Shift+Enter (`hardBreak`).
      if ($start.nodeBefore?.type.name === "hardBreak" && $start.depth >= 1) {
        const parentDepth = $start.depth - 1;
        const insertIndex = $start.index(parentDepth) + 1;
        if (!$start.node(parentDepth).canReplaceWith(insertIndex, insertIndex, listType)) {
          return null;
        }
        state.tr.delete(range.from - 1, $start.end());
        const insertPos = state.tr.mapping.map($start.after());
        state.tr.insert(insertPos, createSingleList());
        const cursorPos = joinAdjacentLists(state, insertPos + 3, listType);
        state.tr.setSelection(TextSelection.create(state.tr.doc, cursorPos));
        return;
      }

      // Case 2: Inside an already-empty list/task item at offset 0.
      const itemDepth = $start.depth - 1;
      const listDepth = $start.depth - 2;
      if (
        $start.parentOffset === 0 &&
        itemDepth >= 1 &&
        listDepth >= 1 &&
        ($start.node(itemDepth).type.name === "listItem" ||
          $start.node(itemDepth).type.name === "taskItem") &&
        $start.index(itemDepth) === 0 &&
        $start.node(itemDepth).childCount === 1
      ) {
        // If already inside the SAME list type (e.g. `- first` -> Enter -> `- `),
        // absorb the redundant marker cleanly instead of writing `- - second`.
        if ($start.node(listDepth).type === listType) {
          state.tr.delete(range.from, range.to);
          return;
        }

        const currentList = $start.node(listDepth);
        const itemIndex = $start.index(listDepth);
        const outerDepth = listDepth - 1;
        const listIndex = $start.index(outerDepth);
        const newList = createSingleList();

        if (
          currentList.childCount === 1 &&
          $start.node(outerDepth).canReplaceWith(listIndex, listIndex + 1, listType)
        ) {
          const listPos = $start.before(listDepth);
          state.tr.replaceWith(listPos, $start.after(listDepth), newList);
          const cursorPos = joinAdjacentLists(state, listPos + 3, listType);
          state.tr.setSelection(TextSelection.create(state.tr.doc, cursorPos));
          return;
        }

        if (
          itemIndex === currentList.childCount - 1 &&
          $start.node(outerDepth).canReplaceWith(listIndex + 1, listIndex + 1, listType)
        ) {
          state.tr.delete($start.before(itemDepth), $start.after(itemDepth));
          const afterListPos = state.tr.mapping.map($start.after(listDepth));
          state.tr.insert(afterListPos, newList);
          const cursorPos = joinAdjacentLists(state, afterListPos + 3, listType);
          state.tr.setSelection(TextSelection.create(state.tr.doc, cursorPos));
          return;
        }

        if (
          itemIndex === 0 &&
          $start.node(outerDepth).canReplaceWith(listIndex, listIndex, listType)
        ) {
          const beforeListPos = $start.before(listDepth);
          state.tr.delete($start.before(itemDepth), $start.after(itemDepth));
          state.tr.insert(beforeListPos, newList);
          const cursorPos = joinAdjacentLists(state, beforeListPos + 3, listType);
          state.tr.setSelection(TextSelection.create(state.tr.doc, cursorPos));
          return;
        }
      }

      // Case 3: Standard top-level / blockquote paragraph wrapping.
      const standardMatch = Object.assign([match[0], ...groups], {
        index: 0,
        input: match[0],
        data: match.data,
      }) as ExtendedRegExpMatchArray;
      return fallbackRule.handler({ ...props, match: standardMatch });
    },
  });
}

/** Split `hardBreak`s inside selected plain paragraphs before toggling a list from the toolbar. */
export function splitHardBreaksBeforeListToggle(
  editor: {
    isActive: (name: string) => boolean;
    state: EditorState;
    view: { dispatch: (tr: EditorState["tr"]) => void };
  },
  listName: "bulletList" | "orderedList" | "taskList",
): void {
  if (editor.isActive(listName)) return;
  const { state } = editor;
  const { from, to } = state.selection;
  const breakPositions: number[] = [];
  let blockStart = -1;
  let blockEnd = -1;

  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (
      node.type.name === "paragraph" &&
      parent?.type.name !== "listItem" &&
      parent?.type.name !== "taskItem"
    ) {
      let hasBreak = false;
      node.forEach((child, offset) => {
        if (child.type.name === "hardBreak") {
          hasBreak = true;
          breakPositions.push(pos + 1 + offset);
        }
      });
      if (hasBreak) {
        if (blockStart < 0) blockStart = pos + 1;
        blockEnd = pos + node.nodeSize - 1;
      }
      return false;
    }
    return true;
  });

  if (breakPositions.length === 0) return;
  const tr = state.tr;
  for (let i = breakPositions.length - 1; i >= 0; i -= 1) {
    const brPos = breakPositions[i];
    tr.delete(brPos, brPos + 1).split(brPos);
  }
  if (from === to) {
    const mappedCursor = tr.mapping.map(from, 1);
    tr.setSelection(TextSelection.create(tr.doc, mappedCursor));
  } else {
    const mappedStart = tr.mapping.map(Math.max(from, blockStart), 1);
    const mappedEnd = tr.mapping.map(Math.min(to, blockEnd), -1);
    tr.setSelection(TextSelection.create(tr.doc, mappedStart, Math.max(mappedStart, mappedEnd)));
  }
  editor.view.dispatch(tr);
}

function tryConvertFenceOnEnter(editor: { state: EditorState; view: { dispatch: (tr: EditorState["tr"]) => void } }, codeBlockType: NodeType): boolean {
  const { state } = editor;
  const { selection } = state;
  const { $from, empty } = selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type === codeBlockType) return false;

  // Walk back to the start of the current paragraph or the most recent `hardBreak`.
  let lineStartOffset = 0;
  $from.parent.forEach((child, offset) => {
    if (offset < $from.parentOffset && child.type.name === "hardBreak") {
      lineStartOffset = offset + child.nodeSize;
    }
  });
  const blockStart = $from.start();
  const fenceFrom = blockStart + lineStartOffset;
  const lineBeforeCursor = state.doc.textBetween(fenceFrom, $from.pos, "\n", "\n");
  const hit = CODE_FENCE_ENTER.exec(lineBeforeCursor);
  if (!hit) return false;

  const tr = state.tr;
  if (!convertFenceRangeToCodeBlock(state, tr, fenceFrom, $from.pos, hit[1] || null, codeBlockType)) {
    return false;
  }
  editor.view.dispatch(tr);
  return true;
}

const CometCodeBlock = CodeBlock.extend({
  addKeyboardShortcuts() {
    const parentShortcuts = this.parent?.() ?? {};
    return {
      ...parentShortcuts,
      Enter: ({ editor }) => {
        if (tryConvertFenceOnEnter(editor, this.type)) return true;
        return parentShortcuts.Enter ? parentShortcuts.Enter({ editor }) : false;
      },
      "Shift-Enter": ({ editor }) => {
        if (tryConvertFenceOnEnter(editor, this.type)) return true;
        return parentShortcuts["Shift-Enter"] ? parentShortcuts["Shift-Enter"]({ editor }) : false;
      },
    };
  },
  addInputRules() {
    return [createCodeFenceInputRule(this.type)];
  },
}).configure({
  enableTabIndentation: true,
  tabSize: 2,
});

const CometBulletList = BulletList.extend({
  addInputRules() {
    const fallbackRule = wrappingInputRule({
      find: BULLET_LINE,
      type: this.type,
    });
    return [
      createListLineInputRule({
        pattern: BULLET_LINE,
        listType: this.type,
        itemName: "listItem",
        fallbackRule,
      }),
    ];
  },
});

const baseOrderedTokenizer = OrderedList.config.markdownTokenizer;

const CometOrderedList = OrderedList.extend({
  markdownTokenizer: baseOrderedTokenizer
    ? {
        ...baseOrderedTokenizer,
        tokenize: (src, tokens, lexer) => {
          // Delegate standard numeric lists (`1. `, `2) `) to Marked's CommonMark list tokenizer
          // so indented code fences and loose lists preserve exact indentation & continuous numbering,
          // and require >=2 items before treating letters (`a. `, `i. `) as typed lists.
          if (!TYPED_ORDERED_SEQUENCE.test(src)) return undefined;
          return baseOrderedTokenizer.tokenize(src, tokens, lexer);
        },
      }
    : undefined,
  addInputRules() {
    const fallbackRule = wrappingInputRule({
      find: ORDERED_LINE,
      type: this.type,
      getAttributes: (match) => ({ start: Number.parseInt(match[1] ?? "1", 10) || 1 }),
      joinPredicate: (_match, node) =>
        node.type === this.type && (!node.attrs.type || node.attrs.type === "1"),
    });
    return [
      createListLineInputRule({
        pattern: ORDERED_LINE,
        listType: this.type,
        itemName: "listItem",
        getListAttrs: (groups) => ({ start: Number.parseInt(groups[0] ?? "1", 10) || 1 }),
        fallbackRule,
      }),
    ];
  },
});

const CometTaskItem = TaskItem.extend({
  addInputRules() {
    const taskListType = this.editor.schema.nodes.taskList;
    const fallbackRule = wrappingInputRule({
      find: TASK_LINE,
      type: this.type,
      getAttributes: (match) => ({ checked: (match[1] ?? "").toLowerCase() === "x" }),
    });
    if (!taskListType) return [fallbackRule];
    return [
      createListLineInputRule({
        pattern: TASK_LINE,
        listType: taskListType,
        itemName: "taskItem",
        getItemAttrs: (groups) => ({ checked: (groups[0] ?? "").toLowerCase() === "x" }),
        fallbackRule,
      }),
    ];
  },
}).configure({ nested: true });

const NBSP_ONLY_PARAGRAPH = /^\s*(?:&(?:amp;)*nbsp;|&#160;|&#xa0;|\u00a0)\s*$/i;

interface InternalMarkdownManager {
  serialize: (docOrContent: JSONContent | JSONContent[]) => string;
  parse: (markdown: string) => JSONContent;
  parseToken: (token: unknown, parseImplicitEmptyParagraphs?: boolean) => JSONContent | JSONContent[] | null;
  renderNodeToMarkdown: (
    node: JSONContent,
    parentNode?: JSONContent,
    index?: number,
    level?: number,
  ) => string;
  isEmptyOutput: (markdown: string) => boolean;
  createImplicitEmptyParagraphsFromSpace: (
    token: { raw?: string },
    previousNonSpaceTokenIndex: number,
    nextNonSpaceTokenIndex: number,
  ) => JSONContent[];
  __cometBlankLinesPatched?: boolean;
  __cometRootParseActive?: boolean;
}

/**
 * Marked's GFM list rule (`([ \t][^\n]+|(?=\n|$))`) parses `"-"` on an empty line as a bullet
 * item, whereas `"- "` (dash + trailing space before EOL/EOF, emitted by TipTap's `ListItem`)
 * fails both branches and becomes a plain paragraph `"- "`. Strip trailing whitespace after
 * empty list markers outside code fences before Marked lexes the document.
 */
function normalizeEmptyListMarkersForParse(markdown: string): string {
  if (!markdown || !/[-+*0-9.)]/.test(markdown)) return markdown;
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceHit = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceHit) {
      const marker = fenceHit[1][0];
      if (!fence) fence = marker;
      else if (line.trimStart().startsWith(fence.repeat(3))) fence = null;
      continue;
    }
    if (!fence) {
      const bulletEmpty = /^([ \t]{0,12}[-+*])[ \t]+\r?$/.exec(line);
      if (bulletEmpty) {
        lines[i] = bulletEmpty[1];
        changed = true;
        continue;
      }
      const orderedEmpty = /^([ \t]{0,12}\d+[.)])[ \t]+\r?$/.exec(line);
      if (orderedEmpty) {
        lines[i] = orderedEmpty[1];
        changed = true;
      }
    }
  }
  return changed ? lines.join("\n") : markdown;
}

function collapseRedundantAutolinks(markdown: string): string {
  if (!markdown.includes("](http")) return markdown;
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceHit = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceHit) {
      const marker = fenceHit[1][0];
      if (!fence) fence = marker;
      else if (line.trimStart().startsWith(fence.repeat(3))) fence = null;
      continue;
    }
    if (!fence && line.includes("](http")) {
      const replaced = line.replace(
        /\[((?:https?:\/\/)[^\]\n]+)\]\((https?:\/\/[^\s<>()]+)\)/gi,
        (full, label: string, href: string) => {
          const unescaped = label.replace(/\\([\\`*_[\]~])/g, "$1");
          return unescaped === href ? href : full;
        },
      );
      if (replaced !== line) {
        lines[i] = replaced;
        changed = true;
      }
    }
  }
  return changed ? lines.join("\n") : markdown;
}
function installCometMarkdownBlankLineRules(): void {
  const proto = MarkdownManager.prototype as unknown as InternalMarkdownManager;
  if (proto.__cometBlankLinesPatched) return;
  proto.__cometBlankLinesPatched = true;

  const origSerialize = proto.serialize;
  const origParse = proto.parse;
  const origParseToken = proto.parseToken;

  proto.serialize = function serializeCometDoc(
    this: InternalMarkdownManager,
    docOrContent: JSONContent | JSONContent[],
  ): string {
    if (
      docOrContent &&
      !Array.isArray(docOrContent) &&
      docOrContent.type === "doc" &&
      Array.isArray(docOrContent.content)
    ) {
      const blocks = docOrContent.content;
      const items = blocks.map((child, idx) => {
        const rendered = this.renderNodeToMarkdown(child, docOrContent, idx, 0);
        const isEmptyParagraph =
          child.type === "paragraph" && (rendered === "" || NBSP_ONLY_PARAGRAPH.test(rendered));
        return { empty: isEmptyParagraph, text: isEmptyParagraph ? "" : rendered };
      });
      const nonEmptyIndices: number[] = [];
      items.forEach((item, idx) => {
        if (!item.empty) nonEmptyIndices.push(idx);
      });
      if (nonEmptyIndices.length === 0) return "";

      let out = "\n".repeat(nonEmptyIndices[0]);
      for (let k = 0; k < nonEmptyIndices.length; k++) {
        const currentIdx = nonEmptyIndices[k];
        out += items[currentIdx].text;
        if (k < nonEmptyIndices.length - 1) {
          const emptyBetween = nonEmptyIndices[k + 1] - currentIdx - 1;
          out += "\n".repeat(2 + emptyBetween);
        }
      }
      const lastNonEmptyIdx = nonEmptyIndices[nonEmptyIndices.length - 1];
      const lastNonEmptyBlock = blocks[lastNonEmptyIdx];
      // StarterKit's TrailingNode automatically appends 1 empty paragraph after any
      // non-paragraph trailing block (bulletList, orderedList, taskList, codeBlock, etc.).
      const trailingNodeOffset = lastNonEmptyBlock && lastNonEmptyBlock.type !== "paragraph" ? 1 : 0;
      const trailingEmpty = Math.max(0, items.length - 1 - lastNonEmptyIdx - trailingNodeOffset);
      if (trailingEmpty > 0) out += "\n".repeat(trailingEmpty);
      const normalizedOut = collapseRedundantAutolinks(out);
      return this.isEmptyOutput(normalizedOut) ? "" : normalizedOut;
    }
    return origSerialize.call(this, docOrContent);
  };

  proto.parse = function parseCometDoc(this: InternalMarkdownManager, markdown: string): JSONContent {
    const prevRoot = this.__cometRootParseActive;
    this.__cometRootParseActive = true;
    try {
      return origParse.call(this, normalizeEmptyListMarkersForParse(markdown));
    } finally {
      this.__cometRootParseActive = prevRoot;
    }
  };

  proto.parseToken = function parseCometToken(
    this: InternalMarkdownManager,
    token: unknown,
    parseImplicitEmptyParagraphs?: boolean,
  ): JSONContent | JSONContent[] | null {
    const prevRoot = this.__cometRootParseActive;
    this.__cometRootParseActive = false;
    try {
      return origParseToken.call(this, token, parseImplicitEmptyParagraphs);
    } finally {
      this.__cometRootParseActive = prevRoot;
    }
  };

  proto.createImplicitEmptyParagraphsFromSpace = function createCometEmptyParagraphs(
    this: InternalMarkdownManager,
    token: { raw?: string },
    previousNonSpaceTokenIndex: number,
    nextNonSpaceTokenIndex: number,
  ): JSONContent[] {
    if (!this.__cometRootParseActive) {
      return [];
    }
    const newlineCount = ((token.raw || "").replace(/\r\n?/g, "\n").match(/\n/g) || []).length;
    if (newlineCount === 0) return [];
    const emptyParagraphCount =
      previousNonSpaceTokenIndex === -1 || nextNonSpaceTokenIndex === -1
        ? newlineCount
        : Math.max(newlineCount - 2, 0);
    return Array.from({ length: emptyParagraphCount }, () => ({
      type: "paragraph",
      content: [],
    }));
  };
}

installCometMarkdownBlankLineRules();

/**
 * Custom Link extension that serializes plain autolinks (`text === href`) as bare URLs
 * (`https://example.com`) while serializing named hyperlinks (`text !== href`) as `[text](url)`.
 */
export const cometLinkExtension = Link.extend({
  renderMarkdown: (node, h, ctx) => {
    const href = typeof node.attrs?.href === "string" ? node.attrs.href : "";
    const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
    const text = h.renderChildren(node);
    const meta = ctx?.meta as { markText?: unknown } | undefined;
    const markText = typeof meta?.markText === "string" ? meta.markText : text;
    if (!title && markText === href && /^https?:\/\/[^\s<>[\]()\\`*_~&]+$/i.test(href)) {
      return text;
    }
    return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`;
  },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  markdownLinks: true,
  HTMLAttributes: { rel: "noopener noreferrer nofollow", target: null },
});

const CometParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) => {
    const tokens = token.tokens ?? [];
    if (
      tokens.length === 1 &&
      tokens[0].type === "text" &&
      (NBSP_ONLY_PARAGRAPH.test(tokens[0].raw ?? "") || NBSP_ONLY_PARAGRAPH.test(tokens[0].text ?? ""))
    ) {
      return helpers.createNode("paragraph", undefined, []);
    }
    return helpers.createNode("paragraph", undefined, helpers.parseInline(tokens));
  },
  renderMarkdown: (node, h) => {
    if (!node) return "";
    const content = Array.isArray(node.content) ? node.content : [];
    if (content.length === 0) return "";
    const rendered = h.renderChildren(content);
    return NBSP_ONLY_PARAGRAPH.test(rendered) ? "" : rendered;
  },
});

export interface LinkMarkTarget {
  from: number;
  to: number;
  href: string;
  text: string;
}

/** Locate the full contiguous `{ from, to, href, text }` span of a link mark at `pos`. */
export function findLinkMarkRange(doc: ProseMirrorNode, pos: number): LinkMarkTarget | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const blockStart = $pos.start();

  // Check child at or immediately adjacent to `parentOffset`.
  let targetHref = "";
  parent.forEach((child, offset) => {
    if (targetHref || !child.isText) return;
    const start = offset;
    const end = offset + child.nodeSize;
    if ($pos.parentOffset >= start && $pos.parentOffset <= end) {
      const mark = child.marks.find((m) => m.type.name === "link" && typeof m.attrs.href === "string");
      if (mark) targetHref = String(mark.attrs.href);
    }
  });
  if (!targetHref) return null;

  let spanFrom = -1;
  let spanTo = -1;
  let done = false;
  parent.forEach((child, offset) => {
    if (done) return;
    if (!child.isText) {
      if (spanFrom !== -1 && blockStart + offset >= pos) {
        done = true;
        return;
      }
      if (offset + child.nodeSize <= $pos.parentOffset) {
        spanFrom = -1;
        spanTo = -1;
      }
      return;
    }
    const hasSameLink = child.marks.some(
      (m) => m.type.name === "link" && String(m.attrs.href) === targetHref,
    );
    if (hasSameLink) {
      if (spanFrom === -1) spanFrom = blockStart + offset;
      spanTo = blockStart + offset + child.nodeSize;
    } else if (spanFrom !== -1) {
      if (blockStart + offset >= pos) {
        done = true;
        return;
      }
      spanFrom = -1;
      spanTo = -1;
    }
  });

  if (spanFrom === -1 || spanTo <= spanFrom) return null;
  return {
    from: spanFrom,
    to: spanTo,
    href: targetHref,
    text: doc.textBetween(spanFrom, spanTo, "", ""),
  };
}

/**
 * Replace the visible display label of a link mark while preserving its `href`
 * and any surrounding inline formatting marks (bold, italic, color, etc.).
 */
export function replaceLinkDisplayText(
  editor: Editor,
  target: LinkMarkTarget,
  displayText: string,
): boolean {
  const label = displayText.trim();
  if (!label || editor.isDestroyed) return false;
  const { state } = editor;
  const linkType = state.schema.marks.link;
  if (!linkType) return false;
  if (target.from < 0 || target.to > state.doc.content.size || target.from >= target.to) {
    return false;
  }

  let preservedMarks: readonly Mark[] = [linkType.create({ href: target.href })];
  state.doc.nodesBetween(target.from, target.to, (node) => {
    if (node.isText && node.marks.some((m) => m.type === linkType)) {
      const nonLink = node.marks.filter((m) => m.type !== linkType);
      preservedMarks = [...nonLink, linkType.create({ href: target.href })];
      return false;
    }
    return true;
  });

  const tr = state.tr
    .replaceWith(target.from, target.to, state.schema.text(label, preservedMarks))
    .setMeta("preventAutolink", true);
  tr.setSelection(TextSelection.create(tr.doc, target.from + label.length));
  editor.view.dispatch(tr);
  return true;
}

function selectionSingleLinkMark(state: EditorState, from: number, to: number): Mark | null {
  if (from >= to) return null;
  const linkType = state.schema.marks.link;
  if (!linkType) return null;
  let found: Mark | null = null;
  let valid = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (!valid) return false;
    if (!node.isText) return true;
    const mark = node.marks.find((m) => m.type === linkType);
    if (!mark) {
      valid = false;
      return false;
    }
    if (!found) found = mark;
    else if (found.attrs.href !== mark.attrs.href) {
      valid = false;
      return false;
    }
    return true;
  });
  return valid ? found : null;
}

const linkEditGuardKey = new PluginKey<string | null>("cometLinkEditGuard");

/**
 * When a user selects the text of an existing link (e.g. a YouTube URL) to type a custom
 * title, ProseMirror normally drops the `link` mark (`inclusive: false`), breaking both the
 * hyperlink and its video/link embed. Keep `href` active for the entire overtyped title!
 */
const CometLinkEditGuard = Extension.create({
  name: "cometLinkEditGuard",
  addProseMirrorPlugins() {
    return [
      new Plugin<string | null>({
        key: linkEditGuardKey,
        state: {
          init: () => null,
          apply(tr, prev) {
            const meta = tr.getMeta(linkEditGuardKey);
            if (meta !== undefined) return meta;
            if (!tr.docChanged && tr.selectionSet) return null;
            return prev;
          },
        },
        props: {
          handleKeyDown(view, event) {
            if (
              linkEditGuardKey.getState(view.state) &&
              (event.key === "Escape" || event.key === "Enter" || event.key === "ArrowRight" || event.key === "ArrowLeft")
            ) {
              view.dispatch(view.state.tr.setMeta(linkEditGuardKey, null));
            }
            return false;
          },
          handleTextInput(view, from, to, text) {
            if (!text || /^https?:\/\//i.test(text)) return false;
            const { state } = view;
            const linkType = state.schema.marks.link;
            if (!linkType) return false;

            if (from < to) {
              const linkMark = selectionSingleLinkMark(state, from, to);
              if (!linkMark) return false;
              let marks: readonly Mark[] = [linkMark];
              state.doc.nodesBetween(from, to, (node) => {
                if (node.isText) {
                  marks = [...node.marks.filter((m) => m.type !== linkType), linkMark];
                  return false;
                }
                return true;
              });
              const tr = state.tr
                .replaceWith(from, to, state.schema.text(text, marks))
                .setMeta("preventAutolink", true)
                .setMeta(linkEditGuardKey, String(linkMark.attrs.href));
              tr.setSelection(TextSelection.create(tr.doc, from + text.length));
              view.dispatch(tr);
              return true;
            }

            const activeHref = linkEditGuardKey.getState(state);
            if (!activeHref) return false;
            const $from = state.doc.resolve(from);
            const before = $from.nodeBefore;
            const prevLink = before?.isText
              ? before.marks.find((m) => m.type === linkType && String(m.attrs.href) === activeHref)
              : null;
            if (!prevLink || !before) return false;

            const marks: readonly Mark[] = [
              ...before.marks.filter((m) => m.type !== linkType),
              prevLink,
            ];
            const tr = state.tr
              .insertText(text, from, to)
              .addMark(from, from + text.length, prevLink)
              .setMeta("preventAutolink", true)
              .setMeta(linkEditGuardKey, activeHref);
            for (const m of marks) {
              if (m.type !== linkType) tr.addMark(from, from + text.length, m);
            }
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
            view.dispatch(tr);
            return true;
          },
        },
      }),
    ];
  },
});

export const noteBlockExtensions = [
  CometParagraph,
  CometCodeBlock,
  CometBulletList,
  CometOrderedList,
  TaskList,
  CometTaskItem,
  CometLinkEditGuard,
];
