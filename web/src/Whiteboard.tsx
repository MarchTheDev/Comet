import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Code2,
  Diamond,
  ExternalLink,
  GripVertical,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  LoaderCircle,
  Minus,
  PaintBucket,
  Pencil,
  Plus,
  Quote,
  RotateCcw,
  Square,
  Strikethrough,
  Trash2,
  Triangle,
  Type,
  Underline,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AppSelect } from "./AppSelect";
import { ClearBoardDialog } from "./ClearBoardDialog";
import { ColorMenu } from "./ColorMenu";
import { LinkDialog } from "./LinkDialog";
import {
  extractLinksFromText,
  LinkEmbedCard,
  LinkEmbeds,
  normalizeEmbedUrl,
  openExternalWebUrl,
} from "./utils/linkEmbeds";
import { trackConnectorDots } from "./utils/connectorDot";
import { inlineLinkAt, insertInlineLink, removeInlineLink } from "./utils/inlineLinks";
import { droppedBrowserLink } from "./utils/links";
import { cleanNoteMarkdown } from "./utils/markdown";
import {
  cometLinkExtension,
  noteBlockExtensions,
  splitHardBreaksBeforeListToggle,
} from "./utils/noteExtensions";
import { richTextExtensions } from "./utils/richText";
import type { SaveState } from "./utils/saveQueue";
import { TODO_MAX_COORD, todoId } from "./utils/todo";
import { connectionGeometry, type Point } from "./utils/todoGeometry";
import { isStandaloneTextInput, UndoHistory, undoRedoKey } from "./utils/undoHistory";
import { VideoEmbeds } from "./utils/videoEmbeds";
import {
  newWhiteboardItem,
  newWhiteboardLink,
  newWhiteboardTodo,
  TODO_CONNECTION_COLOR,
  type WhiteboardDocument,
  type WhiteboardItem,
  type WhiteboardItemType,
  type WhiteboardLinkEntry,
  type WhiteboardShape,
  type WhiteboardStroke,
} from "./utils/whiteboard";
import { WhiteboardTodoText } from "./WhiteboardTodoText";

const clamp = (value: number) => Math.max(0, Math.min(TODO_MAX_COORD, Math.round(value)));
const clampRange = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(value)));
const strokePath = (points: Point[]) =>
  points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ") +
  (points.length === 1 ? " l0.01 0" : "");
const shapeBounds = (start: Point, end: Point) => ({
  x: clamp(Math.min(start.x, end.x)),
  y: clamp(Math.min(start.y, end.y)),
  width: Math.max(30, Math.min(1600, Math.abs(end.x - start.x))),
  height: Math.max(30, Math.min(1200, Math.abs(end.y - start.y))),
});

const escapeAttr = (value: string) =>
  typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");

export type ResizeCorner = "nw" | "ne" | "sw" | "se";

const RESIZE_CORNERS: { corner: ResizeCorner; labelSuffix: string }[] = [
  { corner: "nw", labelSuffix: " top-left" },
  { corner: "ne", labelSuffix: " top-right" },
  { corner: "sw", labelSuffix: " bottom-left" },
  { corner: "se", labelSuffix: "" },
];

export function resizeWhiteboardItem(
  item: Pick<WhiteboardItem, "type" | "x" | "y" | "width" | "height">,
  corner: ResizeCorner,
  dx: number,
  dy: number,
): { x: number; y: number; width: number; height: number } {
  const minW = item.type === "shape" ? 30 : 160;
  const maxW = 1600;
  const minH = item.type === "shape" ? 30 : 110;
  const maxH = 1200;
  const right = item.x + item.width;
  const bottom = item.y + item.height;

  let x = item.x;
  let width = item.width;
  if (corner === "nw" || corner === "sw") {
    const minX = Math.max(0, right - maxW);
    const maxX = Math.max(0, right - minW);
    x = clampRange(item.x + dx, minX, maxX);
    width = clampRange(right - x, minW, maxW);
  } else {
    width = clampRange(item.width + dx, minW, maxW);
  }

  let y = item.y;
  let height = item.height;
  if (corner === "nw" || corner === "ne") {
    const minY = Math.max(0, bottom - maxH);
    const maxY = Math.max(0, bottom - minH);
    y = clampRange(item.y + dy, minY, maxY);
    height = clampRange(bottom - y, minH, maxH);
  } else {
    height = clampRange(item.height + dy, minH, maxH);
  }

  return { x, y, width, height };
}

/**
 * How far one turn of the wheel should move the canvas sideways, in pixels.
 * A mouse reports the turn on the vertical axis; a trackpad may already report
 * it sideways. Wheels that count in lines or pages are converted.
 */
export function sidewaysWheelDistance(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">,
  pageWidth: number,
): number {
  const raw = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (!Number.isFinite(raw)) return 0;
  return raw * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? Math.max(1, pageWidth * 0.9) : 1);
}

export interface WhiteboardViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Find an open spot inside the currently visible zoom viewport so newly created
 * windows don't stack on top of existing windows whenever empty space is available.
 */
export function findOpenWhiteboardSpot(
  items: Pick<WhiteboardItem, "type" | "x" | "y" | "width" | "height">[],
  itemSize: { width: number; height: number },
  viewport: WhiteboardViewport,
  margin = 16,
): Point {
  const padX = 48;
  const padY = 48;
  const startX = clamp(viewport.x + padX);
  const startY = clamp(viewport.y + padY);
  const maxX = Math.max(startX, clamp(viewport.x + viewport.width - itemSize.width - padX));
  const maxY = Math.max(startY, clamp(viewport.y + viewport.height - itemSize.height - padY));
  const stepX = 42;
  const stepY = 42;

  const overlaps = (
    x: number,
    y: number,
    obstacles: Pick<WhiteboardItem, "x" | "y" | "width" | "height">[],
  ) =>
    obstacles.some(
      (other) =>
        x - margin < other.x + other.width &&
        x + itemSize.width + margin > other.x &&
        y - margin < other.y + other.height &&
        y + itemSize.height + margin > other.y,
    );

  // Pass 1: avoid every existing item (including shapes).
  for (let y = startY; y <= maxY; y += stepY) {
    for (let x = startX; x <= maxX; x += stepX) {
      if (!overlaps(x, y, items)) return { x: clamp(x), y: clamp(y) };
    }
  }

  // Pass 2: if a large background shape covers the viewport, avoid non-shape windows.
  const windowsOnly = items.filter((item) => item.type !== "shape");
  if (windowsOnly.length < items.length) {
    for (let y = startY; y <= maxY; y += stepY) {
      for (let x = startX; x <= maxX; x += stepX) {
        if (!overlaps(x, y, windowsOnly)) return { x: clamp(x), y: clamp(y) };
      }
    }
  }

  // Fallback when the visible viewport is completely full: stagger inside the viewport.
  const count = items.length;
  const spanX = Math.max(1, maxX - startX);
  const spanY = Math.max(1, maxY - startY);
  return {
    x: clamp(startX + ((count * 36) % (spanX + 1))),
    y: clamp(startY + ((count * 28) % (spanY + 1))),
  };
}

function ShapeOutline({ shape }: { shape: WhiteboardShape }) {
  return shape === "ellipse" ? (
    <ellipse cx="50" cy="50" rx="48" ry="47" />
  ) : shape === "diamond" ? (
    <polygon points="50,2 98,50 50,98 2,50" />
  ) : shape === "triangle" ? (
    <polygon points="50,3 98,96 2,96" />
  ) : (
    <rect x="2" y="2" width="96" height="96" rx="3" />
  );
}

function WhiteboardRichText({
  boardPath,
  itemId,
  text,
  autoFocus,
  onAutoFocused,
  onChange,
}: {
  boardPath: string;
  itemId: string;
  text: string;
  autoFocus: boolean;
  onAutoFocused: () => void;
  onChange: (next: string) => void;
}) {
  const scope = `wb:${boardPath || "memory"}:${itemId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const initialTextRef = useRef(cleanNoteMarkdown(text));
  const lastSerializedRef = useRef(initialTextRef.current);
  const [, setFormatTick] = useState(0);
  const [linkDraft, setLinkDraft] = useState<{ url: string; editing: boolean; showText: boolean } | null>(
    null,
  );

  useEffect(() => {
    const mount = hostRef.current;
    if (!mount) return;
    const instance = new Editor({
      element: mount,
      content: initialTextRef.current,
      contentType: "markdown",
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
        VideoEmbeds.configure({ getScope: () => scopeRef.current }),
        LinkEmbeds.configure({
          getScope: () => scopeRef.current,
          onOpenUrl: openExternalWebUrl,
        }),
        Markdown,
      ],
      editorProps: {
        attributes: {
          class: "comet-editor-prose whiteboard-prose",
          role: "textbox",
          "aria-label": "Text box text",
          "aria-multiline": "true",
          "data-placeholder": "Start writing…",
        },
      },
      onTransaction: () => {
        setFormatTick((n) => (n + 1) % 100000);
      },
      onUpdate: ({ editor: current }) => {
        const next = cleanNoteMarkdown(current.getMarkdown()).slice(0, 10000);
        lastSerializedRef.current = next;
        onChangeRef.current(next);
      },
    });
    editorRef.current = instance;
    return () => {
      editorRef.current = null;
      instance.destroy();
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    const cleaned = cleanNoteMarkdown(text);
    if (cleaned === lastSerializedRef.current) return;
    if (cleanNoteMarkdown(editor.getMarkdown()) === cleaned) {
      lastSerializedRef.current = cleaned;
      return;
    }
    lastSerializedRef.current = cleaned;
    editor.commands.setContent(cleaned, { contentType: "markdown", emitUpdate: false });
  }, [text]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!autoFocus || !editor || editor.isDestroyed) return;
    try {
      editor.commands.focus("end", { scrollIntoView: false });
    } catch {
      editor.view.dom.focus();
    }
    onAutoFocused();
  }, [autoFocus, onAutoFocused]);

  const ed = editorRef.current;
  const runCmd = (fn: (instance: Editor) => void) => {
    const instance = editorRef.current;
    if (!instance || instance.isDestroyed) return;
    fn(instance);
  };

  const openLinkDialog = () => {
    const instance = editorRef.current;
    if (!instance || instance.isDestroyed) return;
    const editing = instance.isActive("link");
    setLinkDraft({
      url: editing ? String(instance.getAttributes("link").href ?? "") : "",
      editing,
      // With nothing selected there are no words to link yet, so ask for them.
      showText: !editing && instance.state.selection.empty,
    });
  };
  const closeLinkDialog = () => {
    setLinkDraft(null);
    runCmd((i) => i.commands.focus(undefined, { scrollIntoView: false }));
  };

  return (
    <div
      className="whiteboard-rich-wrap"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="whiteboard-text-toolbar" role="toolbar" aria-label="Text box formatting">
        <button
          type="button"
          className={ed?.isActive("heading", { level: 1 }) ? "active" : ""}
          title="Heading 1"
          aria-label="Heading 1"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCmd((i) => i.chain().focus().toggleHeading({ level: 1 }).run())}
        >
          <Heading1 size={13} />
        </button>
        <button
          type="button"
          className={ed?.isActive("heading", { level: 2 }) ? "active" : ""}
          title="Heading 2"
          aria-label="Heading 2"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCmd((i) => i.chain().focus().toggleHeading({ level: 2 }).run())}
        >
          <Heading2 size={13} />
        </button>
        <span className="whiteboard-toolbar-sep" />
        <button
          type="button"
          className={ed?.isActive("bold") ? "active" : ""}
          title="Bold"
          aria-label="Bold"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCmd((i) => i.chain().focus().toggleBold().run())}
        >
          <Bold size={13} />
        </button>
        <button
          type="button"
          className={ed?.isActive("italic") ? "active" : ""}
          title="Italic"
          aria-label="Italic"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCmd((i) => i.chain().focus().toggleItalic().run())}
        >
          <Italic size={13} />
        </button>
        <button
          type="button"
          className={ed?.isActive("underline") ? "active" : ""}
          title="Underline"
          aria-label="Underline"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCmd((i) => i.chain().focus().toggleUnderline().run())}
        >
          <Underline size={13} />
        </button>
        <button
          type="button"
          className={ed?.isActive("strike") ? "active" : ""}
          title="Strikethrough"
          aria-label="Strikethrough"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCmd((i) => i.chain().focus().toggleStrike().run())}
        >
          <Strikethrough size={13} />
        </button>
        <button
          type="button"
          className={ed?.isActive("link") ? "active" : ""}
          title={ed?.isActive("link") ? "Edit link" : "Add link"}
          aria-label={ed?.isActive("link") ? "Edit link" : "Add link"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openLinkDialog}
        >
          <Link2 size={13} />
        </button>
        <span className="whiteboard-toolbar-sep" />
        <button
          type="button"
          className={ed?.isActive("bulletList") ? "active" : ""}
          title="Bullet list"
          aria-label="Bullet list"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            runCmd((i) => {
              splitHardBreaksBeforeListToggle(i, "bulletList");
              i.chain().focus().toggleBulletList().run();
            })
          }
        >
          <List size={13} />
        </button>
        <button
          type="button"
          className={ed?.isActive("orderedList") ? "active" : ""}
          title="Numbered list"
          aria-label="Numbered list"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            runCmd((i) => {
              splitHardBreaksBeforeListToggle(i, "orderedList");
              i.chain().focus().toggleOrderedList().run();
            })
          }
        >
          <ListOrdered size={13} />
        </button>
        <button
          type="button"
          className={ed?.isActive("taskList") ? "active" : ""}
          title="Task list"
          aria-label="Task list"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            runCmd((i) => {
              splitHardBreaksBeforeListToggle(i, "taskList");
              i.chain().focus().toggleTaskList().run();
            })
          }
        >
          <ListChecks size={13} />
        </button>
        <button
          type="button"
          className={ed?.isActive("blockquote") ? "active" : ""}
          title="Quote"
          aria-label="Quote"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCmd((i) => i.chain().focus().toggleBlockquote().run())}
        >
          <Quote size={13} />
        </button>
        <button
          type="button"
          className={ed?.isActive("code") || ed?.isActive("codeBlock") ? "active" : ""}
          title="Inline code"
          aria-label="Inline code"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCmd((i) => i.chain().focus().toggleCode().run())}
        >
          <Code2 size={13} />
        </button>
      </div>
      <div
        ref={hostRef}
        className="whiteboard-rich-editor"
        onClick={(event) => {
          const targetEl = event.target instanceof Element ? event.target : null;
          if (targetEl?.closest(".comet-link-embed, .inline-video")) return;
          const anchor = targetEl?.closest("a");
          if (anchor) {
            event.preventDefault();
            const selection = window.getSelection?.();
            if (selection && !selection.isCollapsed) return;
            const href = anchor.getAttribute("href") ?? "";
            if (href) {
              event.stopPropagation();
              openExternalWebUrl(href);
            }
            return;
          }
          const editor = editorRef.current;
          if (editor && !editor.isDestroyed && event.target === event.currentTarget) {
            try {
              editor.commands.focus("end", { scrollIntoView: false });
            } catch {
              editor.view.dom.focus();
            }
          }
        }}
      />
      {linkDraft && (
        <LinkDialog
          initialUrl={linkDraft.url}
          showText={linkDraft.showText}
          editing={linkDraft.editing}
          onCancel={closeLinkDialog}
          onRemove={
            linkDraft.editing
              ? () => {
                  setLinkDraft(null);
                  runCmd((i) => i.chain().focus().extendMarkRange("link").unsetLink().run());
                }
              : undefined
          }
          onSubmit={({ text: label, href }) => {
            const insertNew = linkDraft.showText;
            setLinkDraft(null);
            runCmd((i) => {
              if (insertNew) {
                i.chain()
                  .focus()
                  .insertContent({
                    type: "text",
                    text: label || href,
                    marks: [{ type: "link", attrs: { href } }],
                  })
                  // Whatever is typed next is ordinary text, not more of the link.
                  .unsetMark("link")
                  .run();
              } else {
                i.chain().focus().extendMarkRange("link").setLink({ href }).run();
              }
            });
          }}
        />
      )}
    </div>
  );
}

function WhiteboardLinkBody({
  item,
  autoFocus,
  onAutoFocused,
  onUpdateLinks,
}: {
  item: WhiteboardItem;
  autoFocus: boolean;
  onAutoFocused: () => void;
  onUpdateLinks: (links: WhiteboardLinkEntry[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [inputError, setInputError] = useState("");
  const [pagedMode, setPagedMode] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const links = item.links ?? [];
  const linksRef = useRef(links);
  linksRef.current = links;
  const onUpdateLinksRef = useRef(onUpdateLinks);
  onUpdateLinksRef.current = onUpdateLinks;

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    onAutoFocused();
  }, [autoFocus, onAutoFocused]);

  useEffect(() => {
    if (pageIndex >= links.length && links.length > 0) {
      setPageIndex(links.length - 1);
    }
  }, [links.length, pageIndex]);

  const moveLinkByOffset = (entryId: string, delta: -1 | 1) => {
    const current = linksRef.current;
    const idx = current.findIndex((l) => l.id === entryId);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= current.length) return;
    const next = [...current];
    const [moved] = next.splice(idx, 1);
    next.splice(targetIdx, 0, moved);
    onUpdateLinksRef.current(next);
  };

  const startLinkReorder = (event: ReactPointerEvent<HTMLButtonElement>, entryId: string) => {
    if (event.button !== 0 || linksRef.current.length < 2) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startY = event.clientY;
    let moved = false;
    let currentHint: { id: string; after: boolean } | null = null;
    setDraggingId(entryId);

    const onMove = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!moved && Math.abs(next.clientY - startY) < 4) return;
      moved = true;
      const container = listRef.current;
      if (!container) return;
      const rows = [...container.querySelectorAll<HTMLElement>("[data-wb-link-id]")];
      let picked: { id: string; after: boolean } | null = null;
      for (const row of rows) {
        const rowId = row.dataset.wbLinkId;
        if (!rowId || rowId === entryId) continue;
        const r = row.getBoundingClientRect();
        if (next.clientY <= r.bottom) {
          picked = { id: rowId, after: next.clientY >= r.top + r.height / 2 };
          break;
        }
        picked = { id: rowId, after: true };
      }
      currentHint = picked;
      setDropHint(picked);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDraggingId(null);
      setDropHint(null);
    };

    const onUp = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const finalHint = currentHint;
      cleanup();
      if (!moved || !finalHint || finalHint.id === entryId) return;
      const current = linksRef.current;
      const fromIdx = current.findIndex((l) => l.id === entryId);
      if (fromIdx < 0) return;
      const without = current.filter((l) => l.id !== entryId);
      const targetIdx = without.findIndex((l) => l.id === finalHint.id);
      if (targetIdx < 0) return;
      const insertAt = finalHint.after ? targetIdx + 1 : targetIdx;
      const reordered = [...without];
      reordered.splice(insertAt, 0, current[fromIdx]);
      onUpdateLinksRef.current(reordered);
    };

    const onCancel = (next: PointerEvent) => {
      if (next.pointerId === pointerId) cleanup();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const appendUrls = (rawInput: string): boolean => {
    const extracted = extractLinksFromText(rawInput);
    if (!extracted.length) {
      const withProto = /^https?:\/\//i.test(rawInput.trim())
        ? rawInput.trim()
        : rawInput.trim().includes(".") && !/\s/.test(rawInput.trim())
          ? `https://${rawInput.trim()}`
          : "";
      const single = withProto ? normalizeEmbedUrl(withProto) : null;
      if (single) extracted.push(single);
    }
    if (!extracted.length) {
      setInputError("Paste one or more valid http/https links.");
      return false;
    }
    const existingUrls = new Set(links.map((entry) => entry.url));
    const additions = extracted
      .filter((url) => !existingUrls.has(url))
      .map((url) => newWhiteboardLink(url, true));
    const merged = [...links, ...additions].slice(0, 100);
    onUpdateLinks(merged);
    setDraft("");
    setInputError("");
    return true;
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    appendUrls(draft);
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const candidate = draft.trim() ? `${draft.trim()} ${text}` : text;
    const extracted = extractLinksFromText(candidate);
    if (!extracted.length && !draft.trim()) {
      const trimmed = text.trim();
      const withProto = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : trimmed.includes(".") && !/\s/.test(trimmed)
          ? `https://${trimmed}`
          : "";
      const single = withProto ? normalizeEmbedUrl(withProto) : null;
      if (single) extracted.push(single);
    }
    if (extracted.length >= 1) {
      event.preventDefault();
      appendUrls(candidate);
    }
  };

  const visibleEntries =
    pagedMode && links.length > 1
      ? [links[Math.min(pageIndex, links.length - 1)]]
      : links;

  return (
    <div
      className="whiteboard-item-content whiteboard-link-body"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <form className="whiteboard-link-form" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          type="text"
          className="whiteboard-link-input"
          aria-label="Paste one or more links"
          placeholder="Paste link or press Enter…"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (inputError) setInputError("");
          }}
          onPaste={handlePaste}
        />
      </form>
      {inputError && <small className="whiteboard-link-error">{inputError}</small>}

      {links.length > 1 && (
        <div className="whiteboard-link-bar">
          <button
            type="button"
            className={!pagedMode ? "is-active" : ""}
            onClick={() => setPagedMode(false)}
          >
            All ({links.length})
          </button>
          <button
            type="button"
            className={pagedMode ? "is-active" : ""}
            onClick={() => setPagedMode(true)}
          >
            Pages
          </button>
          {pagedMode && (
            <div className="whiteboard-link-pager">
              <button
                type="button"
                aria-label="Previous link"
                disabled={pageIndex <= 0}
                onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft size={13} />
              </button>
              <span>
                {Math.min(pageIndex + 1, links.length)} / {links.length}
              </span>
              <button
                type="button"
                aria-label="Next link"
                disabled={pageIndex >= links.length - 1}
                onClick={() => setPageIndex((p) => Math.min(links.length - 1, p + 1))}
              >
                <ChevronRight size={13} />
              </button>
            </div>
          )}
        </div>
      )}

      <div ref={listRef} className="whiteboard-link-list">
        {visibleEntries.length === 0 ? (
          <p className="whiteboard-link-empty">
            Paste one or multiple URLs above to keep links and their previews together.
          </p>
        ) : (
          visibleEntries.map((entry, idx) => (
            <div
              key={entry.id}
              data-wb-link-id={entry.id}
              className={`whiteboard-link-entry${draggingId === entry.id ? " is-dragging" : ""}${
                dropHint?.id === entry.id ? (dropHint.after ? " drop-after" : " drop-before") : ""
              }`}
            >
              <div className="whiteboard-link-row">
                {!pagedMode && links.length > 1 && (
                  <button
                    type="button"
                    className="whiteboard-link-grip"
                    aria-label={`Reorder link ${idx + 1}`}
                    title="Drag to reorder (or press Up / Down arrows)"
                    onPointerDown={(event) => startLinkReorder(event, entry.id)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveLinkByOffset(entry.id, -1);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveLinkByOffset(entry.id, 1);
                      }
                    }}
                  >
                    <GripVertical size={13} aria-hidden="true" />
                  </button>
                )}
                <a
                  href={entry.url}
                  rel="noreferrer noopener"
                  className="whiteboard-link-anchor"
                  title={`Open ${entry.url}`}
                  onClick={(event) => {
                    event.preventDefault();
                    openExternalWebUrl(entry.url);
                  }}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  <span>{entry.url}</span>
                </a>
                {!entry.showEmbed && (
                  <button
                    type="button"
                    className="whiteboard-link-restore"
                    title="Show link preview"
                    onClick={() =>
                      onUpdateLinks(
                        links.map((l) => (l.id === entry.id ? { ...l, showEmbed: true } : l)),
                      )
                    }
                  >
                    Preview
                  </button>
                )}
                <button
                  type="button"
                  className="whiteboard-todo-remove whiteboard-link-delete"
                  aria-label="Remove link"
                  title="Remove link"
                  onClick={() => onUpdateLinks(links.filter((l) => l.id !== entry.id))}
                >
                  <X size={13} />
                </button>
              </div>
              {entry.showEmbed && (
                <LinkEmbedCard
                  url={entry.url}
                  compact
                  onOpen={openExternalWebUrl}
                  onDismiss={() =>
                    onUpdateLinks(
                      links.map((l) => (l.id === entry.id ? { ...l, showEmbed: false } : l)),
                    )
                  }
                />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const SHAPES: { value: WhiteboardShape; label: string; icon: typeof Square }[] = [
  { value: "rectangle", label: "Rectangle", icon: Square },
  { value: "ellipse", label: "Ellipse", icon: Circle },
  { value: "diamond", label: "Diamond", icon: Diamond },
  { value: "triangle", label: "Triangle", icon: Triangle },
];
const layerKey = (path: string) => `comet:whiteboard-layers:v1:${encodeURIComponent(path)}`;
function readLayers(path: string): string[] {
  if (!path) return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(layerKey(path)) || "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length <= 100))].slice(-1000)
      : [];
  } catch {
    return [];
  }
}

export function Whiteboard({
  board,
  name,
  path = "",
  saveState,
  onChange,
  onRename,
  onRetry,
}: {
  board: WhiteboardDocument;
  name: string;
  path?: string;
  saveState: SaveState;
  onChange: (board: WhiteboardDocument) => boolean;
  onRename: () => void;
  onRetry: () => void;
}) {
  // Layer order is local display metadata, not a board edit. Opening or focusing
  // an old board must not rewrite it or upgrade its on-disk format.
  const [layers, setLayers] = useState<string[]>(() => readLayers(path));
  const prevPathRef = useRef(path);
  useEffect(() => {
    if (prevPathRef.current !== path) {
      prevPathRef.current = path;
      setLayers(readLayers(path));
      return;
    }
    if (path) {
      try {
        localStorage.setItem(layerKey(path), JSON.stringify(layers));
      } catch {
        /* arrangement still works for this session */
      }
    }
  }, [path, layers]);

  const stage = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const latest = useRef(board);
  const cleanupDrag = useRef<(() => void) | null>(null);
  latest.current = board;

  const bringToFront = (id: string, itemsSnapshot: WhiteboardItem[] = latest.current.items) =>
    setLayers((previous) => {
      if (previous.at(-1) === id) return previous;
      const existing = new Set(itemsSnapshot.map((item) => item.id));
      existing.add(id);
      return [...previous.filter((item) => item !== id && existing.has(item)), id].slice(-1000);
    });

  const historyRef = useRef(new UndoHistory<WhiteboardDocument>(100, 500));
  const [zoom, setZoom] = useState(1);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [drawing, setDrawing] = useState<{ from: string; end: Point } | null>(null);
  const [selected, setSelected] = useState("");
  const [deleting, setDeleting] = useState("");
  const [error, setError] = useState("");
  const [pendingCardFocusId, setPendingCardFocusId] = useState<string | null>(null);
  const [pendingTodoFocus, setPendingTodoFocus] = useState<{
    itemId: string;
    entryId: string | null;
    caret?: number;
  } | null>(null);
  const [todoLink, setTodoLink] = useState<{
    itemId: string;
    /** "" is the card's first to-do; null puts the link in a new to-do. */
    entryId: string | null;
    start: number;
    end: number;
    text: string;
    url: string;
    editing: boolean;
    removable: boolean;
  } | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [shapeOpen, setShapeOpen] = useState(false);
  const [shapeTool, setShapeTool] = useState<WhiteboardShape | null>(null);
  const [pen, setPen] = useState(false);
  const [penColor, setPenColor] = useState("#9c9fe1");
  const [penWidth, setPenWidth] = useState(4);
  const [draftShape, setDraftShape] = useState<{ shape: WhiteboardShape; start: Point; end: Point } | null>(null);
  const shapeRef = useRef<{ shape: WhiteboardShape; start: Point; end: Point } | null>(null);
  const [draftStroke, setDraftStroke] = useState<WhiteboardStroke | null>(null);
  const strokeRef = useRef<WhiteboardStroke | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const canvasPointer = useRef<number | null>(null);
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => () => cleanupDrag.current?.(), []);
  useEffect(() => {
    historyRef.current.clear();
    setPendingCardFocusId(null);
  }, [path]);
  useEffect(() => {
    if (!pendingTodoFocus) return;
    const card = stage.current?.querySelector<HTMLElement>(
      `[data-whiteboard-id="${escapeAttr(pendingTodoFocus.itemId)}"]`,
    );
    const input = card?.querySelector<HTMLTextAreaElement>(
      `.whiteboard-todo-input[data-todo-entry="${escapeAttr(pendingTodoFocus.entryId ?? "")}"]`,
    );
    input?.focus();
    if (input && pendingTodoFocus.caret !== undefined) {
      input.setSelectionRange(pendingTodoFocus.caret, pendingTodoFocus.caret);
    }
    setPendingTodoFocus(null);
  }, [board.items, pendingTodoFocus]);
  useEffect(() => {
    if (!shapeTool) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShapeTool(null);
        setShapeOpen(false);
        if (shapeRef.current) {
          shapeRef.current = null;
          setDraftShape(null);
          canvasPointer.current = null;
        }
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [shapeTool]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    // Alt + wheel slides the canvas sideways. A wheel moves in coarse steps, so
    // each one is eased over a few frames the way ordinary scrolling is.
    let glideTo: number | null = null;
    let glideFrame = 0;
    // On Windows, letting go of Alt on its own hands the keyboard to the window
    // menu. After Alt was only held to scroll, that release should do nothing.
    let altPanned = false;
    const altReleased = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      if (altPanned) event.preventDefault();
      altPanned = false;
    };
    const stopGlide = () => {
      if (glideFrame) window.cancelAnimationFrame(glideFrame);
      glideFrame = 0;
      glideTo = null;
    };
    const glide = () => {
      glideFrame = 0;
      if (glideTo === null) return;
      const before = element.scrollLeft;
      const remaining = glideTo - before;
      if (Math.abs(remaining) <= 1) {
        element.scrollLeft = glideTo;
        glideTo = null;
        return;
      }
      element.scrollLeft = before + Math.sign(remaining) * Math.max(1, Math.abs(remaining) * 0.3);
      // Nothing moved: the canvas is already against its edge.
      if (element.scrollLeft === before) {
        glideTo = null;
        return;
      }
      glideFrame = window.requestAnimationFrame(glide);
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoom(Math.max(0.4, Math.min(2, zoomRef.current * (event.deltaY < 0 ? 1.12 : 1 / 1.12))));
        return;
      }
      if (!event.altKey) return;
      const distance = sidewaysWheelDistance(event, element.clientWidth);
      if (!distance) return;
      // Also keeps a text box or list under the pointer from scrolling instead.
      event.preventDefault();
      altPanned = true;
      const furthest = Math.max(0, element.scrollWidth - element.clientWidth);
      const target = Math.max(0, Math.min(furthest, (glideTo ?? element.scrollLeft) + distance));
      // A trackpad already sends a stream of small steps; easing those only adds lag.
      const instant =
        Math.abs(distance) < 40 ||
        typeof window.requestAnimationFrame !== "function" ||
        !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (instant) {
        stopGlide();
        element.scrollLeft = target;
        return;
      }
      glideTo = target;
      if (!glideFrame) glideFrame = window.requestAnimationFrame(glide);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    // Grabbing the canvas takes over from a glide that is still settling.
    element.addEventListener("pointerdown", stopGlide);
    window.addEventListener("keyup", altReleased);
    return () => {
      stopGlide();
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("pointerdown", stopGlide);
      window.removeEventListener("keyup", altReleased);
    };
  }, []);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    return trackConnectorDots(element, ".whiteboard-item", {
      // A shape's controls float just above it, where a dot on the top edge would cover them.
      sides: (card) =>
        card.classList.contains("whiteboard-shape") ? ["right", "bottom", "left"] : undefined,
    });
  }, []);

  const commit = (next: WhiteboardDocument, coalesceKey = "", skipHistory = false) => {
    const previous = latest.current;
    if (!onChange(next)) {
      setError("This change exceeds the board's save limit. Your previous content is intact.");
      return false;
    }
    if (!skipHistory && previous !== next) historyRef.current.record(previous, coalesceKey);
    latest.current = next;
    setError("");
    return true;
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (clearOpen) return;
      const action = undoRedoKey(event);
      if (!action) return;
      // Let ProseMirror handle undo/redo while actively typing inside a rich-text whiteboard box.
      if (event.target instanceof Element && event.target.closest(".ProseMirror")) {
        return;
      }
      if (
        isStandaloneTextInput(event.target) &&
        !(event.target instanceof Element && event.target.closest(".whiteboard-stage"))
      ) {
        return;
      }
      if (action === "undo") {
        const previous = historyRef.current.undo(latest.current);
        if (!previous) return;
        if (!onChange(previous)) {
          historyRef.current.redo(previous);
          return;
        }
        latest.current = previous;
        setError("");
        event.preventDefault();
        event.stopPropagation();
      } else {
        const next = historyRef.current.redo(latest.current);
        if (!next) return;
        if (!onChange(next)) {
          historyRef.current.undo(next);
          return;
        }
        latest.current = next;
        setError("");
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearOpen, onChange]);

  const point = (item: WhiteboardItem) => positions[item.id] ?? { x: item.x, y: item.y };
  const size = (item: WhiteboardItem) => sizes[item.id] ?? { width: item.width, height: item.height };
  const rect = (item: WhiteboardItem) => ({ ...point(item), ...size(item) });
  const dimensions = board.items.reduce(
    (space, item) => ({
      width: Math.max(space.width, point(item).x + size(item).width + 180),
      height: Math.max(space.height, point(item).y + size(item).height + 170),
    }),
    { width: 1800, height: 1100 },
  );
  for (const stroke of board.strokes) {
    for (const p of stroke.points) {
      dimensions.width = Math.max(dimensions.width, p.x + 100);
      dimensions.height = Math.max(dimensions.height, p.y + 100);
    }
  }

  const currentViewport = (): WhiteboardViewport => {
    const el = stage.current;
    const scale = zoomRef.current || 1;
    const viewW = (el?.clientWidth && el.clientWidth > 0 ? el.clientWidth : 860) / scale;
    const viewH = (el?.clientHeight && el.clientHeight > 0 ? el.clientHeight : 540) / scale;
    return {
      x: (el?.scrollLeft ?? 0) / scale,
      y: (el?.scrollTop ?? 0) / scale,
      width: viewW,
      height: viewH,
    };
  };

  const add = (
    type: WhiteboardItemType,
    image = "",
    shape: WhiteboardShape = "rectangle",
    initialLinks: WhiteboardLinkEntry[] = [],
  ) => {
    setPen(false);
    setShapeOpen(false);
    setShapeTool(null);
    const prototype = newWhiteboardItem(type, 0, 0, image, shape);
    const spot = findOpenWhiteboardSpot(
      latest.current.items,
      { width: prototype.width, height: prototype.height },
      currentViewport(),
    );
    const created: WhiteboardItem = {
      ...prototype,
      x: spot.x,
      y: spot.y,
      links: initialLinks,
    };
    const nextItems = [...latest.current.items, created];
    if (commit({ ...latest.current, items: nextItems })) {
      bringToFront(created.id, nextItems);
      if (type === "text" || type === "link") {
        setPendingCardFocusId(created.id);
      }
    }
  };

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (clearOpen) return;
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest("input, textarea, select, [contenteditable='true'], .ProseMirror"))
      ) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const urls = extractLinksFromText(text);
      if (!urls.length) return;
      event.preventDefault();
      add(
        "link",
        "",
        "rectangle",
        urls.map((url) => newWhiteboardLink(url, true)),
      );
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [clearOpen]);

  const update = (id: string, patch: Partial<WhiteboardItem>, coalesceKey = "") =>
    commit(
      {
        ...latest.current,
        items: latest.current.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      },
      coalesceKey,
    );

  const insertTodoEntry = (item: WhiteboardItem, afterIndex: number) => {
    const entry = newWhiteboardTodo("");
    const currentTodos = item.todos ?? [];
    const nextTodos = [...currentTodos];
    const insertAt = clampRange(afterIndex, 0, nextTodos.length);
    nextTodos.splice(insertAt, 0, entry);
    // The card keeps the size it was given; a list that outgrows it scrolls,
    // the same way a Links card does.
    if (update(item.id, { todos: nextTodos })) {
      setPendingTodoFocus({ itemId: item.id, entryId: entry.id });
    }
  };
  const updateTodoEntry = (
    item: WhiteboardItem,
    entryId: string,
    patch: { text?: string; done?: boolean },
    coalesceKey = "",
  ) => {
    const nextTodos = (item.todos ?? []).map((entry) =>
      entry.id === entryId ? { ...entry, ...patch } : entry,
    );
    update(item.id, { todos: nextTodos }, coalesceKey);
  };
  const removeTodoEntry = (item: WhiteboardItem, entryId: string | null, focusPreviousIndex?: number) => {
    const currentTodos = item.todos ?? [];
    if (entryId === null) {
      if (currentTodos.length === 0) return;
      const [first, ...rest] = currentTodos;
      update(item.id, { text: first.text, done: first.done, todos: rest });
      return;
    }
    const nextTodos = currentTodos.filter((entry) => entry.id !== entryId);
    if (update(item.id, { todos: nextTodos }) && focusPreviousIndex !== undefined) {
      const prevEntry = focusPreviousIndex > 0 ? currentTodos[focusPreviousIndex - 1] : null;
      setPendingTodoFocus({ itemId: item.id, entryId: prevEntry ? prevEntry.id : null });
    }
  };

  const todoText = (item: WhiteboardItem, entryId: string) =>
    entryId ? item.todos?.find((entry) => entry.id === entryId)?.text : item.text;

  // The button keeps focus where it was, so the to-do being edited (and what is
  // selected in it) is still known here.
  const openTodoLink = (itemId: string) => {
    const item = latest.current.items.find((other) => other.id === itemId);
    if (!item) return;
    const focused = document.activeElement;
    if (
      focused instanceof HTMLTextAreaElement &&
      focused.classList.contains("whiteboard-todo-input") &&
      focused.closest<HTMLElement>("[data-whiteboard-id]")?.dataset.whiteboardId === itemId
    ) {
      const entryId = focused.dataset.todoEntry ?? "";
      const value = todoText(item, entryId);
      if (value !== undefined) {
        const start = Math.min(focused.selectionStart, value.length);
        const end = Math.min(focused.selectionEnd, value.length);
        const existing = inlineLinkAt(value, start, end);
        setTodoLink(
          existing
            ? {
                itemId,
                entryId,
                start: existing.start,
                end: existing.end,
                text: existing.markdown ? existing.text : "",
                url: existing.href,
                editing: true,
                removable: existing.markdown,
              }
            : { itemId, entryId, start, end, text: value.slice(start, end), url: "", editing: false, removable: false },
        );
        return;
      }
    }
    setTodoLink({ itemId, entryId: null, start: 0, end: 0, text: "", url: "", editing: false, removable: false });
  };
  const writeTodoText = (item: WhiteboardItem, entryId: string, text: string) =>
    entryId
      ? update(item.id, {
          todos: (item.todos ?? []).map((entry) => (entry.id === entryId ? { ...entry, text } : entry)),
        })
      : update(item.id, { text });
  const applyTodoLink = (link: { text: string; href: string } | null): string | void => {
    const request = todoLink;
    const item = request && latest.current.items.find((other) => other.id === request.itemId);
    if (!request || !item) return setTodoLink(null);
    const tooLong = "That link doesn't fit: a to-do holds up to 2,000 characters.";

    if (request.entryId === null) {
      if (!link) return setTodoLink(null);
      const fresh = insertInlineLink("", 0, 0, link.text, link.href);
      if (fresh.text.length > 2000) return tooLong;
      // An untouched card has one empty to-do waiting; use it before adding another.
      if (!item.text && !(item.todos ?? []).length) {
        if (!update(item.id, { text: fresh.text })) return tooLong;
        setPendingTodoFocus({ itemId: item.id, entryId: null, caret: fresh.caret });
      } else {
        const entry = newWhiteboardTodo(fresh.text);
        if (!update(item.id, { todos: [...(item.todos ?? []), entry] })) return "This card can't hold another to-do.";
        setPendingTodoFocus({ itemId: item.id, entryId: entry.id, caret: fresh.caret });
      }
      return setTodoLink(null);
    }

    const value = todoText(item, request.entryId);
    if (value === undefined) return setTodoLink(null);
    let next: { text: string; caret: number };
    if (link) {
      next = insertInlineLink(value, request.start, request.end, link.text, link.href);
    } else {
      const existing = inlineLinkAt(value, request.start, request.end);
      if (!existing) return setTodoLink(null);
      next = removeInlineLink(value, existing);
    }
    if (next.text.length > 2000 || !writeTodoText(item, request.entryId, next.text)) return tooLong;
    setPendingTodoFocus({ itemId: item.id, entryId: request.entryId || null, caret: next.caret });
    setTodoLink(null);
  };
  const cancelTodoLink = () => {
    const request = todoLink;
    setTodoLink(null);
    // Back to the to-do that was being edited, with its selection as it was.
    if (request && request.entryId !== null) {
      setPendingTodoFocus({ itemId: request.itemId, entryId: request.entryId || null, caret: request.end });
    }
  };

  const move = (event: ReactPointerEvent, item: WhiteboardItem) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupDrag.current?.();
    const id = event.pointerId;
    const sx = event.clientX;
    const sy = event.clientY;
    const scale =
      (stage.current?.offsetWidth
        ? stage.current.getBoundingClientRect().width / stage.current.offsetWidth || 1
        : 1) * zoomRef.current;
    let next = { x: item.x, y: item.y };
    let moved = false;
    const moving = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < 3 && !moved) return;
      moved = true;
      next = {
        x: clamp(item.x + (e.clientX - sx) / scale),
        y: clamp(item.y + (e.clientY - sy) / scale),
      };
      setPositions({ [item.id]: next });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", moving);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      cleanupDrag.current = null;
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      cleanup();
      if (moved) update(item.id, next);
      setPositions({});
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === id) {
        cleanup();
        setPositions({});
      }
    };
    cleanupDrag.current = cleanup;
    window.addEventListener("pointermove", moving);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
  };

  const resize = (event: ReactPointerEvent, item: WhiteboardItem, corner: ResizeCorner = "se") => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupDrag.current?.();
    const id = event.pointerId;
    const sx = event.clientX;
    const sy = event.clientY;
    const scale =
      (stage.current?.offsetWidth
        ? stage.current.getBoundingClientRect().width / stage.current.offsetWidth || 1
        : 1) * zoomRef.current;
    let next = { x: item.x, y: item.y, width: item.width, height: item.height };
    let moved = false;
    const moving = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      moved = true;
      next = resizeWhiteboardItem(item, corner, (e.clientX - sx) / scale, (e.clientY - sy) / scale);
      setPositions({ [item.id]: { x: next.x, y: next.y } });
      setSizes({ [item.id]: { width: next.width, height: next.height } });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", moving);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      cleanupDrag.current = null;
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      cleanup();
      if (moved) update(item.id, next);
      setPositions({});
      setSizes({});
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === id) {
        cleanup();
        setPositions({});
        setSizes({});
      }
    };
    cleanupDrag.current = cleanup;
    window.addEventListener("pointermove", moving);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
  };

  const canvasPoint = (clientX: number, clientY: number): Point => {
    const surface = stage.current;
    if (!surface) return { x: 0, y: 0 };
    const r = surface.getBoundingClientRect();
    const scale = surface.offsetWidth ? r.width / surface.offsetWidth || 1 : 1;
    return {
      x: clamp(((clientX - r.left) / scale + surface.scrollLeft) / zoomRef.current),
      y: clamp(((clientY - r.top) / scale + surface.scrollTop) / zoomRef.current),
    };
  };

  const connect = (event: ReactPointerEvent, item: WhiteboardItem) => {
    if (event.button !== 0 || !stage.current) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupDrag.current?.();
    const id = event.pointerId;
    // The dot can be anywhere round the card now, so the line starts under the pointer.
    setDrawing({ from: item.id, end: canvasPoint(event.clientX, event.clientY) });
    const moving = (e: PointerEvent) => {
      if (e.pointerId === id) setDrawing({ from: item.id, end: canvasPoint(e.clientX, e.clientY) });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", moving);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      setDrawing(null);
      cleanupDrag.current = null;
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>("[data-whiteboard-id]")?.dataset.whiteboardId;
      cleanup();
      const current = latest.current;
      if (
        target &&
        target !== item.id &&
        current.items.some((other) => other.id === target) &&
        !current.connections.some((edge) => edge.from === item.id && edge.to === target)
      ) {
        commit({
          ...current,
          connections: [...current.connections, { from: item.id, to: target, color: TODO_CONNECTION_COLOR }],
        });
      }
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === id) cleanup();
    };
    cleanupDrag.current = cleanup;
    window.addEventListener("pointermove", moving);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
  };

  const byId = new Map(board.items.map((item) => [item.id, item]));
  const upload = (chosen: File | undefined) => {
    if (!chosen) return;
    if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(chosen.type) || chosen.size > 2 * 1024 * 1024) {
      setError("Choose a PNG, JPEG, GIF or WebP image up to 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") add("image", reader.result);
    };
    reader.onerror = () => setError("Couldn't read that image.");
    reader.readAsDataURL(chosen);
  };

  const finishCanvas = (cancelled = false) => {
    canvasPointer.current = null;
    pan.current = null;
    const stroke = strokeRef.current;
    const shape = shapeRef.current;
    strokeRef.current = null;
    shapeRef.current = null;
    setDraftStroke(null);
    setDraftShape(null);
    if (cancelled) return;
    if (stroke) commit({ ...latest.current, strokes: [...latest.current.strokes, stroke] });
    if (shape) {
      const bounds = shapeBounds(shape.start, shape.end);
      const item = {
        ...newWhiteboardItem("shape", bounds.x, bounds.y, "", shape.shape),
        width: bounds.width,
        height: bounds.height,
      };
      const nextItems = [...latest.current.items, item];
      if (commit({ ...latest.current, items: nextItems })) {
        bringToFront(item.id, nextItems);
        setShapeTool(null);
      }
    }
  };

  return (
    <section className="todo-board whiteboard" aria-labelledby="whiteboard-title">
      <div className="todo-header">
        <div className="explore-heading-icon">
          <Square size={20} />
        </div>
        <div>
          <span className="section-eyebrow">YOUR WHITEBOARD</span>
          <h2 id="whiteboard-title">
            <button type="button" className="rename-title" title="Click to rename" onClick={onRename}>
              {name}
              <Pencil size={13} />
            </button>
          </h2>
          <p>A canvas for your ideas.</p>
        </div>
        <span className="todo-header-spacer" />
        <div className={`save-indicator ${saveState}`} role="status">
          {saveState === "saving" ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}
          <span>
            {saveState === "error"
              ? "Save failed"
              : saveState === "saving"
                ? "Saving…"
                : saveState === "unsaved"
                  ? "Unsaved changes"
                  : "Saved"}
          </span>
          {saveState === "error" && (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      </div>

      <div className="whiteboard-toolbar">
        <button type="button" onClick={() => add("text")}>
          <Type size={16} /> Text
        </button>
        <button type="button" onClick={() => add("todo")}>
          <ListChecks size={16} /> To-do
        </button>
        <button type="button" onClick={() => add("link")}>
          <Link2 size={16} /> Link
        </button>
        <div className="whiteboard-shape-menu">
          <button
            type="button"
            className={shapeTool ? "active" : ""}
            aria-pressed={!!shapeTool}
            aria-expanded={shapeOpen}
            aria-haspopup="menu"
            onClick={() => setShapeOpen((value) => !value)}
          >
            <Square size={16} /> Shape <ChevronDown size={13} />
          </button>
          {shapeOpen && (
            <div className="whiteboard-shape-options" role="menu" aria-label="Add a shape">
              {SHAPES.map(({ value, label, icon: Icon }) => (
                <button
                  role="menuitem"
                  type="button"
                  key={value}
                  onClick={() => {
                    setShapeTool(value);
                    setPen(false);
                    setShapeOpen(false);
                  }}
                >
                  <Icon size={15} /> {label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" onClick={() => file.current?.click()}>
          <ImagePlus size={16} /> Image
        </button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(event) => {
            upload(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          className={pen ? "active" : ""}
          aria-pressed={pen}
          title="Draw on the canvas"
          onClick={() => {
            setPen((value) => !value);
            setShapeOpen(false);
            setShapeTool(null);
          }}
        >
          <Pencil size={16} /> Pen
        </button>
        {shapeTool && (
          <span className="whiteboard-shape-hint" role="status">
            Drag on a blank area to draw{" "}
            <button type="button" onClick={() => setShapeTool(null)}>
              Cancel
            </button>
          </span>
        )}
        {pen && (
          <>
            <ColorMenu color={penColor} label="Pen color" onChange={setPenColor} />
            <label className="whiteboard-pen-width">
              Pen size{" "}
              <AppSelect label="Pen size" value={penWidth} onChange={(value) => setPenWidth(Number(value))}>
                <option value="2">Fine</option>
                <option value="4">Medium</option>
                <option value="8">Thick</option>
              </AppSelect>
            </label>
          </>
        )}
        <button
          type="button"
          aria-label="Remove last pen stroke"
          title="Remove last pen stroke"
          disabled={!board.strokes.length}
          onClick={() => commit({ ...latest.current, strokes: latest.current.strokes.slice(0, -1) })}
        >
          <RotateCcw size={15} />
        </button>
        <button
          type="button"
          className="board-clear-button"
          disabled={!board.items.length && !board.connections.length && !board.strokes.length}
          onClick={() => setClearOpen(true)}
          title="Clear whiteboard contents"
        >
          <Trash2 size={15} /> Clear board
        </button>
        <span className="todo-header-spacer" />
        <button
          type="button"
          aria-label="Zoom whiteboard out"
          onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}
        >
          <Minus size={15} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label="Zoom whiteboard in"
          onClick={() => setZoom((z) => Math.min(2, z + 0.1))}
        >
          <Plus size={15} />
        </button>
      </div>

      {clearOpen && (
        <ClearBoardDialog
          kind="whiteboard"
          onCancel={() => setClearOpen(false)}
          onConfirm={() => {
            if (!commit({ ...latest.current, items: [], connections: [], strokes: [] }, "", true)) {
              return false;
            }
            historyRef.current.clear();
            cleanupDrag.current?.();
            setLayers([]);
            setPositions({});
            setSizes({});
            setSelected("");
            setDeleting("");
            setDrawing(null);
            shapeRef.current = null;
            strokeRef.current = null;
            canvasPointer.current = null;
            pan.current = null;
            setDraftShape(null);
            setDraftStroke(null);
            setShapeOpen(false);
            setShapeTool(null);
            setPen(false);
            return true;
          }}
        />
      )}
      {todoLink && (
        <LinkDialog
          initialText={todoLink.text}
          initialUrl={todoLink.url}
          showText
          editing={todoLink.editing}
          onCancel={cancelTodoLink}
          onRemove={todoLink.removable ? () => void applyTodoLink(null) : undefined}
          onSubmit={applyTodoLink}
        />
      )}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}

      <div
        className={`todo-canvas whiteboard-stage${pen || shapeTool ? " pen-mode" : ""}`}
        ref={stage}
        aria-label="Whiteboard canvas"
        onDragOver={(event) => {
          if (droppedBrowserLink(event.dataTransfer)) {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          const url = droppedBrowserLink(event.dataTransfer);
          if (!url) return;
          event.preventDefault();
          event.stopPropagation();
          add("link", "", "rectangle", [newWhiteboardLink(url, true)]);
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target as Element).closest(
              "button,input,textarea,.whiteboard-item,.todo-link-hit,.todo-link-controls",
            )
          ) {
            return;
          }
          setSelected("");
          setShapeOpen(false);
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          window.getSelection()?.removeAllRanges();
          const el = event.currentTarget;
          if (canvasPointer.current !== null) return;
          canvasPointer.current = event.pointerId;
          el.setPointerCapture(event.pointerId);
          event.preventDefault();
          if (pen) {
            const stroke = {
              id: todoId(),
              color: penColor,
              width: penWidth,
              points: [canvasPoint(event.clientX, event.clientY)],
            };
            strokeRef.current = stroke;
            setDraftStroke(stroke);
          } else if (shapeTool) {
            const start = canvasPoint(event.clientX, event.clientY);
            const draft = { shape: shapeTool, start, end: start };
            shapeRef.current = draft;
            setDraftShape(draft);
          } else {
            pan.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: el.scrollLeft,
              top: el.scrollTop,
            };
          }
        }}
        onPointerMove={(event) => {
          if (canvasPointer.current !== event.pointerId) return;
          const shape = shapeRef.current;
          if (shape) {
            const next = { ...shape, end: canvasPoint(event.clientX, event.clientY) };
            shapeRef.current = next;
            setDraftShape(next);
            return;
          }
          const stroke = strokeRef.current;
          if (stroke) {
            const next = canvasPoint(event.clientX, event.clientY);
            const last = stroke.points[stroke.points.length - 1];
            if (stroke.points.length < 5000 && Math.hypot(next.x - last.x, next.y - last.y) >= 2) {
              const updated = { ...stroke, points: [...stroke.points, next] };
              strokeRef.current = updated;
              setDraftStroke(updated);
            }
            return;
          }
          const drag = pan.current;
          if (!drag || drag.id !== event.pointerId) return;
          const scale = event.currentTarget.offsetWidth
            ? event.currentTarget.getBoundingClientRect().width / event.currentTarget.offsetWidth || 1
            : 1;
          event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x) / scale;
          event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y) / scale;
        }}
        onPointerUp={(event) => {
          if (canvasPointer.current === event.pointerId) {
            if (shapeRef.current) {
              shapeRef.current = { ...shapeRef.current, end: canvasPoint(event.clientX, event.clientY) };
            }
            finishCanvas();
          }
        }}
        onPointerCancel={(event) => {
          if (canvasPointer.current === event.pointerId) finishCanvas(true);
        }}
      >
        <div
          className="todo-canvas-size"
          style={{ width: dimensions.width * zoom, height: dimensions.height * zoom }}
        >
          <div
            className="todo-canvas-inner"
            style={{
              width: dimensions.width,
              height: dimensions.height,
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
            }}
          >
            <svg
              className="todo-connections-svg"
              width={dimensions.width}
              height={dimensions.height}
              aria-label="Whiteboard connections and drawing"
            >
              {[...board.strokes, ...(draftStroke ? [draftStroke] : [])].map((stroke) => (
                <path
                  key={stroke.id}
                  d={strokePath(stroke.points)}
                  fill="none"
                  stroke={stroke.color}
                  strokeWidth={stroke.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {board.connections.map((edge) => {
                const from = byId.get(edge.from);
                const to = byId.get(edge.to);
                if (!from || !to) return null;
                const d = connectionGeometry(rect(from), rect(to)).path;
                const key = JSON.stringify([edge.from, edge.to]);
                return (
                  <g className={selected === key ? "selected" : ""} key={key}>
                    <path d={d} className="todo-link-selection" />
                    <path
                      d={d}
                      className="todo-link-hit"
                      role="button"
                      tabIndex={0}
                      aria-label="Select whiteboard connection"
                      onClick={() => setSelected(key)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(key);
                        }
                      }}
                    />
                    <path d={d} className="todo-link-line" style={{ stroke: edge.color }} />
                  </g>
                );
              })}
              {drawing && byId.has(drawing.from) && (
                <path
                  className="todo-link-preview"
                  d={connectionGeometry(rect(byId.get(drawing.from)!), { ...drawing.end, width: 0, height: 0 }).path}
                />
              )}
            </svg>

            {board.connections.map((edge) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              const key = JSON.stringify([edge.from, edge.to]);
              if (!from || !to || key !== selected) return null;
              const { from: a, to: b } = connectionGeometry(rect(from), rect(to));
              return (
                <div
                  className="todo-link-controls"
                  key={key}
                  style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 }}
                >
                  <ColorMenu
                    color={edge.color}
                    label="Connection color"
                    onChange={(color) =>
                      commit({
                        ...latest.current,
                        connections: latest.current.connections.map((item) =>
                          item.from === edge.from && item.to === edge.to ? { ...item, color } : item,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="todo-link-remove"
                    aria-label="Remove whiteboard connection"
                    onClick={() => {
                      commit({
                        ...latest.current,
                        connections: latest.current.connections.filter(
                          (item) => item.from !== edge.from || item.to !== edge.to,
                        ),
                      });
                      setSelected("");
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}

            {draftShape &&
              (() => {
                const bounds = shapeBounds(draftShape.start, draftShape.end);
                return (
                  <svg
                    className="whiteboard-shape-preview"
                    style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <ShapeOutline shape={draftShape.shape} />
                  </svg>
                );
              })()}

            {board.items.map((item) => {
              const p = point(item);
              const itemSize = size(item);
              const layer = layers.indexOf(item.id);
              const extraTodos = item.todos ?? [];
              const isRenamableWindow =
                item.type === "text" || item.type === "todo" || item.type === "link";
              const defaultWindowTitle =
                item.type === "todo" ? "To-do" : item.type === "link" ? "Links" : "Text";
              const titleAriaLabel =
                item.type === "todo"
                  ? "To-do card title"
                  : item.type === "link"
                    ? "Link card title"
                    : "Text card title";

              return (
                <article
                  className={`whiteboard-item whiteboard-${item.type}${item.type === "shape" && item.filled ? " is-filled" : ""}`}
                  data-whiteboard-id={item.id}
                  key={item.id}
                  onPointerDownCapture={(event) => {
                    if (event.button === 0) bringToFront(item.id);
                  }}
                  onFocusCapture={() => bringToFront(item.id)}
                  style={
                    {
                      left: p.x,
                      top: p.y,
                      width: itemSize.width,
                      height: itemSize.height,
                      zIndex: layer < 0 ? (item.type === "shape" ? 1 : 2) : layer + 3,
                      "--item-color": item.color,
                    } as CSSProperties
                  }
                >
                  <div
                    className={`whiteboard-item-header${deleting === item.id ? " is-deleting" : ""}`}
                    title="Drag to move"
                    onPointerDown={(event) => {
                      if (!(event.target as Element).closest("button,input,select")) move(event, item);
                    }}
                  >
                    <button
                      type="button"
                      title="Drag to move"
                      aria-label={`Drag ${item.type}`}
                      onPointerDown={(event) => move(event, item)}
                    >
                      <GripVertical size={15} />
                    </button>

                    {isRenamableWindow ? (
                      <>
                        <span
                          className="whiteboard-title-wrap"
                          data-sizer={item.title || defaultWindowTitle}
                        >
                          <input
                            type="text"
                            className="whiteboard-title-input"
                            aria-label={titleAriaLabel}
                            maxLength={120}
                            placeholder={defaultWindowTitle}
                            value={item.title ?? ""}
                            onChange={(event) =>
                              update(item.id, { title: event.target.value }, `title:${item.id}`)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                          />
                        </span>
                        <span className="whiteboard-header-spacer" />
                      </>
                    ) : (
                      <span>{item.type === "shape" ? item.shape.toUpperCase() : item.type.toUpperCase()}</span>
                    )}

                    <ColorMenu
                      color={item.color}
                      label={`Color ${item.type}`}
                      onChange={(color) => update(item.id, { color })}
                    />
                    {item.type === "shape" && (
                      <button
                        type="button"
                        aria-label={item.filled ? "Remove shape fill" : "Fill shape"}
                        title={item.filled ? "Remove fill" : "Fill shape"}
                        aria-pressed={!!item.filled}
                        onClick={() => update(item.id, { filled: !item.filled })}
                      >
                        <PaintBucket size={15} />
                      </button>
                    )}
                    {deleting === item.id ? (
                      <>
                        <button
                          type="button"
                          className="whiteboard-delete-confirm"
                          onClick={() => {
                            commit({
                              ...latest.current,
                              items: latest.current.items.filter((other) => other.id !== item.id),
                              connections: latest.current.connections.filter(
                                (edge) => edge.from !== item.id && edge.to !== item.id,
                              ),
                            });
                            setDeleting("");
                          }}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel deleting item"
                          onClick={() => setDeleting("")}
                        >
                          <X size={14} />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${item.type}`}
                        onClick={() => setDeleting(item.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>

                  {item.type === "image" ? (
                    <img src={item.image} alt={item.text || "Whiteboard image"} />
                  ) : item.type === "todo" ? (
                    <div className="whiteboard-item-content whiteboard-todo-body">
                      <div className="whiteboard-todo-list">
                        <div className="whiteboard-todo-row">
                          <input
                            type="checkbox"
                            checked={item.done}
                            aria-label="Complete whiteboard to-do"
                            onChange={(event) => update(item.id, { done: event.target.checked })}
                          />
                          <WhiteboardTodoText
                            value={item.text}
                            done={item.done}
                            entryId=""
                            ariaLabel="To-do text"
                            maxLength={2000}
                            placeholder="Something to do…"
                            onChange={(text) => update(item.id, { text }, `todo:${item.id}:0`)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                insertTodoEntry(item, 0);
                              }
                            }}
                          />
                          {extraTodos.length > 0 && (
                            <button
                              type="button"
                              className="whiteboard-todo-remove"
                              aria-label="Remove to-do item"
                              onClick={() => removeTodoEntry(item, null)}
                            >
                              <X size={13} />
                            </button>
                          )}
                        </div>
                        {extraTodos.map((entry, idx) => (
                          <div key={entry.id} className="whiteboard-todo-row">
                            <input
                              type="checkbox"
                              checked={entry.done}
                              aria-label={`Complete to-do item ${idx + 2}`}
                              onChange={(event) =>
                                updateTodoEntry(item, entry.id, { done: event.target.checked })
                              }
                            />
                            <WhiteboardTodoText
                              value={entry.text}
                              done={entry.done}
                              entryId={entry.id}
                              ariaLabel={`To-do item ${idx + 2} text`}
                              maxLength={2000}
                              placeholder="Something to do…"
                              onChange={(text) =>
                                updateTodoEntry(item, entry.id, { text }, `todo:${item.id}:${entry.id}`)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  insertTodoEntry(item, idx + 1);
                                } else if (event.key === "Backspace" && !entry.text) {
                                  event.preventDefault();
                                  removeTodoEntry(item, entry.id, idx);
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="whiteboard-todo-remove"
                              aria-label={`Remove to-do item ${idx + 2}`}
                              onClick={() => removeTodoEntry(item, entry.id)}
                            >
                              <X size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="whiteboard-todo-actions">
                        <button
                          type="button"
                          className="whiteboard-todo-add"
                          aria-label="Add to-do item"
                          onClick={() => insertTodoEntry(item, extraTodos.length)}
                        >
                          <Plus size={14} /> Add item
                        </button>
                        <button
                          type="button"
                          className="whiteboard-todo-add whiteboard-todo-link"
                          aria-label="Add link to to-do"
                          title="Link the selected words, or add a link"
                          // Keeps the to-do being edited focused, so its selection is still there on click.
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => openTodoLink(item.id)}
                        >
                          <Link2 size={13} /> Link
                        </button>
                      </div>
                    </div>
                  ) : item.type === "link" ? (
                    <WhiteboardLinkBody
                      item={item}
                      autoFocus={pendingCardFocusId === item.id}
                      onAutoFocused={() => setPendingCardFocusId(null)}
                      onUpdateLinks={(nextLinks) =>
                        update(item.id, {
                          links: nextLinks,
                        })
                      }
                    />
                  ) : item.type === "text" ? (
                    <div className="whiteboard-item-content whiteboard-text-body">
                      <WhiteboardRichText
                        boardPath={path}
                        itemId={item.id}
                        text={item.text}
                        autoFocus={pendingCardFocusId === item.id}
                        onAutoFocused={() => setPendingCardFocusId(null)}
                        onChange={(nextText) => update(item.id, { text: nextText }, `text:${item.id}`)}
                      />
                    </div>
                  ) : (
                    <div className="whiteboard-item-content shape-content">
                      <svg
                        className="whiteboard-shape-visual"
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <ShapeOutline shape={item.shape} />
                      </svg>
                      <textarea
                        aria-label="Shape text"
                        maxLength={10000}
                        placeholder=""
                        value={item.text}
                        onChange={(event) => update(item.id, { text: event.target.value }, `text:${item.id}`)}
                      />
                    </div>
                  )}

                  <button
                    type="button"
                    className="todo-connect-dot"
                    title="Drag to connect"
                    aria-label={`Connect ${item.type} to another item`}
                    onPointerDown={(event) => connect(event, item)}
                  />
                  {RESIZE_CORNERS.map(({ corner, labelSuffix }) => (
                    <button
                      key={corner}
                      type="button"
                      className={`whiteboard-resize is-${corner}`}
                      title="Drag to resize"
                      aria-label={`Resize ${item.type}${labelSuffix}`}
                      onPointerDown={(event) => resize(event, item, corner)}
                      onKeyDown={(event) => {
                        const delta = event.shiftKey ? 20 : 5;
                        const dx =
                          event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0;
                        const dy =
                          event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0;
                        if (dx || dy) {
                          event.preventDefault();
                          update(item.id, resizeWhiteboardItem(item, corner, dx, dy));
                        }
                      }}
                    />
                  ))}
                </article>
              );
            })}

            {!board.items.length && !board.strokes.length && (
              <div className="todo-canvas-empty">
                <Square size={26} />
                <strong>A blank whiteboard</strong>
                <span>Add an item or choose the pen to draw.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
