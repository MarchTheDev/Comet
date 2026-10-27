import { Folder, Grid2X2, List, MoreHorizontal, Pin, Plus, SlidersHorizontal, Star } from "lucide-react";
import { FileIcon } from "./FileIcon";
import type { CSSProperties, DragEvent, MouseEvent } from "react";
import { fileKind, fileKindLabel } from "./utils/fileTypes";
import { itemMeta, type WorkspaceMeta } from "./utils/workspaceMeta";
import { noteTitle, displayEntryName, parentPath, relativePath, type Entry } from "./utils/vault";

export type WorkspaceLayout = "list" | "gallery";
interface Props {
  title: string;
  description: string;
  entries: Entry[];
  vault: string;
  destination: string;
  metadata: WorkspaceMeta;
  layout: WorkspaceLayout;
  iconSize: number;
  onLayout: (layout: WorkspaceLayout) => void;
  onIconSize: (size: number) => void;
  onOpen: (event: MouseEvent, entry: Entry) => void;
  selectedPaths: Set<string>;
  onMenu: (event: MouseEvent, entry: Entry) => void;
  onBackgroundMenu: (event: MouseEvent, folder: string) => void;
  onCreate: (event: MouseEvent, folder: string) => void;
  onDragStart: (event: DragEvent, entry: Entry) => void;
  onDrop: (event: DragEvent, folder: string) => void;
  onDragOver: (event: DragEvent, folder: string) => void;
  dropFolder: string;
}

export function WorkspacePanel({ title, description, entries, vault, destination, metadata, layout, iconSize, onLayout, onIconSize, onOpen, selectedPaths, onMenu, onBackgroundMenu, onCreate, onDragStart, onDragOver, onDrop, dropFolder }: Props) {
  return <section className={`overview-card workspace-panel${dropFolder === destination ? " drop-target" : ""}`} aria-label={title} data-drop-folder={destination}
    onContextMenu={(event) => { if (!(event.target as Element).closest(".workspace-entry")) onBackgroundMenu(event, destination); }}
    onDragOver={(event) => onDragOver(event, destination)} onDrop={(event) => onDrop(event, destination)}>
    <div className="overview-heading workspace-heading">
      <div><span className="section-eyebrow">YOUR WORKSPACE</span><h2>{title}</h2><p>{description}</p></div>
      <button className="primary-button overview-create" type="button" onClick={(event) => onCreate(event, destination)}><Plus size={16} /> New</button>
    </div>
    <div className="workspace-controls">
      <span className="workspace-count">{entries.length} {entries.length === 1 ? "item" : "items"}</span>
      <label className="workspace-size" title="Adjust file icon size"><SlidersHorizontal size={14} /><span>Size</span><input type="range" min="24" max="72" step="4" value={iconSize} aria-label="File icon size" onChange={(event) => onIconSize(Number(event.target.value))} /></label>
      <div className="layout-toggle" role="group" aria-label="Workspace view">
        <button type="button" aria-label="List view" aria-pressed={layout === "list"} onClick={() => onLayout("list")}><List size={16} /></button>
        <button type="button" aria-label="Gallery view" aria-pressed={layout === "gallery"} onClick={() => onLayout("gallery")}><Grid2X2 size={16} /></button>
      </div>
    </div>
    {entries.length ? <div className={layout === "list" ? "file-list" : "file-gallery"} style={{ "--file-icon-size": `${iconSize}px`, "--file-tile-width": `${Math.max(140, iconSize + 90)}px` } as CSSProperties}>
      {entries.map((entry) => {
        const details = itemMeta(metadata, entry.path);
        const tags = metadata.tags.filter((tag) => details.tags.includes(tag.id));
        const label = entry.kind === "folder" ? entry.name : fileKind(entry.path) === "markdown" ? noteTitle(entry.name) : displayEntryName(entry.name);
        return <div key={entry.path} className={`workspace-entry${entry.kind === "folder" && dropFolder === entry.path ? " drop-target" : ""}${selectedPaths.has(entry.path) ? " multi-selected" : ""}`} draggable onDragStart={(event) => onDragStart(event, entry)} onContextMenu={(event) => onMenu(event, entry)} data-path={entry.path} data-drop-folder={entry.kind === "folder" ? entry.path : undefined}
          onDragOver={entry.kind === "folder" ? (event) => onDragOver(event, entry.path) : undefined}
          onDrop={entry.kind === "folder" ? (event) => { event.stopPropagation(); onDrop(event, entry.path); } : undefined}>
          <button className="workspace-entry-open" type="button" aria-pressed={selectedPaths.has(entry.path)} onClick={(event) => onOpen(event, entry)}>
            <span className={`workspace-entry-icon ${entry.kind === "folder" ? "folder" : fileKind(entry.path)}`}><FileIcon entry={entry} size={iconSize} /></span>
            <span className="workspace-entry-copy"><strong title={entry.name}>{label}</strong><small>{entry.kind === "folder" ? "Folder" : fileKindLabel(entry.path)}{layout === "list" && ` · ${parentPath(entry.path) === vault ? "Workspace" : relativePath(parentPath(entry.path), vault)}`}</small>{tags.length > 0 && <span className="entry-tags">{tags.slice(0, 3).map((tag) => <span className="entry-tag" key={tag.id} style={{ "--tag-color": tag.color } as CSSProperties}>{tag.name}</span>)}</span>}</span>
            <span className="entry-badges">{details.pinned && <Pin size={13} aria-label="Pinned" />}{details.favorite && <Star size={14} aria-label="Favorite" />}</span>
          </button>
          <button className="workspace-entry-more icon-button" type="button" aria-label={`More options for ${entry.name}`} onClick={(event) => onMenu(event, entry)}><MoreHorizontal size={18} /></button>
        </div>;
      })}
    </div> : <div className="overview-empty workspace-blank"><div className="overview-empty-icon"><Folder size={24} /></div><h3>Nothing here yet</h3><p>Create a file, add a folder, or drop something here to get started.</p><button type="button" className="secondary-button" onClick={(event) => onCreate(event, destination)}><Plus size={15} /> Add something</button></div>}
    <div className="workspace-drop-hint workspace-blank">Drop files or web links here to add them · Right-click for more options</div>
  </section>;
}
