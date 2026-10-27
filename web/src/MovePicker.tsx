import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Search, X } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { displayWorkspacePath } from "./utils/pathNavigation";
import { isPathInside, normalizePath, parentPath, type TreeNode } from "./utils/vault";

interface FolderTreeProps {
  item?: TreeNode;
  tree: TreeNode[];
  vault: string;
  name: string;
  destination: string;
  onDestination: (path: string) => void;
  showFiles?: boolean;
}

/** Shared destination picker for Move to and Quick Capture. */
export function FolderTreePicker({ item, tree, vault, name, destination, onDestination, showFiles = false }: FolderTreeProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.filter((node) => node.kind === "folder").map((node) => node.path)));
  const current = item ? parentPath(item.path) : "";
  const matches = (node: TreeNode): boolean => {
    if (!showFiles && node.kind === "file") return false;
    if (item && node.kind === "folder" && isPathInside(node.path, item.path)) return false;
    return !query.trim() || node.name.toLowerCase().includes(query.toLowerCase().trim()) || node.children.some(matches);
  };
  const rows = (nodes: TreeNode[], depth: number): React.ReactNode => nodes.filter(matches).map((node) => node.kind === "file" ? <div key={node.path} className="move-file-row" data-move-file={node.path} style={{ paddingLeft: 34 + depth * 18 }}><FileIcon entry={node} size={16} /><span>{node.name}</span>{item && normalizePath(node.path) === normalizePath(item.path) && <small>Moving</small>}</div> : <div key={node.path}>
    <div className={`move-folder-row${normalizePath(destination) === normalizePath(node.path) ? " selected" : ""}`} style={{ paddingLeft: 10 + depth * 18 }}>
      <button type="button" className="move-disclosure" aria-label={`${expanded.has(node.path) ? "Collapse" : "Expand"} ${node.name}`} onClick={() => setExpanded((previous) => { const next = new Set(previous); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next; })}>{expanded.has(node.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
      <button type="button" className="move-folder-select" aria-pressed={normalizePath(destination) === normalizePath(node.path)} onClick={() => onDestination(node.path)}>{expanded.has(node.path) ? <FolderOpen size={17} /> : <Folder size={17} />}<span>{node.name}</span>{current && normalizePath(current) === normalizePath(node.path) && <small>Current</small>}</button>
    </div>
    {(expanded.has(node.path) || query.trim()) && rows(node.children, depth + 1)}
  </div>);
  return <>
    <label className="move-search"><Search size={15} /><span className="sr-only">Find a folder</span><input aria-label="Find a folder" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a folder…" /></label>
    <div className="move-folder-list" aria-label="Destination folders"><div className={`move-folder-row root${normalizePath(destination) === normalizePath(vault) ? " selected" : ""}`}><span className="move-disclosure" /><button type="button" className="move-folder-select" aria-pressed={normalizePath(destination) === normalizePath(vault)} onClick={() => onDestination(vault)}><FolderOpen size={17} /><span>{name}</span>{current && normalizePath(current) === normalizePath(vault) && <small>Current</small>}</button></div>{rows(tree, 1)}</div>
  </>;
}

interface Props { item: TreeNode; tree: TreeNode[]; vault: string; name: string; destination: string; onDestination: (path: string) => void; onClose: () => void; onMove: () => void }
export function MovePicker({ item, tree, vault, name, destination, onDestination, onClose, onMove }: Props) {
  const current = parentPath(item.path);
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal move-modal" role="dialog" aria-modal="true" aria-labelledby="move-title" onSubmit={(event) => { event.preventDefault(); onMove(); }} onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-icon"><FolderOpen size={20} /></div><button className="modal-close icon-button" type="button" aria-label="Close move dialog" onClick={onClose}><X size={18} /></button>
    <h2 id="move-title">Move “{item.name}”</h2><p>Choose a folder in {name}. Existing files won’t be overwritten.</p>
    <FolderTreePicker item={item} tree={tree} vault={vault} name={name} destination={destination} onDestination={onDestination} showFiles />
    <div className="move-destination"><span>Moving to</span><strong title={displayWorkspacePath(destination, vault)}>{normalizePath(destination) === normalizePath(vault) ? name : displayWorkspacePath(destination, vault)}</strong></div><p className="move-warning">Links in other notes won’t be updated automatically.</p>
    <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={normalizePath(destination) === normalizePath(current)}>Move here</button></div>
  </form></div>;
}
