import { isPathInside } from "./vault";

/** One shared selection model for the sidebar and workspace lists. */
export function selectRange(selected: Set<string>, anchor: string, ordered: string[], path: string, modifier: boolean, shift: boolean, seedOpenAnchor = false): { selected: Set<string>; anchor: string; open: boolean } {
  if (shift) {
    const start = ordered.indexOf(anchor), end = ordered.indexOf(path);
    const range = start >= 0 && end >= 0 ? ordered.slice(Math.min(start, end), Math.max(start, end) + 1) : [path];
    return { selected: new Set(modifier ? [...selected, ...range] : range), anchor: start >= 0 ? anchor : path, open: false };
  }
  if (modifier) {
    const next = new Set(selected);
    if (seedOpenAnchor && !next.size && anchor && anchor !== path && ordered.includes(anchor)) next.add(anchor);
    if (next.has(path)) next.delete(path); else next.add(path);
    return { selected: next, anchor: path, open: false };
  }
  return { selected: new Set(), anchor: path, open: true };
}

/** Avoid deleting a descendant separately when its selected parent is removed. */
export function selectionRoots(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  return sorted.filter((path, index) => !sorted.slice(0, index).some((parent) => isPathInside(path, parent)));
}
