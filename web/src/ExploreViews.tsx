import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronRight, GitBranch, Minus, Network, Plus, RotateCcw } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { graphEdges } from "./utils/graph";
import { isMarkdown, isPathInside, normalizePath, noteTitle, parentPath, type Entry, type TreeNode } from "./utils/vault";
import { readNote } from "./utils/vaultBridge";

interface Common { vault: string; name: string; onOpen: (entry: Entry) => void; selectedPaths: Set<string>; onActivate: (event: React.MouseEvent, entry: Entry, order: string[]) => void; onClearSelection: () => void; onContext?: (event: React.MouseEvent, entry: Entry) => void }

/** A branching workspace map: the root and folder dots reveal their children. */
export function TreeExplore({ tree, name, selectedPaths, onActivate }: Common & { tree: TreeNode[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [rootOpen, setRootOpen] = useState(false);
  const ordered = useMemo(() => { const result: string[] = []; const walk = (nodes: TreeNode[]) => { for (const node of nodes) { result.push(node.path); if (node.kind === "folder" && expanded.has(node.path)) walk(node.children); } }; if (rootOpen) walk(tree); return result; }, [tree, expanded, rootOpen]);
  const toggle = (path: string) => setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const branch = (nodes: TreeNode[]): React.ReactNode => <ul className="tree-map-children">{nodes.map((node) => <li className="tree-map-branch" key={node.path}>
    <button type="button" className={`tree-map-node${selectedPaths.has(node.path) ? " multi-selected" : ""}`} aria-expanded={node.kind === "folder" ? expanded.has(node.path) : undefined} aria-pressed={node.kind === "file" ? selectedPaths.has(node.path) : undefined} onClick={(event) => { if (node.kind === "folder" && !event.ctrlKey && !event.metaKey && !event.shiftKey) toggle(node.path); else onActivate(event, node, ordered); }}>
      <span className={`tree-map-dot ${node.kind}`} aria-hidden="true" /><span className={`tree-map-icon ${node.kind === "folder" ? "folder" : "file"}`}><FileIcon entry={node} size={17} expanded={expanded.has(node.path)} /></span><span className="tree-map-name">{node.kind === "file" && isMarkdown(node.path) ? noteTitle(node.name) : node.name}</span>{node.kind === "folder" && <><small>{node.children.length}</small>{expanded.has(node.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</>}
    </button>{node.kind === "folder" && expanded.has(node.path) && (node.children.length ? branch(node.children) : <p className="tree-map-empty">Empty folder</p>)}
  </li>)}</ul>;
  return <section className="explore-card tree-map-card" aria-labelledby="tree-title"><div className="explore-heading"><span className="explore-heading-icon"><GitBranch size={20} /></span><div><span className="section-eyebrow">EXPLORE YOUR SPACE</span><h2 id="tree-title">Tree view</h2><p>Start at the workspace, then open the dots to reveal folders and files.</p></div></div>
    <div className="tree-map"><button type="button" className="tree-map-node tree-map-root" aria-expanded={rootOpen} onClick={() => setRootOpen((open) => !open)}><span className="tree-map-dot root" /><span className="tree-map-name">{name}</span><small>{tree.length} items</small>{rootOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>{rootOpen && (tree.length ? branch(tree) : <p className="tree-map-empty">Your workspace is empty.</p>)}</div>
  </section>;
}

type Point = { x: number; y: number };
interface Positioned extends Point { entry: Entry }
const graphKey = (vault: string) => `comet:graph-layout:v1:${encodeURIComponent(normalizePath(vault))}`;
function readPositions(vault: string): Record<string, Point> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(graphKey(vault)) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([path, point]) => isPathInside(path, vault) && point && typeof point === "object" && Number.isFinite((point as Point).x) && Number.isFinite((point as Point).y) && Math.abs((point as Point).x) < 100_000 && Math.abs((point as Point).y) < 100_000).slice(0, 1000)) as Record<string, Point>;
  } catch { return {}; }
}

export function BrainExplore({ vault, name, entries, onOpen, onActivate, onContext, selectedPaths, onClearSelection }: Common & { entries: Entry[] }) {
  const [contents, setContents] = useState<Record<string, string>>({});
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const toggleFolder = (path: string) => setExpandedFolders((previous) => { const next = new Set(previous); const key = normalizePath(path); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(() => typeof window !== "undefined" && window.innerWidth <= 600 ? 1.3 : 1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [positions, setPositions] = useState<Record<string, Point>>(() => readPositions(vault));
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "notes">("all");
  const svg = useRef<SVGSVGElement>(null);
  const suppressClick = useRef(false);
  const notes = useMemo(() => entries.filter((entry) => entry.kind === "file" && isMarkdown(entry.path)), [entries]);
  useEffect(() => {
    let cancelled = false;
    setContents({}); setLoading(true);
    // Read only Markdown, with bounded concurrency and count. Binary files are
    // never decoded. The native reader enforces a 16 MB per-file limit.
    const pending = notes.slice(0, 120); const collected: Record<string, string> = {}; let index = 0;
    const worker = async () => {
      while (!cancelled) {
        const item = pending[index++]; if (!item) break;
        try { const content = await readNote(vault, item.path); if (!content.includes("\0") && !/^data:[^,\s]*;base64,/i.test(content)) collected[item.path] = content.slice(0, 256 * 1024); } catch { /* inaccessible notes are left unlinked */ }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker)).then(() => { if (!cancelled) { setContents(collected); setLoading(false); } });
    return () => { cancelled = true; };
  }, [notes, vault]);
  const filtered = useMemo(() => {
    const search = query.toLowerCase().trim(), root = normalizePath(vault);
    return entries.filter((entry) => {
      if (filter === "notes" && !(entry.kind === "file" && isMarkdown(entry.path))) return false;
      if (search && !entry.name.toLowerCase().includes(search)) return false;
      // Search and notes-only mode can find items inside collapsed folders.
      if (search || filter === "notes") return true;
      let parent = normalizePath(parentPath(entry.path));
      while (parent && parent !== root) {
        if (!expandedFolders.has(parent)) return false;
        const next = normalizePath(parentPath(parent)); if (next === parent) return false; parent = next;
      }
      return parent === root;
    }).slice(0, 150);
  }, [entries, filter, query, expandedFolders, vault]);
  const positioned = useMemo<Positioned[]>(() => {
    const ordered = [...filtered].sort((a, b) => normalizePath(a.path).split("/").length - normalizePath(b.path).split("/").length);
    const root = positions[normalizePath(vault)] ?? { x: 600, y: 520 };
    const placed = new Map<string, Point>([[normalizePath(vault), root]]);
    const siblings = new Map<string, number>(), siblingCounts = new Map<string, number>();
    ordered.forEach((entry) => { const parent = normalizePath(parentPath(entry.path)); siblingCounts.set(parent, (siblingCounts.get(parent) ?? 0) + 1); });
    return ordered.map((entry) => {
      const parent = normalizePath(parentPath(entry.path)), parentPosition = placed.get(parent);
      const sibling = siblings.get(parent) ?? 0; siblings.set(parent, sibling + 1);
      const rootChild = parent === normalizePath(vault) || !parentPosition;
      const origin = parentPosition ?? root;
      // Place children outward from their parent, rather than on top of the
      // workspace node. Existing user-arranged positions always take priority.
      const angle = rootChild ? sibling * 2.3999632297 - Math.PI / 2 : Math.atan2(origin.y - root.y, origin.x - root.x) + (sibling - ((siblingCounts.get(parent) ?? 1) - 1) / 2) * .7;
      const radius = rootChild ? 220 + Math.sqrt(sibling / Math.max(1, (siblingCounts.get(parent) ?? 1) - 1)) * (typeof window !== "undefined" && window.innerWidth <= 600 ? 170 : 205) : 155 + Math.floor(sibling / 7) * 55;
      const point = positions[normalizePath(entry.path)] ?? { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
      placed.set(normalizePath(entry.path), point);
      return { entry, ...point };
    });
  }, [filtered, positions, vault]);
  const edges = useMemo(() => graphEdges(vault, entries, contents), [vault, entries, contents]);
  const rootPosition = positions[normalizePath(vault)] ?? { x: 600, y: 520 };
  const positionMap = useMemo(() => new Map([[normalizePath(vault), rootPosition], ...positioned.map(({ entry, x, y }) => [normalizePath(entry.path), { x, y }] as const)]), [positioned, vault, rootPosition.x, rootPosition.y]);
  const drawn = edges.filter((edge) => positionMap.has(normalizePath(edge.from)) && positionMap.has(normalizePath(edge.to)));
  const svgPoint = (clientX: number, clientY: number): Point => {
    const element = svg.current; if (!element) return { x: clientX, y: clientY };
    const point = element.createSVGPoint(); point.x = clientX; point.y = clientY;
    const matrix = element.getScreenCTM(); if (!matrix) return { x: clientX, y: clientY };
    const result = point.matrixTransform(matrix.inverse()); return { x: result.x, y: result.y };
  };
  const startDrag = (event: ReactPointerEvent, node?: Positioned) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const pointer = event.pointerId, start = svgPoint(event.clientX, event.clientY), startX = event.clientX, startY = event.clientY;
    const initialPan = pan, key = node ? normalizePath(node.entry.path) : "";
    let moved = false, nextPoint = node ? { x: node.x, y: node.y } : null;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
      moved = true; setDragging(true); const current = svgPoint(e.clientX, e.clientY);
      if (node) { nextPoint = { x: Math.max(-99_999, Math.min(99_999, node.x + (current.x - start.x) / zoom)), y: Math.max(-99_999, Math.min(99_999, node.y + (current.y - start.y) / zoom)) }; setPositions((previous) => ({ ...previous, [key]: nextPoint! })); }
      else setPan({ x: initialPan.x + current.x - start.x, y: initialPan.y + current.y - start.y });
    };
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel); setDragging(false); };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return; cleanup();
      if (moved && node && nextPoint) {
        suppressClick.current = true;
        // Pointer-up can land outside the original node, in which case no
        // click follows. Do not swallow the user's next intentional click.
        window.setTimeout(() => { suppressClick.current = false; }, 0);
        const saved = { ...positions, [key]: nextPoint };
        try { localStorage.setItem(graphKey(vault), JSON.stringify(saved)); } catch { /* layout is optional */ }
      } else if (!node && !moved) onClearSelection();
    };
    const cancel = (e: PointerEvent) => { if (e.pointerId === pointer) cleanup(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", cancel);
  };
  return <section className="explore-card brain-card" aria-labelledby="brain-title"><div className="explore-heading"><span className="explore-heading-icon"><Network size={20} /></span><div><span className="section-eyebrow">EXPLORE YOUR SPACE</span><h2 id="brain-title">Brain view</h2><p>Click a folder to reveal its contents. Drag nodes or the background to arrange the graph; right-click a node for more actions.</p></div></div>
    <div className="brain-controls"><label><span className="sr-only">Filter graph</span><input aria-label="Filter graph" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a node…" /></label><button type="button" aria-pressed={filter === "notes"} onClick={() => setFilter((value) => value === "all" ? "notes" : "all")}>Notes only</button><span className="brain-spacer" /><button type="button" aria-label="Reset graph view" title="Reset view" onClick={() => { setZoom(window.innerWidth <= 600 ? 1.3 : 1); setPan({ x: 0, y: 0 }); }}><RotateCcw size={14} /></button><button type="button" aria-label="Zoom graph out" onClick={() => setZoom((value) => Math.max(.6, Math.round((value - .2) * 10) / 10))}><Minus size={15} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom graph in" onClick={() => setZoom((value) => Math.min(2, Math.round((value + .2) * 10) / 10))}><Plus size={15} /></button></div>
    <div className={`brain-stage${dragging ? " dragging" : ""}`}><svg ref={svg} viewBox="0 0 1200 1040" preserveAspectRatio="xMidYMid meet" role="group" aria-label={`Workspace graph for ${name}`} onPointerDown={(event) => startDrag(event)}>
      <g transform={`translate(${pan.x} ${pan.y}) translate(600 520) scale(${zoom}) translate(-600 -520)`}>
        <g className="brain-edges">{drawn.map((edge) => { const from = positionMap.get(normalizePath(edge.from))!, to = positionMap.get(normalizePath(edge.to))!; return <line key={`${edge.kind}:${edge.from}:${edge.to}`} className={edge.kind} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />; })}</g>
        <g className="brain-root" data-graph-root transform={`translate(${rootPosition.x} ${rootPosition.y})`} aria-label={`Drag ${name} workspace node`} onPointerDown={(event) => startDrag(event, { entry: { path: vault, name, kind: "folder" }, ...rootPosition })}><circle r="35" /><text textAnchor="middle" y="57">{name.slice(0, 22)}</text></g>
        {positioned.map((node) => { const { entry, x, y } = node; const folderOpen = expandedFolders.has(normalizePath(entry.path)); return <g className={`brain-node ${entry.kind}${selectedPaths.has(entry.path) ? " multi-selected" : ""}`} data-graph-path={entry.path} key={entry.path} transform={`translate(${x} ${y})`} role="button" tabIndex={0} aria-label={entry.kind === "folder" ? `${folderOpen ? "Collapse" : "Expand"} ${entry.name}` : `Open ${entry.name}`} aria-expanded={entry.kind === "folder" ? folderOpen : undefined} aria-pressed={entry.kind === "file" ? selectedPaths.has(entry.path) : undefined} onPointerDown={(event) => startDrag(event, node)} onContextMenu={(event) => onContext?.(event, entry)} onClick={(event) => { if (suppressClick.current) { suppressClick.current = false; return; } if (entry.kind === "folder" && !event.ctrlKey && !event.metaKey && !event.shiftKey) toggleFolder(entry.path); else onActivate(event, entry, positioned.map((item) => item.entry.path)); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (entry.kind === "folder") toggleFolder(entry.path); else onOpen(entry); } }}><title>{entry.path}</title><circle className="brain-node-hit" r="36" /><circle r={entry.kind === "folder" ? 25 : 20} />{entry.kind === "folder" && <text className="brain-folder-glyph" textAnchor="middle" y="7">{folderOpen ? "−" : "+"}</text>}<text textAnchor="middle" y="45">{(entry.kind === "file" && isMarkdown(entry.path) ? noteTitle(entry.name) : entry.name).slice(0, 22)}</text></g>; })}
      </g>
    </svg></div>
    <div className="brain-caption"><span>{loading ? "Reading note links…" : `${drawn.filter((edge) => edge.kind === "link").length} note links`} · {positioned.length} items shown</span><span>{entries.length > 150 ? "Graph displays up to 150 matching items. " : ""}{notes.length > 120 ? "Links are read from the first 120 notes." : ""}</span></div>
  </section>;
}
