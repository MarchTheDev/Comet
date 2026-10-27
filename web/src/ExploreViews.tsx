import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronRight, GitBranch, Minus, Network, Plus, RotateCcw } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { graphEdges, graphPositionWithoutOverlap } from "./utils/graph";
import { displayEntryName, isMarkdown, isPathInside, normalizePath, noteTitle, parentPath, type Entry, type TreeNode } from "./utils/vault";
import { readNote } from "./utils/vaultBridge";

interface Common { vault: string; name: string; onOpen: (entry: Entry) => void; selectedPaths: Set<string>; onActivate: (event: React.MouseEvent, entry: Entry, order: string[]) => void; onClearSelection: () => void; onContext?: (event: React.MouseEvent, entry: Entry) => void }

interface TreeMapProps extends Common {
  tree: TreeNode[];
  dropIndicator: { path: string; position: "before" | "after" | "into" } | null;
  dropGroup: string;
  onDragStart: (event: DragEvent, entry: Entry) => void;
  onDragOverNode: (event: DragEvent, entry: TreeNode) => void;
  onDropNode: (event: DragEvent, entry: TreeNode) => void;
  onDragOverRoot: (event: DragEvent) => void;
  onDropRoot: (event: DragEvent) => void;
}

/** A branching workspace map with safe, shared vault drag-and-drop. */
export function TreeExplore({ tree, name, vault, selectedPaths, onActivate, onContext, dropIndicator, dropGroup, onDragStart, onDragOverNode, onDropNode, onDragOverRoot, onDropRoot }: TreeMapProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [rootOpen, setRootOpen] = useState(false);
  const [height, setHeight] = useState(340);
  const content = useRef<HTMLDivElement>(null);
  const previousRects = useRef(new Map<string, { x: number; y: number }>());
  const ordered = useMemo(() => { const result: string[] = []; const walk = (nodes: TreeNode[]) => { for (const node of nodes) { result.push(node.path); if (node.kind === "folder" && expanded.has(node.path)) walk(node.children); } }; if (rootOpen) walk(tree); return result; }, [tree, expanded, rootOpen]);
  const toggle = (path: string) => setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  // Animate the viewport's actual measured height rather than jumping between
  // auto heights. Reduced-motion users get immediate changes.
  useLayoutEffect(() => {
    const element = content.current; if (!element) return;
    const measure = () => setHeight(Math.max(340, element.offsetHeight + 48));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // FLIP existing nodes into their new positions as neighboring branches open.
  useLayoutEffect(() => {
    const element = content.current; if (!element) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const origin = element.getBoundingClientRect(), scale = element.offsetWidth ? origin.width / element.offsetWidth || 1 : 1;
    const next = new Map<string, { x: number; y: number }>();
    for (const node of element.querySelectorAll<HTMLElement>("[data-map-path]")) {
      node.getAnimations?.().forEach((animation) => animation.cancel());
      const rect = node.getBoundingClientRect(), key = node.dataset.mapPath!;
      const point = { x: (rect.left - origin.left) / scale, y: (rect.top - origin.top) / scale };
      const old = previousRects.current.get(key); next.set(key, point);
      if (!reduce && old && node.animate && (Math.abs(old.x - point.x) > 1 || Math.abs(old.y - point.y) > 1)) node.animate([{ transform: `translate(${old.x - point.x}px, ${old.y - point.y}px)` }, { transform: "translate(0, 0)" }], { duration: 220, easing: "ease-out" });
    }
    previousRects.current = next;
  }, [expanded, rootOpen, tree]);
  const branch = (nodes: TreeNode[]): React.ReactNode => <ul className="tree-map-children">{nodes.map((node) => {
    const indicator = dropIndicator?.path === node.path ? dropIndicator.position : undefined;
    return <li className={`tree-map-branch${node.kind === "folder" && dropGroup === node.path ? " drop-group" : ""}`} key={node.path}>
      <button type="button" draggable data-map-path={node.path} data-tree-path={node.path} data-drop-folder={node.kind === "folder" ? node.path : undefined} className={`tree-map-node${selectedPaths.has(node.path) ? " multi-selected" : ""}${indicator && indicator !== "into" ? ` drop-${indicator}` : ""}`} aria-expanded={node.kind === "folder" ? expanded.has(node.path) : undefined} aria-pressed={node.kind === "file" ? selectedPaths.has(node.path) : undefined} onDragStart={(event) => { event.stopPropagation(); onDragStart(event, node); }} onDragOver={(event) => onDragOverNode(event, node)} onDrop={(event) => onDropNode(event, node)} onContextMenu={(event) => onContext?.(event, node)} onClick={(event) => { if (node.kind === "folder" && !event.ctrlKey && !event.metaKey && !event.shiftKey) toggle(node.path); else onActivate(event, node, ordered); }}>
        <span className={`tree-map-dot ${node.kind}`} aria-hidden="true" /><span className={`tree-map-icon ${node.kind === "folder" ? "folder" : "file"}`}><FileIcon entry={node} size={17} expanded={expanded.has(node.path)} /></span><span className="tree-map-name">{node.kind === "folder" ? node.name : isMarkdown(node.path) ? noteTitle(node.name) : displayEntryName(node.name)}</span>{node.kind === "folder" && <><small>{node.children.length}</small>{expanded.has(node.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</>}
      </button>{node.kind === "folder" && expanded.has(node.path) && (node.children.length ? branch(node.children) : <p className="tree-map-empty">Empty folder</p>)}
    </li>;
  })}</ul>;
  return <section className="explore-card tree-map-card" aria-labelledby="tree-title"><div className="explore-heading"><span className="explore-heading-icon"><GitBranch size={20} /></span><div><span className="section-eyebrow">EXPLORE YOUR SPACE</span><h2 id="tree-title">Tree view</h2><p>Open a branch to explore. Drag an item onto a folder to move it, or between siblings to reorder.</p></div></div>
    <div className={`tree-map${dropGroup === vault ? " drop-group" : ""}`} data-map-root={vault} style={{ height }} onDragOver={onDragOverRoot} onDrop={onDropRoot}>
      <div className="tree-map-content" ref={content}><button type="button" className="tree-map-node tree-map-root" data-map-path={vault} aria-expanded={rootOpen} onClick={() => setRootOpen((open) => !open)}><span className="tree-map-dot root" /><span className="tree-map-name">{name}</span><small>{tree.length} items</small>{rootOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>{rootOpen && (tree.length ? branch(tree) : <p className="tree-map-empty">Your workspace is empty.</p>)}</div>
    </div>
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
    // Reserve explicit positions first, even when they appear later in the
    // traversal, so newly revealed default nodes cannot displace them.
    const occupied: Point[] = [root, ...ordered.map((entry) => positions[normalizePath(entry.path)]).filter((point): point is Point => Boolean(point))];
    const siblings = new Map<string, number>(), siblingCounts = new Map<string, number>();
    const rootPath = normalizePath(vault), visible = new Set(ordered.map((entry) => normalizePath(entry.path)));
    // When filtering hides folders, their notes become siblings of the root.
    // Count them together instead of putting the first child of each hidden
    // parent at the exact same position.
    const layoutParent = (entry: Entry) => { const parent = normalizePath(parentPath(entry.path)); return parent === rootPath || visible.has(parent) ? parent : rootPath; };
    ordered.forEach((entry) => { const parent = layoutParent(entry); siblingCounts.set(parent, (siblingCounts.get(parent) ?? 0) + 1); });
    return ordered.map((entry) => {
      const parent = layoutParent(entry), parentPosition = placed.get(parent);
      const sibling = siblings.get(parent) ?? 0; siblings.set(parent, sibling + 1);
      const rootChild = parent === normalizePath(vault) || !parentPosition;
      const origin = parentPosition ?? root;
      // Place children outward from their parent, rather than on top of the
      // workspace node. Existing user-arranged positions always take priority.
      const angle = rootChild ? sibling * 2.3999632297 - Math.PI / 2 : Math.atan2(origin.y - root.y, origin.x - root.x) + (sibling - ((siblingCounts.get(parent) ?? 1) - 1) / 2) * .7;
      // Keep at least one node's diameter between default siblings even for
      // the maximum 150 results; dense graphs can be panned to see outer nodes.
      const radius = rootChild ? 220 + Math.sqrt(sibling) * 45 : 155 + Math.floor(sibling / 7) * 55;
      const saved = positions[normalizePath(entry.path)];
      const desired = { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
      const point = saved ?? graphPositionWithoutOverlap(desired, occupied); if (!saved) occupied.push(point);
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
  const zoomState = useRef({ zoom, pan }); zoomState.current = { zoom, pan };
  useEffect(() => {
    const element = svg.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const point = element.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const matrix = element.getScreenCTM(); if (!matrix) return;
      const cursor = point.matrixTransform(matrix.inverse());
      const old = zoomState.current;
      const next = Math.max(.6, Math.min(2, old.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const factor = next / old.zoom;
      const nextPan = { x: cursor.x - 600 - factor * (cursor.x - 600 - old.pan.x), y: cursor.y - 520 - factor * (cursor.y - 520 - old.pan.y) };
      zoomState.current = { zoom: next, pan: nextPan }; setZoom(next); setPan(nextPan);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  const startDrag = (event: ReactPointerEvent, node?: Positioned) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const pointer = event.pointerId, start = svgPoint(event.clientX, event.clientY), startX = event.clientX, startY = event.clientY;
    const initialPan = pan, key = node ? normalizePath(node.entry.path) : "";
    // Default placements are relative to their parents. Freeze what is already
    // visible before moving a node, so dragging the vault (or a folder) doesn't
    // drag its neighbors along with it.
    const frozen = Object.fromEntries(positioned.map(({ entry, x, y }) => [normalizePath(entry.path), { x, y }]));
    let moved = false, nextPoint = node ? { x: node.x, y: node.y } : null;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
      moved = true; setDragging(true); const current = svgPoint(e.clientX, e.clientY);
      if (node) { nextPoint = { x: Math.max(-99_999, Math.min(99_999, node.x + (current.x - start.x) / zoom)), y: Math.max(-99_999, Math.min(99_999, node.y + (current.y - start.y) / zoom)) }; setPositions((previous) => ({ ...previous, ...frozen, [key]: nextPoint! })); }
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
        const saved = { ...positions, ...frozen, [key]: nextPoint };
        try { localStorage.setItem(graphKey(vault), JSON.stringify(saved)); } catch { /* layout is optional */ }
      } else if (!node && !moved) onClearSelection();
    };
    const cancel = (e: PointerEvent) => { if (e.pointerId === pointer) { cleanup(); if (node && moved) setPositions(positions); else if (!node && moved) setPan(initialPan); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", cancel);
  };
  return <section className="explore-card brain-card" aria-labelledby="brain-title"><div className="explore-heading"><span className="explore-heading-icon"><Network size={20} /></span><div><span className="section-eyebrow">EXPLORE YOUR SPACE</span><h2 id="brain-title">Brain view</h2><p>Click a folder to reveal its contents. Drag nodes or the background to arrange the graph; right-click a node for more actions.</p></div></div>
    <div className="brain-controls"><label><span className="sr-only">Filter graph</span><input aria-label="Filter graph" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a node…" /></label><button type="button" aria-pressed={filter === "notes"} onClick={() => setFilter((value) => value === "all" ? "notes" : "all")}>Notes only</button><span className="brain-spacer" /><button type="button" aria-label="Reset graph view" title="Reset view" onClick={() => { setZoom(window.innerWidth <= 600 ? 1.3 : 1); setPan({ x: 0, y: 0 }); }}><RotateCcw size={14} /></button><button type="button" aria-label="Zoom graph out" onClick={() => setZoom((value) => Math.max(.6, Math.round((value - .2) * 10) / 10))}><Minus size={15} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom graph in" onClick={() => setZoom((value) => Math.min(2, Math.round((value + .2) * 10) / 10))}><Plus size={15} /></button></div>
    <div className={`brain-stage${dragging ? " dragging" : ""}`}><svg ref={svg} viewBox="0 0 1200 1040" preserveAspectRatio="xMidYMid meet" role="group" aria-label={`Workspace graph for ${name}`} onPointerDown={(event) => startDrag(event)}>
      <g transform={`translate(${pan.x} ${pan.y}) translate(600 520) scale(${zoom}) translate(-600 -520)`}>
        <g className="brain-edges">{drawn.map((edge) => { const from = positionMap.get(normalizePath(edge.from))!, to = positionMap.get(normalizePath(edge.to))!; return <line key={`${edge.kind}:${edge.from}:${edge.to}`} className={edge.kind} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />; })}</g>
        <g className="brain-root" data-graph-root transform={`translate(${rootPosition.x} ${rootPosition.y})`} aria-label={`Drag ${name} workspace node`} onPointerDown={(event) => startDrag(event, { entry: { path: vault, name, kind: "folder" }, ...rootPosition })}><circle r="35" /><text textAnchor="middle" y="57">{name.slice(0, 22)}</text></g>
        {positioned.map((node) => { const { entry, x, y } = node; const folderOpen = expandedFolders.has(normalizePath(entry.path)); return <g className={`brain-node ${entry.kind}${selectedPaths.has(entry.path) ? " multi-selected" : ""}`} data-graph-path={entry.path} key={entry.path} transform={`translate(${x} ${y})`} role="button" tabIndex={0} aria-label={entry.kind === "folder" ? `${folderOpen ? "Collapse" : "Expand"} ${entry.name}` : `Open ${entry.name}`} aria-expanded={entry.kind === "folder" ? folderOpen : undefined} aria-pressed={entry.kind === "file" ? selectedPaths.has(entry.path) : undefined} onPointerDown={(event) => startDrag(event, node)} onContextMenu={(event) => onContext?.(event, entry)} onClick={(event) => { if (suppressClick.current) { suppressClick.current = false; return; } if (entry.kind === "folder" && !event.ctrlKey && !event.metaKey && !event.shiftKey) toggleFolder(entry.path); else onActivate(event, entry, positioned.map((item) => item.entry.path)); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (entry.kind === "folder") toggleFolder(entry.path); else onOpen(entry); } }}><title>{entry.path}</title><circle className="brain-node-hit" r="36" /><circle r={entry.kind === "folder" ? 25 : 20} />{entry.kind === "folder" && <text className="brain-folder-glyph" textAnchor="middle" y="7">{folderOpen ? "−" : "+"}</text>}<text textAnchor="middle" y="45">{(entry.kind === "folder" ? entry.name : isMarkdown(entry.path) ? noteTitle(entry.name) : displayEntryName(entry.name)).slice(0, 22)}</text></g>; })}
      </g>
    </svg></div>
    <div className="brain-caption"><span>{loading ? "Reading note links…" : `${drawn.filter((edge) => edge.kind === "link").length} note links`} · {positioned.length} items shown</span><span>{entries.length > 150 ? "Graph displays up to 150 matching items. " : ""}{notes.length > 120 ? "Links are read from the first 120 notes." : ""}</span></div>
  </section>;
}
