import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Trash2 } from "lucide-react";

/** Confirm clearing board contents without deleting the board file itself. */
export function ClearBoardDialog({ kind, onCancel, onConfirm }: { kind: "whiteboard" | "to-do board"; onCancel: () => void; onConfirm: () => boolean }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    else if (event.key === "Tab") {
      if (event.shiftKey && document.activeElement === cancel.current) { event.preventDefault(); confirm.current?.focus(); }
      else if (!event.shiftKey && document.activeElement === confirm.current) { event.preventDefault(); cancel.current?.focus(); }
    }
  };
  return <div className="modal-backdrop" onMouseDown={onCancel}>
    <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="clear-board-title" aria-describedby="clear-board-description" onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
      <div className="modal-icon danger-icon"><Trash2 size={20} /></div>
      <h2 id="clear-board-title">Clear this {kind}?</h2>
      <p id="clear-board-description">{kind === "whiteboard" ? "All items, drawings and connections" : "All to-dos, categories and connections"} will be removed. The board and its name will stay. This cannot be undone.</p>
      {failed && <div className="dialog-error" role="alert">The board couldn't be cleared. Its previous contents are still here.</div>}
      <div className="modal-actions"><button ref={cancel} className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button ref={confirm} className="danger-button" type="button" onClick={() => { if (onConfirm()) onCancel(); else setFailed(true); }}>Clear board</button></div>
    </div>
  </div>;
}
