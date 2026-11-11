import { AlertCircle, Link2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { normalizeLinkInput } from "./utils/inlineLinks";

/**
 * Ask for a web address, and optionally the words that should carry it.
 *
 * Used by whiteboard text boxes and to-dos. It is drawn on the document body:
 * a whiteboard card sits inside the zoomed canvas, where a fixed overlay would
 * be scaled and clipped along with it.
 */
export function LinkDialog({
  initialText = "",
  initialUrl = "",
  showText,
  editing = false,
  onSubmit,
  onRemove,
  onCancel,
}: {
  initialText?: string;
  initialUrl?: string;
  /** Offer a "text to show" field as well as the address. */
  showText: boolean;
  /** An existing link is being changed rather than a new one added. */
  editing?: boolean;
  /** Return a message to keep the dialog open and show it. */
  onSubmit: (link: { text: string; href: string }) => string | void;
  onRemove?: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const address = useRef<HTMLInputElement>(null);

  useEffect(() => {
    address.current?.focus();
    address.current?.select();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const href = normalizeLinkInput(url);
    if (!href) {
      setError("Enter a web address, such as example.com.");
      return;
    }
    const problem = onSubmit({ text: text.trim(), href });
    if (problem) setError(problem);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // The board underneath has shortcuts of its own; none of them are meant here.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const stops = Array.from(
      form.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? [],
    );
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // React hands a portal's events to the component that rendered it, which here
  // is a card on the canvas. Left alone, a press in this dialog would start
  // panning the board behind it.
  const contain = (event: { stopPropagation: () => void }) => event.stopPropagation();

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        event.stopPropagation();
        onCancel();
      }}
      onPointerDown={contain}
      onPointerUp={contain}
      onClick={contain}
      onDoubleClick={contain}
      onContextMenu={contain}
      onFocus={contain}
      onPaste={contain}
    >
      <form
        ref={form}
        className="modal link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-dialog-title"
        noValidate
        onSubmit={submit}
        onMouseDown={contain}
        onKeyDown={onKeyDown}
      >
        <div className="modal-icon">
          <Link2 size={20} />
        </div>
        <button className="modal-close icon-button" type="button" onClick={onCancel} aria-label="Close dialog">
          <X size={18} />
        </button>
        <h2 id="link-dialog-title">{editing ? "Edit link" : "Add a link"}</h2>
        <p>
          {showText
            ? "Choose the words to show, or leave them empty to show the address itself."
            : editing
              ? "Change where this link goes, or remove it."
              : "The selected text will open this address."}
        </p>
        {showText && (
          <div className="link-dialog-field">
            <label className="modal-label" htmlFor="link-dialog-text">
              Text to show
            </label>
            <input
              id="link-dialog-text"
              value={text}
              maxLength={500}
              placeholder="Optional"
              onChange={(event) => setText(event.target.value)}
            />
          </div>
        )}
        <div className="link-dialog-field">
          <label className="modal-label" htmlFor="link-dialog-url">
            Web address
          </label>
          <input
            ref={address}
            id="link-dialog-url"
            value={url}
            maxLength={2048}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="example.com"
            onChange={(event) => {
              setUrl(event.target.value);
              setError("");
            }}
          />
        </div>
        {error && (
          <div className="dialog-error" role="alert">
            <AlertCircle size={15} /> {error}
          </div>
        )}
        <div className="modal-actions">
          {onRemove && (
            <button type="button" className="text-button" onClick={onRemove}>
              Remove link
            </button>
          )}
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-button">
            {editing ? "Save link" : "Add link"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
