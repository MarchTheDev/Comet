import { Search, Tag, X } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { displayEntryName, type Entry, type SearchHit } from "./utils/vault";
import type { WorkspaceTag } from "./utils/workspaceMeta";

interface Props {
  query: string;
  results: SearchHit[];
  searching: boolean;
  entries: Entry[];
  tags: WorkspaceTag[];
  onQuery: (query: string) => void;
  onOpen: (entry: Entry) => void;
  onClose: () => void;
}
export function SearchDialog({ query, results, searching, entries, tags, onQuery, onOpen, onClose }: Props) {
  const lookup = new Map(entries.map((entry) => [entry.path, entry]));
  return <div className="modal-backdrop search-backdrop" onMouseDown={onClose}>
    <div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search workspace" onMouseDown={(event) => event.stopPropagation()}>
      <div className="search-dialog-input"><Search size={20} /><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search files, contents, and tags…" aria-label="Search workspace" spellCheck={false} /><button className="icon-button" type="button" aria-label="Close search" onClick={onClose}><X size={18} /></button></div>
      <div className="search-dialog-results" aria-live="polite">
        {!query.trim() ? <><span className="search-section-label">FIND ANYTHING</span><p>Search by name, note content, or tag. Type <strong>#</strong> before a tag to narrow your search.</p>{tags.length > 0 && <div className="search-tag-chips">{tags.map((tag) => <button type="button" key={tag.id} onClick={() => onQuery(`#${tag.name}`)}><Tag size={13} style={{ color: tag.color }} /> {tag.name}</button>)}</div>}</> : searching ? <p>Searching your workspace…</p> : results.length === 0 ? <p>No matches yet. Try a different search.</p> : <><span className="search-section-label">{results.length} {results.length === 1 ? "RESULT" : "RESULTS"}</span>{results.map((result) => {
          const entry = lookup.get(result.path);
          if (!entry) return null;
          return <button className="search-dialog-result" type="button" key={result.path} onClick={() => onOpen(entry)}><span><FileIcon entry={entry} size={18} /></span><span><strong>{displayEntryName(result.name)}</strong><small>{result.snippet}</small></span></button>;
        })}</>}
      </div>
      <div className="search-dialog-footer"><span>Search stays on this device</span><kbd>ESC</kbd></div>
    </div>
  </div>;
}
