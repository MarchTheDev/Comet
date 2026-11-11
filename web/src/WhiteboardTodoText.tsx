import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { insertInlineLink, parseInlineLinks } from "./utils/inlineLinks";
import { openExternalWebUrl } from "./utils/linkEmbeds";
import { safeWebUrl } from "./utils/links";

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** Which character of the saved text a click on the shown text lands on. */
function textOffsetAt(shown: HTMLElement, x: number, y: number, fallback: number): number {
  const doc = document as CaretDocument;
  let node: Node | null = null;
  let offset = 0;
  try {
    if (typeof doc.caretPositionFromPoint === "function") {
      const position = doc.caretPositionFromPoint(x, y);
      if (position) {
        node = position.offsetNode;
        offset = position.offset;
      }
    } else if (typeof doc.caretRangeFromPoint === "function") {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    }
  } catch {
    return fallback;
  }
  if (!node || !shown.contains(node)) return fallback;
  const isText = node.nodeType === 3;
  const element = isText ? node.parentElement : (node as Element);
  const piece = element?.closest<HTMLElement>("[data-text-start]");
  if (!piece || !shown.contains(piece)) return fallback;
  const start = Number(piece.dataset.textStart);
  if (!Number.isFinite(start)) return fallback;
  const length = piece.textContent?.length ?? 0;
  // A link's label is shorter than what is saved for it, so stay inside the label.
  return start + (isText ? Math.min(offset, length) : offset > 0 ? length : 0);
}

/**
 * The text of one whiteboard to-do.
 *
 * It wraps to the width of its card and grows downwards, and any link in it
 * can be opened. While it is being edited it is a plain text area showing
 * exactly what is saved; otherwise the same space shows the text with its
 * links live.
 *
 * Both are stacked in one grid cell. Whichever is taller sets the height, so
 * the text area needs no measuring to fit its contents.
 */
export function WhiteboardTodoText({
  value,
  done,
  entryId,
  ariaLabel,
  placeholder,
  maxLength,
  onChange,
  onKeyDown,
}: {
  value: string;
  done: boolean;
  /** Empty for a card's first to-do, which is saved on the card itself. */
  entryId: string;
  ariaLabel: string;
  placeholder: string;
  maxLength: number;
  onChange: (text: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const shown = useRef<HTMLDivElement>(null);
  const caretAfterChange = useRef<number | null>(null);

  useLayoutEffect(() => {
    const caret = caretAfterChange.current;
    if (caret === null) return;
    caretAfterChange.current = null;
    input.current?.setSelectionRange(caret, caret);
  }, [value]);

  const startEditing = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("a")) return;
    const field = input.current;
    if (!field) return;
    // Otherwise the press would move focus to the page and straight back out.
    event.preventDefault();
    const caret = shown.current
      ? textOffsetAt(shown.current, event.clientX, event.clientY, value.length)
      : value.length;
    field.focus({ preventScroll: true });
    field.setSelectionRange(caret, caret);
  };

  // Pasting an address over selected words links those words, as it does in a text box.
  const linkSelection = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    const from = field.selectionStart;
    const to = field.selectionEnd;
    if (from === to) return;
    const pasted = event.clipboardData.getData("text/plain").trim();
    if (!/^https?:\/\/\S+$/i.test(pasted)) return;
    const href = safeWebUrl(pasted);
    const selected = value.slice(from, to);
    if (!href || !selected.trim() || /[[\]]|https?:\/\/|www\./i.test(selected)) return;
    const next = insertInlineLink(value, from, to, selected, href);
    if (next.text.length > maxLength) return;
    event.preventDefault();
    caretAfterChange.current = next.caret;
    onChange(next.text);
  };

  const open = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    event.preventDefault();
    event.stopPropagation();
    openExternalWebUrl(href);
  };

  return (
    <div
      className={`whiteboard-todo-field${editing ? " is-editing" : ""}${done ? " is-done" : ""}`}
    >
      <div
        ref={shown}
        className={`whiteboard-todo-shown${!editing && !value ? " is-empty" : ""}`}
        onMouseDown={startEditing}
      >
        {editing
          ? // Sized by the saved text while editing. The zero-width space keeps an empty line open.
            `${value}\u200b`
          : value
            ? parseInlineLinks(value).map((segment) =>
                segment.kind === "link" ? (
                  <a
                    key={segment.start}
                    href={segment.href}
                    rel="noreferrer noopener"
                    title={`Open ${segment.href}`}
                    draggable={false}
                    data-text-start={segment.labelStart}
                    onClick={(event) => open(event, segment.href)}
                    onAuxClick={(event) => {
                      if (event.button === 1) open(event, segment.href);
                    }}
                  >
                    {segment.text}
                  </a>
                ) : (
                  <span key={segment.start} data-text-start={segment.start}>
                    {segment.text}
                  </span>
                ),
              )
            : placeholder}
      </div>
      <textarea
        ref={input}
        rows={1}
        className={`whiteboard-todo-input${done ? " is-done" : ""}`}
        data-todo-entry={entryId}
        aria-label={ariaLabel}
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        // A to-do is one line of thought: Enter starts the next one instead.
        onChange={(event) => onChange(event.target.value.replace(/[\r\n]+/g, " "))}
        onKeyDown={(event) => {
          // Enter also confirms a word in an input method; that is not a new to-do.
          if (event.nativeEvent.isComposing) return;
          onKeyDown?.(event);
        }}
        onPaste={linkSelection}
      />
    </div>
  );
}
