import { fileName, isMarkdown, normalizePath, parentPath, resolveVaultAsset, type Entry } from "./vault";
export interface GraphEdge { from: string; to: string; kind: "hierarchy" | "link" }

/** Derive links without modifying notes or following URLs outside the vault. */
export function graphEdges(vault: string, entries: Entry[], contents: Record<string, string>): GraphEdge[] {
  const byPath = new Map(entries.map((entry) => [normalizePath(entry.path), entry]));
  const byName = new Map<string, Entry[]>();
  for (const entry of entries.filter((item) => item.kind === "file" && isMarkdown(item.path))) {
    const name = fileName(entry.path).replace(/\.(?:md|markdown)$/i, "").toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: GraphEdge["kind"]) => {
    if (normalizePath(from) === normalizePath(to)) return;
    const key = `${kind}\0${normalizePath(from)}\0${normalizePath(to)}`;
    if (!seen.has(key)) { seen.add(key); edges.push({ from, to, kind }); }
  };
  for (const entry of entries) {
    const parent = parentPath(entry.path);
    add(byPath.get(normalizePath(parent))?.path ?? vault, entry.path, "hierarchy");
  }
  for (const [source, text] of Object.entries(contents)) {
    if (!byPath.has(normalizePath(source))) continue;
    const markdownLinks = /(?<!!)\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g;
    for (const match of text.matchAll(markdownLinks)) {
      const relative = match[1].split(/[?#]/)[0];
      const resolved = resolveVaultAsset(vault, source, relative);
      if (!resolved) continue;
      const target = byPath.get(normalizePath(resolved)) ?? byPath.get(`${normalizePath(resolved)}.md`);
      if (target?.kind === "file" && isMarkdown(target.path)) add(source, target.path, "link");
    }
    for (const match of text.matchAll(/\[\[([^\]\n|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const name = match[1].trim().replace(/\.(?:md|markdown)$/i, "").toLowerCase();
      const candidates = byName.get(name) ?? [];
      // Ambiguous note titles must not silently point at the wrong document.
      if (candidates.length === 1) add(source, candidates[0].path, "link");
    }
  }
  return edges;
}

/** Reserve the whole node and its (bounded-width) label, not just the circle. */
export function graphPositionWithoutOverlap(ideal: { x: number; y: number }, occupied: { x: number; y: number }[]): { x: number; y: number } {
  const overlaps = (p: { x: number; y: number }) => occupied.some((other) => Math.abs(p.x - other.x) < 220 && Math.abs(p.y - other.y) < 120);
  if (!overlaps(ideal)) return ideal;
  // The spiral is unbounded: even a very dense imported layout eventually has
  // a free slot, and it stays deterministic between renders.
  for (let n = 1; ; n++) {
    const radius = 45 * Math.sqrt(n), angle = n * 2.3999632297;
    const candidate = { x: ideal.x + Math.cos(angle) * radius, y: ideal.y + Math.sin(angle) * radius };
    if (!overlaps(candidate)) return candidate;
  }
}
