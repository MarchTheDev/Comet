import { useState, type FormEvent } from "react";
import { Check, Plus, Tag, Trash2, X } from "lucide-react";
import { fileName } from "./utils/vault";
import { itemMeta, type WorkspaceMeta } from "./utils/workspaceMeta";

interface Props {
  metadata: WorkspaceMeta;
  target: string | null;
  onClose: () => void;
  onCreate: (name: string, color: string) => string;
  onToggle: (path: string, id: string) => void;
  onDelete: (id: string) => void;
  onSearch: (name: string) => void;
}
export function TagDialog({ metadata, target, onClose, onCreate, onToggle, onDelete, onSearch }: Props) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#83b8ca");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState("");
  const selected = target ? itemMeta(metadata, target).tags : [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = onCreate(name, color);
    setError(message);
    if (!message) setName("");
  };
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal tag-modal" role="dialog" aria-modal="true" aria-labelledby="tag-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-icon"><Tag size={20} /></div><button className="modal-close icon-button" type="button" aria-label="Close tags" onClick={onClose}><X size={18} /></button>
      <h2 id="tag-title">{target ? "Tag this item" : "Manage tags"}</h2><p>{target ? <>Choose tags for <strong>{fileName(target)}</strong>.</> : "Create tags, then attach them to files or folders using their menu."} Tags and organization are saved on this device.</p>
      <form className="tag-create" onSubmit={submit}><input autoFocus aria-label="Tag name" value={name} onChange={(event) => { setName(event.target.value); setError(""); }} maxLength={40} placeholder="New tag name" /><input type="color" aria-label="Tag color" value={color} onChange={(event) => setColor(event.target.value)} /><button className="primary-button" type="submit"><Plus size={15} /> Add</button></form>
      {error && <div className="dialog-error" role="alert">{error}</div>}
      <div className="tag-list">{metadata.tags.length ? metadata.tags.map((tag) => <div className="tag-list-row" key={tag.id}>
        <button type="button" className="tag-choice" onClick={() => target ? onToggle(target, tag.id) : onSearch(tag.name)}><span className="tag-dot" style={{ background: tag.color }} /><strong>{tag.name}</strong>{target && selected.includes(tag.id) && <Check size={16} />}</button>
        {deleting === tag.id ? <><button type="button" className="tag-delete-confirm" onClick={() => { onDelete(tag.id); setDeleting(""); }}>Delete tag</button><button type="button" className="icon-button" aria-label="Cancel delete tag" onClick={() => setDeleting("")}><X size={15} /></button></> : <button type="button" className="icon-button" aria-label={`Delete tag ${tag.name}`} onClick={() => setDeleting(tag.id)}><Trash2 size={15} /></button>}
      </div>) : <div className="tag-empty">No tags yet. Create your first one above.</div>}</div>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Done</button></div>
    </div>
  </div>;
}
