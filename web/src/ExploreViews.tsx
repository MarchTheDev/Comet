import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, GitBranch, Minus, Network, Plus } from "lucide-react";
import { graphEdges } from "./utils/graph";
import { isMarkdown, normalizePath, noteTitle, type Entry, type TreeNode } from "./utils/vault";
import { readNote } from "./utils/vaultBridge";

interface Common { vault: string; name: string; onOpen: (entry: Entry) => void; selectedPaths: Set<string>; onActivate: (event: React.MouseEvent, entry: Entry, order: string[]) => void }
export function TreeExplore({ tree, name, selectedPaths, onActivate }: Common & { tree: TreeNode[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.filter((node) => node.kind === "folder").map((node) => node.path)));
  const ordered = useMemo(() => { const result: string[] = []; const walk = (nodes: TreeNode[]) => { for (const node of nodes) { result.push(node.path); if (node.kind === "folder" && expanded.has(node.path)) walk(node.children); } }; walk(tree); return result; }, [tree, expanded]);
  const toggle = (path: string) => setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const branch = (nodes: TreeNode[], depth: number): React.ReactNode => nodes.map((node) => <div className="explore-branch" key={node.path}>
    <div className={`explore-tree-row${selectedPaths.has(node.path) ? " multi-selected" : ""}`} style={{ paddingLeft: 14 + depth * 23 }}>
      {node.kind === "folder" ? <button className="explore-disclosure" type="button" aria-label={`${expanded.has(node.path) ? "Collapse" : "Expand"} ${node.name}`} aria-expanded={expanded.has(node.path)} onClick={() => toggle(node.path)}>{expanded.has(node.path) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button> : <span className="explore-disclosure" />}
      <button className="explore-tree-open" type="button" aria-pressed={selectedPaths.has(node.path)} onClick={(event) => onActivate(event, node, ordered)}>{node.kind === "folder" ? expanded.has(node.path) ? <FolderOpen size={18} /> : <Folder size={18} /> : <FileText size={18} />}<span>{node.kind === "file" && isMarkdown(node.path) ? noteTitle(node.name) : node.name}</span><small>{node.kind === "folder" ? `${node.children.length} ${node.children.length === 1 ? "item" : "items"}` : "File"}</small><ChevronRight size={15} /></button>
    </div>
    {node.kind === "folder" && expanded.has(node.path) && branch(node.children, depth + 1)}
  </div>);
  return <section className="explore-card" aria-labelledby="tree-title"><div className="explore-heading"><span className="explore-heading-icon"><GitBranch size={20} /></span><div><span className="section-eyebrow">EXPLORE YOUR SPACE</span><h2 id="tree-title">Tree view</h2><p>{name}, laid out from the top down. Expand folders or open an item.</p></div></div><div className="explore-tree">{tree.length ? branch(tree, 0) : <p className="explore-empty">Your workspace is empty.</p>}</div></section>;
}

interface Positioned { entry: Entry; x: number; y: number }
export function BrainExplore({ vault, name, entries, onOpen, onActivate, selectedPaths }: Common & { entries: Entry[] }) {
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "notes">("all");
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = stage.current; if (!element) return;
    element.scrollLeft = Math.max(0, (element.scrollWidth - element.clientWidth) / 2);
    element.scrollTop = Math.max(0, (element.scrollHeight - element.clientHeight) / 2);
  }, [zoom]);
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
  const filtered = useMemo(() => entries.filter((entry) => (filter === "all" || entry.kind === "file" && isMarkdown(entry.path)) && entry.name.toLowerCase().includes(query.toLowerCase().trim())).slice(0, 150), [entries, filter, query]);
  const positioned = useMemo<Positioned[]>(() => filtered.map((entry, index) => {
    // A deterministic phyllotaxis layout spreads even large workspaces without
    // a simulation that keeps the app busy or changes positions on each edit.
    const angle = index * 2.3999632297 - Math.PI / 2;
    const radius = 75 + Math.sqrt(index / Math.max(1, filtered.length - 1)) * 410;
    return { entry, x: 600 + Math.cos(angle) * radius, y: 520 + Math.sin(angle) * radius };
  }), [filtered]);
  const edges = useMemo(() => graphEdges(vault, entries, contents), [vault, entries, contents]);
  const positions = useMemo(() => new Map([[normalizePath(vault), { x: 600, y: 520 }], ...positioned.map(({ entry, x, y }) => [normalizePath(entry.path), { x, y }] as const)]), [positioned, vault]);
  const drawn = edges.filter((edge) => positions.has(normalizePath(edge.from)) && positions.has(normalizePath(edge.to)));
  return <section className="explore-card brain-card" aria-labelledby="brain-title"><div className="explore-heading"><span className="explore-heading-icon"><Network size={20} /></span><div><span className="section-eyebrow">EXPLORE YOUR SPACE</span><h2 id="brain-title">Brain view</h2><p>See folders and notes as a network. Solid lines show folders; dotted lines show note links (first 256K characters per note).</p></div></div>
    <div className="brain-controls"><label><span className="sr-only">Filter graph</span><input aria-label="Filter graph" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a node…" /></label><button type="button" aria-pressed={filter === "notes"} onClick={() => setFilter((value) => value === "all" ? "notes" : "all")}>Notes only</button><span className="brain-spacer" /><button type="button" aria-label="Zoom graph out" onClick={() => setZoom((value) => Math.max(.6, Math.round((value - .2) * 10) / 10))}><Minus size={15} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom graph in" onClick={() => setZoom((value) => Math.min(2, Math.round((value + .2) * 10) / 10))}><Plus size={15} /></button></div>
    <div className="brain-stage" ref={stage}><svg viewBox="0 0 1200 1040" width={1200 * zoom} height={1040 * zoom} role="group" aria-label={`Workspace graph for ${name}`}>
      <g className="brain-edges">{drawn.map((edge) => { const from = positions.get(normalizePath(edge.from))!, to = positions.get(normalizePath(edge.to))!; return <line key={`${edge.kind}:${edge.from}:${edge.to}`} className={edge.kind} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />; })}</g>
      <g className="brain-root" transform="translate(600 520)"><circle r="23" /><text textAnchor="middle" y="40">{name.slice(0, 22)}</text></g>
      {positioned.map(({ entry, x, y }) => <g className={`brain-node ${entry.kind}${selectedPaths.has(entry.path) ? " multi-selected" : ""}`} key={entry.path} transform={`translate(${x} ${y})`} role="button" tabIndex={0} aria-label={`Open ${entry.name}`} aria-pressed={selectedPaths.has(entry.path)} onClick={(event) => onActivate(event, entry, positioned.map((node) => node.entry.path))} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(entry); } }}><title>{entry.path}</title><circle r={entry.kind === "folder" ? 15 : 11} /><text textAnchor="middle" y="27">{(entry.kind === "file" && isMarkdown(entry.path) ? noteTitle(entry.name) : entry.name).slice(0, 22)}</text></g>)}
    </svg></div>
    <div className="brain-caption"><span>{loading ? "Reading note links…" : `${drawn.filter((edge) => edge.kind === "link").length} note links`} · {positioned.length} items shown</span><span>{entries.length > 150 ? "Graph displays up to 150 matching items. " : ""}{notes.length > 120 ? "Links are read from the first 120 notes." : ""}</span></div>
  </section>;
}
