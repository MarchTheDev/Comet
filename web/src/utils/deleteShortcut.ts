import { selectionRoots } from "./selection";

/** Only delete a deliberately clicked/selected file; never steal text editing keys. */
export function deleteShortcutPaths(event: KeyboardEvent, selection: Set<string>, anchor: string, anchorOpened: boolean, armed: boolean): string[] {
  if ((event.key !== "Delete" && event.key !== "Backspace") || event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return [];
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return [];
  const control = target.closest<HTMLElement>(".tree-item, .workspace-entry-open, .tree-map-node[data-tree-path], .brain-node[data-graph-path]");
  const focusedPath = control?.closest<HTMLElement>("[data-tree-path], [data-path], [data-graph-path]")?.getAttribute("data-tree-path") ?? control?.closest<HTMLElement>("[data-path]")?.getAttribute("data-path") ?? control?.getAttribute("data-graph-path") ?? "";
  const scope = Boolean(control && (selection.has(focusedPath) || (anchorOpened && focusedPath === anchor))) || Boolean(target === document.body && armed);
  if (!scope) return [];
  const selected = selectionRoots([...selection]);
  return selected.length ? selected : anchorOpened && armed && anchor ? [anchor] : [];
}
