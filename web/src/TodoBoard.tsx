import { useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, GripVertical, ListChecks, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { ColorMenu } from "./ColorMenu";
import { todoId, TODO_MAX_COORD, type TodoDocument, type TodoTask } from "./utils/todo";
import type { SaveState } from "./utils/saveQueue";

interface Props { board: TodoDocument; name: string; saveState: SaveState; onChange: (board: TodoDocument) => boolean; onRetry: () => void }
type Point = { x: number; y: number };
type LinkDraft = { from: string; end: Point };
const CARD_WIDTH = 270;
const clamp = (value: number) => Math.max(0, Math.min(TODO_MAX_COORD, Math.round(value)));

export function TodoBoard({ board, name, saveState, onChange, onRetry }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [selectedLink, setSelectedLink] = useState("");
  const [deleteTask, setDeleteTask] = useState("");
  const [deleteCategory, setDeleteCategory] = useState("");
  const [showCategories, setShowCategories] = useState(false);

  const updateTask = (id: string, patch: Partial<TodoTask>) => onChange({ ...board, tasks: board.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) });
  const addTask = (event: FormEvent) => {
    event.preventDefault(); const text = draft.trim(); if (!text) return;
    const element = stage.current;
    const columns = Math.max(1, Math.floor(((element?.clientWidth ?? 400) - 30) / 300));
    const x = clamp((element?.scrollLeft ?? 0) + 30 + (board.tasks.length % columns) * 300);
    const y = clamp((element?.scrollTop ?? 0) + 45 + Math.floor(board.tasks.length / columns) * 160);
    if (onChange({ ...board, tasks: [...board.tasks, { id: todoId(), text, done: false, notes: "", x, y, categoryId: null }] })) setDraft("");
  };
  const startMove = (event: ReactPointerEvent<HTMLButtonElement>, task: TodoTask) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const pointer = event.pointerId, sx = event.clientX, sy = event.clientY;
    let next = { x: task.x, y: task.y }, moving = false;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (!moving && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
      moving = true; next = { x: clamp(task.x + e.clientX - sx), y: clamp(task.y + e.clientY - sy) };
      setPositions({ [task.id]: next });
    };
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel); };
    const end = (e: PointerEvent) => { if (e.pointerId !== pointer) return; cleanup(); if (moving) updateTask(task.id, next); setPositions({}); };
    const cancel = (e: PointerEvent) => { if (e.pointerId !== pointer) return; cleanup(); setPositions({}); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", cancel);
  };
  const startLink = (event: ReactPointerEvent<HTMLButtonElement>, task: TodoTask) => {
    if (event.button !== 0 || !stage.current) return;
    event.preventDefault(); event.stopPropagation();
    const pointer = event.pointerId, surface = stage.current;
    const point = (e: PointerEvent): Point => { const rect = surface.getBoundingClientRect(); return { x: clamp(e.clientX - rect.left + surface.scrollLeft), y: clamp(e.clientY - rect.top + surface.scrollTop) }; };
    setLinkDraft({ from: task.id, end: { x: task.x + CARD_WIDTH + 12, y: task.y + 46 } });
    const move = (e: PointerEvent) => { if (e.pointerId === pointer) setLinkDraft({ from: task.id, end: point(e) }); };
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel); setLinkDraft(null); };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-todo-id]")?.dataset.todoId;
      cleanup();
      if (target && target !== task.id && board.tasks.some((item) => item.id === target) && !board.connections.some((edge) => edge.from === task.id && edge.to === target)) {
        onChange({ ...board, connections: [...board.connections, { from: task.id, to: target }] });
      }
    };
    const cancel = (e: PointerEvent) => { if (e.pointerId === pointer) cleanup(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", cancel);
  };
  const location = (task: TodoTask): Point => positions[task.id] ?? { x: task.x, y: task.y };
  const dimensions = board.tasks.reduce((size, task) => { const point = location(task); return { width: Math.max(size.width, point.x + 420), height: Math.max(size.height, point.y + 400) }; }, { width: 1800, height: 1100 });
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  const path = (from: Point, to: Point) => { const dx = Math.max(65, Math.abs(to.x - from.x) * .42); return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`; };
  const lineStart = (task: TodoTask) => { const p = location(task); return { x: p.x + CARD_WIDTH, y: p.y + 46 }; };
  const lineEnd = (task: TodoTask) => { const p = location(task); return { x: p.x, y: p.y + 46 }; };
  return <section className="todo-board" aria-labelledby="todo-title">
    <div className="todo-header"><div className="explore-heading-icon"><ListChecks size={20} /></div><div><span className="section-eyebrow">YOUR TO-DO BOARD</span><h2 id="todo-title">{name}</h2><p>A little room to arrange your ideas.</p></div><span className="todo-header-spacer" /><div className={`save-indicator ${saveState}`} role="status">{saveState === "error" ? <AlertCircle size={15} /> : saveState === "saving" ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}<span>{saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved changes" : "Saved"}</span>{saveState === "error" && <button type="button" onClick={onRetry}>Retry</button>}</div></div>
    <div className="todo-toolbar">
      <form className="todo-create" onSubmit={addTask}><input aria-label="New to-do" maxLength={500} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="What needs doing?" /><button className="primary-button" type="submit" disabled={!draft.trim() || board.tasks.length >= 5000}><Plus size={15} /> Add to-do</button></form>
      <button type="button" className="secondary-button" aria-expanded={showCategories} onClick={() => setShowCategories((value) => !value)}>Categories {board.categories.length > 0 && <span className="todo-category-count">{board.categories.length}</span>}</button>
    </div>
    {showCategories && <div className="todo-category-panel"><div><strong>Categories</strong><small>Give tasks a little structure without fixing them in place.</small></div><div className="todo-category-list">{board.categories.map((category) => <div className="todo-category" key={category.id} style={{ "--list-color": category.color } as CSSProperties}><span className="todo-lane-dot" /><input aria-label="Category name" maxLength={120} value={category.title} onChange={(event) => onChange({ ...board, categories: board.categories.map((item) => item.id === category.id ? { ...item, title: event.target.value } : item) })} /><ColorMenu color={category.color} label={`Color for ${category.title || "category"}`} onChange={(color) => onChange({ ...board, categories: board.categories.map((item) => item.id === category.id ? { ...item, color } : item) })} />{deleteCategory === category.id ? <><button type="button" className="todo-delete-confirm" onClick={() => { if (onChange({ ...board, categories: board.categories.filter((item) => item.id !== category.id), tasks: board.tasks.map((task) => task.categoryId === category.id ? { ...task, categoryId: null } : task), legacyListConnections: board.legacyListConnections.filter((edge) => edge.from !== category.id && edge.to !== category.id) })) setDeleteCategory(""); }}>Remove</button><button type="button" aria-label="Cancel removing category" onClick={() => setDeleteCategory("")}><X size={13} /></button></> : <button type="button" aria-label={`Remove ${category.title || "category"}`} onClick={() => setDeleteCategory(category.id)}><Trash2 size={14} /></button>}</div>)}</div><button type="button" className="secondary-button" disabled={board.categories.length >= 100} onClick={() => onChange({ ...board, categories: [...board.categories, { id: todoId(), title: `Category ${board.categories.length + 1}`, color: "#9c9fe1" }] })}><Plus size={14} /> Add category</button></div>}
    <div className="todo-canvas-help"><span>Drag the canvas to look around. Use a card’s grip to move it; drag its dot onto another card to connect them.</span>{board.legacyListConnections.length > 0 && <span>Earlier list connections are preserved in this file.</span>}</div>
    <div ref={stage} className={`todo-canvas${panning ? " panning" : ""}${linkDraft ? " connecting" : ""}`} aria-label="To-do canvas" onPointerDown={(event) => {
      if (event.button !== 0 || (event.target as Element).closest(".todo-card, .todo-link-remove, .todo-link-hit")) return;
      const el = event.currentTarget; pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop }; setPanning(true); el.setPointerCapture(event.pointerId);
    }} onPointerMove={(event) => { const drag = pan.current; if (!drag || drag.pointer !== event.pointerId) return; event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x); event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y); }} onPointerUp={() => { pan.current = null; setPanning(false); }} onPointerCancel={() => { pan.current = null; setPanning(false); }}>
      <div className="todo-canvas-inner" style={{ width: dimensions.width, height: dimensions.height }}>
        <svg className="todo-connections-svg" width={dimensions.width} height={dimensions.height} aria-label="To-do connections"><defs><marker id="task-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" /></marker></defs>
          {board.connections.map((edge) => { const from = byId.get(edge.from), to = byId.get(edge.to); if (!from || !to) return null; const d = path(lineStart(from), lineEnd(to)); const key = `${edge.from}:${edge.to}`; return <g key={key} className={selectedLink === key ? "selected" : ""}><path d={d} className="todo-link-hit" onClick={() => setSelectedLink(key)} /><path d={d} className="todo-link-line" markerEnd="url(#task-arrow)" /></g>; })}
          {linkDraft && byId.has(linkDraft.from) && <path className="todo-link-preview" d={path(lineStart(byId.get(linkDraft.from)!), linkDraft.end)} markerEnd="url(#task-arrow)" />}
        </svg>
        {board.connections.map((edge) => { const from = byId.get(edge.from), to = byId.get(edge.to), key = `${edge.from}:${edge.to}`; if (!from || !to || selectedLink !== key) return null; const a = lineStart(from), b = lineEnd(to); return <button type="button" className="todo-link-remove" style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 }} key={key} aria-label={`Remove connection from ${from.text} to ${to.text}`} onClick={() => { onChange({ ...board, connections: board.connections.filter((item) => item.from !== edge.from || item.to !== edge.to) }); setSelectedLink(""); }}><X size={14} /></button>; })}
        {board.tasks.map((task) => { const category = board.categories.find((item) => item.id === task.categoryId), point = location(task); return <article className={`todo-card${task.done ? " done" : ""}`} data-todo-id={task.id} key={task.id} style={{ left: point.x, top: point.y, "--list-color": category?.color ?? "var(--accent)" } as CSSProperties}>
          <div className="todo-card-heading"><button type="button" className="todo-card-grip" aria-label={`Drag ${task.text || "to-do"}`} title="Drag to move" onPointerDown={(event) => startMove(event, task)}><GripVertical size={15} /></button><span className="todo-card-category">{category?.title || "TO-DO"}</span><button type="button" aria-expanded={expanded.has(task.id)} aria-label={`${expanded.has(task.id) ? "Hide" : "Show"} notes for ${task.text || "to-do"}`} onClick={() => setExpanded((previous) => { const next = new Set(previous); if (next.has(task.id)) next.delete(task.id); else next.add(task.id); return next; })}>{expanded.has(task.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button></div>
          <div className="todo-card-main"><input type="checkbox" checked={task.done} aria-label={`Complete ${task.text || "to-do"}`} onChange={(event) => updateTask(task.id, { done: event.target.checked })} /><input className="todo-task-text" maxLength={500} value={task.text} aria-label="Task name" onChange={(event) => updateTask(task.id, { text: event.target.value })} /></div>
          {expanded.has(task.id) && <div className="todo-card-detail"><label>Notes<textarea maxLength={200000} aria-label={`Notes for ${task.text || "to-do"}`} value={task.notes} onChange={(event) => updateTask(task.id, { notes: event.target.value })} placeholder="Add details, links, or context…" /></label><div className="todo-task-actions"><label>Category <select aria-label={`Category for ${task.text || "to-do"}`} value={task.categoryId ?? ""} onChange={(event) => updateTask(task.id, { categoryId: event.target.value || null })}><option value="">No category</option>{board.categories.map((item) => <option key={item.id} value={item.id}>{item.title || "Untitled category"}</option>)}</select></label>{deleteTask === task.id ? <><button type="button" className="todo-delete-confirm" onClick={() => { if (onChange({ ...board, tasks: board.tasks.filter((item) => item.id !== task.id), connections: board.connections.filter((edge) => edge.from !== task.id && edge.to !== task.id) })) setDeleteTask(""); }}>Delete</button><button type="button" aria-label="Cancel deleting to-do" onClick={() => setDeleteTask("")}><X size={13} /></button></> : <button type="button" aria-label={`Delete ${task.text || "to-do"}`} onClick={() => setDeleteTask(task.id)}><Trash2 size={14} /></button>}</div></div>}
          <button type="button" className="todo-connect-dot" aria-label={`Connect ${task.text || "to-do"} to another to-do`} title="Drag to another to-do" onPointerDown={(event) => startLink(event, task)} />
        </article>; })}
        {!board.tasks.length && <div className="todo-canvas-empty"><ListChecks size={26} /><strong>A blank canvas for your to-dos</strong><span>Add a to-do above, then drag it wherever it belongs.</span></div>}
      </div>
    </div>
  </section>;
}
