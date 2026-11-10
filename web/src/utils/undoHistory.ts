export class UndoHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey = "";
  private lastAt = 0;

  constructor(private readonly limit = 100, private readonly coalesceMs = 500) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  record(previous: T, key = "", now = Date.now()): void {
    this.future = [];
    if (key && key === this.lastKey && now - this.lastAt <= this.coalesceMs && this.past.length > 0) {
      this.lastAt = now;
      return;
    }
    this.past.push(previous);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.lastKey = key;
    this.lastAt = now;
  }

  undo(current: T): T | undefined {
    const previous = this.past.pop();
    if (previous === undefined) return undefined;
    this.future.push(current);
    if (this.future.length > this.limit) this.future.splice(0, this.future.length - this.limit);
    this.lastKey = "";
    this.lastAt = 0;
    return previous;
  }

  redo(current: T): T | undefined {
    const next = this.future.pop();
    if (next === undefined) return undefined;
    this.past.push(current);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.lastKey = "";
    this.lastAt = 0;
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.lastKey = "";
    this.lastAt = 0;
  }
}

export function undoRedoKey(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): "undo" | "redo" | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}

/** True when `target` is an ordinary standalone text control whose browser undo should be preserved. */
export function isStandaloneTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".ProseMirror")) return true;
  const field = target.closest("input, textarea, [contenteditable='true']");
  if (!field) return false;
  if (field instanceof HTMLInputElement) {
    const textTypes = new Set(["", "text", "search", "url", "email", "password", "tel", "number"]);
    return textTypes.has(field.type.toLowerCase());
  }
  return true;
}
