import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, GripVertical, ListChecks, LoaderCircle, Minus, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import { ColorMenu } from "./ColorMenu";
import { todoId, TODO_CONNECTION_COLOR, TODO_MAX_COORD, type TodoDocument, type TodoTask } from "./utils/todo";
import { connectionGeometry, type Point } from "./utils/todoGeometry";
import type { SaveState } from "./utils/saveQueue";

interface Props { board: TodoDocument; name: string; saveState: SaveState; arrowheads?: boolean; onChange: (board: TodoDocument) => boolean; onRetry: () => void }
type LinkDraft = { from: string; end: Point };
const CARD_WIDTH = 270;
const connectionKey = (from: string, to: string) => JSON.stringify([from, to]);
const clamp = (value: number) => Math.max(0, Math.min(TODO_MAX_COORD, Math.round(value)));
const scaleOf = (element: HTMLElement) => element.offsetWidth ? element.getBoundingClientRect().width / element.offsetWidth || 1 : 1;

export function TodoBoard({ board, name, saveState, arrowheads = false, onChange, onRetry }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);
  const zoomRef = useRef(1);
  const activeDrag = useRef<(() => void) | null>(null);
  const zoomAnchor = useRef<{ x: number; y: number; worldX: number; worldY: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const [moving, setMoving] = useState(false);
  const [draft, setDraft] = useState("");
  const [subDrafts, setSubDrafts] = useState<Record<string, string>>({});
  const [addingItem, setAddingItem] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [selectedLink, setSelectedLink] = useState("");
  const [deleteTask, setDeleteTask] = useState("");
  const [deleteCategory, setDeleteCategory] = useState("");
  const [showCategories, setShowCategories] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => () => { activeDrag.current?.(); document.documentElement.classList.remove("todo-dragging"); }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menu]);
  // Cards may change height when entries or notes are expanded. Keep lines on
  // the actual edges instead of assuming every card has the same height.
  useEffect(() => {
    const cards = Array.from(stage.current?.querySelectorAll<HTMLElement>("[data-todo-id]") ?? []);
    const measure = () => setHeights((previous) => {
      const next = { ...previous }; let changed = false;
      cards.forEach((card) => { const id = card.dataset.todoId; const height = card.offsetHeight; if (id && height && next[id] !== height) { next[id] = height; changed = true; } });
      return changed ? next : previous;
    });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [board.tasks, expanded, addingItem]);
  useLayoutEffect(() => {
    const element = stage.current, anchor = zoomAnchor.current; if (!element || !anchor) return;
    element.scrollLeft = anchor.worldX * zoom - anchor.x; element.scrollTop = anchor.worldY * zoom - anchor.y; zoomAnchor.current = null;
  }, [zoom]);
  const changeZoom = (value: number, cursor?: Point) => {
    const element = stage.current; if (!element) return;
    const next = Math.max(.35, Math.min(2, Math.round(value * 100) / 100));
    if (next === zoomRef.current) return;
    const x = cursor?.x ?? element.clientWidth / 2, y = cursor?.y ?? element.clientHeight / 2;
    zoomAnchor.current = { x, y, worldX: (element.scrollLeft + x) / zoomRef.current, worldY: (element.scrollTop + y) / zoomRef.current };
    zoomRef.current = next; setZoom(next);
  };
  useEffect(() => {
    const element = stage.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); const rect = element.getBoundingClientRect(), scale = scaleOf(element);
      changeZoom(zoomRef.current * (event.deltaY < 0 ? 1.12 : 1 / 1.12), { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale });
    };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, []);

  const updateTask = (id: string, patch: Partial<TodoTask>) => onChange({ ...board, tasks: board.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) });
  const addTask = (event: FormEvent) => {
    event.preventDefault(); const text = draft.trim(); if (!text || board.tasks.length >= 5000) return;
    const element = stage.current;
    const originX = clamp((element?.scrollLeft ?? 0) / zoomRef.current + 35);
    const originY = clamp((element?.scrollTop ?? 0) / zoomRef.current + 45);
    const columns = Math.max(1, Math.floor(((element?.clientWidth ?? 400) / zoomRef.current - 40) / 360));
    let x = originX, y = originY;
    // Find a generous empty slot, including the height of expanded cards.
    for (let index = 0; index < 6000; index++) {
      x = clamp(originX + (index % columns) * 360); y = clamp(originY + Math.floor(index / columns) * 250);
      if (!board.tasks.some((task) => x < task.x + CARD_WIDTH + 70 && x + CARD_WIDTH + 70 > task.x && y < task.y + (heights[task.id] ?? 95) + 70 && y + 165 > task.y)) break;
    }
    if (onChange({ ...board, tasks: [...board.tasks, { id: todoId(), text, done: false, notes: "", x, y, categoryId: null, subtasks: [] }] })) setDraft("");
  };
  const startMove = (event: ReactPointerEvent<HTMLButtonElement>, task: TodoTask) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); window.getSelection()?.removeAllRanges();
    activeDrag.current?.(); document.documentElement.classList.add("todo-dragging"); setMoving(true);
    const pointer = event.pointerId, sx = event.clientX, sy = event.clientY, scale = stage.current ? scaleOf(stage.current) * zoomRef.current : 1;
    let next = { x: task.x, y: task.y }, didMove = false;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (!didMove && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
      didMove = true; next = { x: clamp(task.x + (e.clientX - sx) / scale), y: clamp(task.y + (e.clientY - sy) / scale) };
      setPositions({ [task.id]: next });
    };
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel); document.documentElement.classList.remove("todo-dragging"); activeDrag.current = null; setMoving(false); };
    const end = (e: PointerEvent) => { if (e.pointerId !== pointer) return; cleanup(); if (didMove) updateTask(task.id, next); setPositions({}); };
    const cancel = (e: PointerEvent) => { if (e.pointerId !== pointer) return; cleanup(); setPositions({}); };
    activeDrag.current = cleanup;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", cancel);
  };
  const startLink = (event: ReactPointerEvent<HTMLButtonElement>, task: TodoTask) => {
    if (event.button !== 0 || !stage.current) return;
    event.preventDefault(); event.stopPropagation(); window.getSelection()?.removeAllRanges(); activeDrag.current?.();
    const pointer = event.pointerId, surface = stage.current;
    const point = (e: PointerEvent): Point => { const rect = surface.getBoundingClientRect(), scale = scaleOf(surface); return { x: clamp(((e.clientX - rect.left) / scale + surface.scrollLeft) / zoomRef.current), y: clamp(((e.clientY - rect.top) / scale + surface.scrollTop) / zoomRef.current) }; };
    setLinkDraft({ from: task.id, end: { x: task.x + CARD_WIDTH + 12, y: task.y + 46 } });
    const move = (e: PointerEvent) => { if (e.pointerId === pointer) setLinkDraft({ from: task.id, end: point(e) }); };
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel); activeDrag.current = null; setLinkDraft(null); };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-todo-id]")?.dataset.todoId;
      cleanup();
      if (target && target !== task.id && board.tasks.some((item) => item.id === target) && !board.connections.some((edge) => edge.from === task.id && edge.to === target)) {
        onChange({ ...board, connections: [...board.connections, { from: task.id, to: target, color: TODO_CONNECTION_COLOR }] });
      }
    };
    const cancel = (e: PointerEvent) => { if (e.pointerId === pointer) cleanup(); };
    activeDrag.current = cleanup;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", cancel);
  };
  const location = (task: TodoTask): Point => positions[task.id] ?? { x: task.x, y: task.y };
  const rectFor = (task: TodoTask) => ({ ...location(task), width: CARD_WIDTH, height: heights[task.id] ?? 94 });
  const dimensions = board.tasks.reduce((size, task) => { const point = location(task); return { width: Math.max(size.width, point.x + 420), height: Math.max(size.height, point.y + (heights[task.id] ?? 94) + 250) }; }, { width: 1800, height: 1100 });
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  const openMenu = (event: ReactMouseEvent, task: TodoTask) => {
    event.preventDefault(); event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect(); const scale = Number(document.documentElement.style.zoom) || 1;
    setMenu({ id: task.id, x: Math.max(8, Math.min(event.clientX || bounds.right, window.innerWidth - 205 * scale)) / scale, y: Math.max(8, Math.min(event.clientY || bounds.bottom, window.innerHeight - 200 * scale)) / scale });
  };
  const menuTask = menu ? byId.get(menu.id) : null;
  const reveal = (id: string) => setExpanded((previous) => new Set(previous).add(id));
  return <section className="todo-board" aria-labelledby="todo-title">
    <div className="todo-header"><div className="explore-heading-icon"><ListChecks size={20} /></div><div><span className="section-eyebrow">YOUR TO-DO BOARD</span><h2 id="todo-title">{name}</h2><p>A little room to arrange your ideas.</p></div><span className="todo-header-spacer" /><div className={`save-indicator ${saveState}`} role="status">{saveState === "error" ? <AlertCircle size={15} /> : saveState === "saving" ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}<span>{saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved changes" : "Saved"}</span>{saveState === "error" && <button type="button" onClick={onRetry}>Retry</button>}</div></div>
    <div className="todo-toolbar">
      <form className="todo-create" onSubmit={addTask}><input aria-label="New to-do" maxLength={500} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="What needs doing?" /><button className="primary-button" type="submit" disabled={!draft.trim() || board.tasks.length >= 5000}><Plus size={15} /> Add to-do</button></form>
      <button type="button" className="secondary-button" aria-expanded={showCategories} onClick={() => setShowCategories((value) => !value)}>Categories {board.categories.length > 0 && <span className="todo-category-count">{board.categories.length}</span>}</button>
      <div className="todo-zoom" aria-label="Board zoom controls"><button type="button" aria-label="Zoom board out" disabled={zoom <= .35} onClick={() => changeZoom(zoomRef.current / 1.2)}><Minus size={15} /></button><button type="button" className="todo-zoom-reset" aria-label="Reset board zoom" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button><button type="button" aria-label="Zoom board in" disabled={zoom >= 2} onClick={() => changeZoom(zoomRef.current * 1.2)}><Plus size={15} /></button></div>
    </div>
    {showCategories && <div className="todo-category-panel"><div><strong>Categories</strong><small>Give tasks a little structure without fixing them in place.</small></div><div className="todo-category-list">{board.categories.map((category) => <div className="todo-category" key={category.id} style={{ "--list-color": category.color } as CSSProperties}><span className="todo-lane-dot" /><input aria-label="Category name" maxLength={120} value={category.title} onChange={(event) => onChange({ ...board, categories: board.categories.map((item) => item.id === category.id ? { ...item, title: event.target.value } : item) })} /><ColorMenu color={category.color} label={`Color for ${category.title || "category"}`} onChange={(color) => onChange({ ...board, categories: board.categories.map((item) => item.id === category.id ? { ...item, color } : item) })} />{deleteCategory === category.id ? <><button type="button" className="todo-delete-confirm" onClick={() => { if (onChange({ ...board, categories: board.categories.filter((item) => item.id !== category.id), tasks: board.tasks.map((task) => task.categoryId === category.id ? { ...task, categoryId: null } : task), legacyListConnections: board.legacyListConnections.filter((edge) => edge.from !== category.id && edge.to !== category.id) })) setDeleteCategory(""); }}>Remove</button><button type="button" aria-label="Cancel removing category" onClick={() => setDeleteCategory("")}><X size={13} /></button></> : <button type="button" aria-label={`Remove ${category.title || "category"}`} onClick={() => setDeleteCategory(category.id)}><Trash2 size={14} /></button>}</div>)}</div><button type="button" className="secondary-button" disabled={board.categories.length >= 100} onClick={() => onChange({ ...board, categories: [...board.categories, { id: todoId(), title: `Category ${board.categories.length + 1}`, color: "#9c9fe1" }] })}><Plus size={14} /> Add category</button></div>}
    <div className="todo-canvas-help"><span>Drag the canvas to look around; Ctrl + scroll zooms. Move a card by its grip, or drag its dot to connect.</span>{board.legacyListConnections.length > 0 && <span>Earlier list connections are preserved in this file.</span>}</div>
    <div ref={stage} className={`todo-canvas${panning ? " panning" : ""}${moving ? " moving" : ""}${linkDraft ? " connecting" : ""}`} aria-label="To-do canvas" onPointerDown={(event) => {
      if (event.button !== 0 || (event.target as Element).closest(".todo-card, .todo-link-controls, .todo-link-hit")) return;
      event.preventDefault(); window.getSelection()?.removeAllRanges();
      const el = event.currentTarget; pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop }; setPanning(true); el.setPointerCapture(event.pointerId);
    }} onPointerMove={(event) => { const drag = pan.current; if (!drag || drag.pointer !== event.pointerId) return; const scale = scaleOf(event.currentTarget); event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x) / scale; event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y) / scale; }} onPointerUp={() => { pan.current = null; setPanning(false); }} onPointerCancel={() => { pan.current = null; setPanning(false); }}>
      <div className="todo-canvas-size" style={{ width: dimensions.width * zoom, height: dimensions.height * zoom }}><div className="todo-canvas-inner" style={{ width: dimensions.width, height: dimensions.height, transform: `scale(${zoom})`, transformOrigin: "top left" }}>
        <svg className="todo-connections-svg" width={dimensions.width} height={dimensions.height} aria-label="To-do connections"><defs>{board.connections.map((edge, index) => <marker key={index} id={`task-arrow-${index}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" style={{ fill: edge.color }} /></marker>)}<marker id="task-arrow-preview" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" /></marker></defs>
          {board.connections.map((edge, index) => { const from = byId.get(edge.from), to = byId.get(edge.to); if (!from || !to) return null; const { path } = connectionGeometry(rectFor(from), rectFor(to)); const key = connectionKey(edge.from, edge.to); return <g key={key} className={selectedLink === key ? "selected" : ""}><path d={path} className="todo-link-hit" role="button" tabIndex={0} aria-label={`Select connection from ${from.text} to ${to.text}`} onClick={() => setSelectedLink(key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedLink(key); } }} /><path d={path} className="todo-link-line" style={{ stroke: edge.color }} markerEnd={arrowheads ? `url(#task-arrow-${index})` : undefined} /></g>; })}
          {linkDraft && byId.has(linkDraft.from) && <path className="todo-link-preview" d={connectionGeometry(rectFor(byId.get(linkDraft.from)!), { ...linkDraft.end, width: 0, height: 0 }).path} markerEnd={arrowheads ? "url(#task-arrow-preview)" : undefined} />}
        </svg>
        {board.connections.map((edge) => { const from = byId.get(edge.from), to = byId.get(edge.to), key = connectionKey(edge.from, edge.to); if (!from || !to || selectedLink !== key) return null; const { from: a, to: b } = connectionGeometry(rectFor(from), rectFor(to)); return <div className="todo-link-controls" style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 }} key={key}><ColorMenu color={edge.color} label={`Color connection from ${from.text} to ${to.text}`} onChange={(color) => onChange({ ...board, connections: board.connections.map((item) => item.from === edge.from && item.to === edge.to ? { ...item, color } : item) })} /><button type="button" className="todo-link-remove" aria-label={`Remove connection from ${from.text} to ${to.text}`} onClick={() => { onChange({ ...board, connections: board.connections.filter((item) => item.from !== edge.from || item.to !== edge.to) }); setSelectedLink(""); }}><X size={14} /></button></div>; })}
        {board.tasks.map((task) => { const category = board.categories.find((item) => item.id === task.categoryId), point = location(task); return <article className={`todo-card${task.done ? " done" : ""}`} data-todo-id={task.id} key={task.id} style={{ left: point.x, top: point.y, "--list-color": category?.color ?? "var(--accent)" } as CSSProperties} onContextMenu={(event) => openMenu(event, task)}>
          <div className="todo-card-heading"><button type="button" className="todo-card-grip" aria-label={`Drag ${task.text || "to-do"}`} title="Drag to move" onPointerDown={(event) => startMove(event, task)}><GripVertical size={15} /></button><span className="todo-card-category">{category?.title || "TO-DO"}</span><button type="button" aria-label={`Options for ${task.text || "to-do"}`} title="To-do options" onClick={(event) => openMenu(event, task)}><MoreHorizontal size={16} /></button><button type="button" aria-expanded={expanded.has(task.id)} aria-label={`${expanded.has(task.id) ? "Hide" : "Show"} notes for ${task.text || "to-do"}`} onClick={() => setExpanded((previous) => { const next = new Set(previous); if (next.has(task.id)) next.delete(task.id); else next.add(task.id); return next; })}>{expanded.has(task.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button></div>
          <div className="todo-card-main"><input type="checkbox" checked={task.done} aria-label={`Complete ${task.text || "to-do"}`} onChange={(event) => updateTask(task.id, { done: event.target.checked })} /><input className="todo-task-text" maxLength={500} value={task.text} aria-label="Task name" onChange={(event) => updateTask(task.id, { text: event.target.value })} /></div>
          {task.subtasks.length > 0 && <div className="todo-subtasks">{task.subtasks.map((item) => <div className="todo-subtask" key={item.id}><input type="checkbox" aria-label={`Complete item ${item.text || "untitled"}`} checked={item.done} onChange={(event) => updateTask(task.id, { subtasks: task.subtasks.map((sub) => sub.id === item.id ? { ...sub, done: event.target.checked } : sub) })} /><input className={item.done ? "completed" : ""} aria-label="To-do item" maxLength={500} value={item.text} onChange={(event) => updateTask(task.id, { subtasks: task.subtasks.map((sub) => sub.id === item.id ? { ...sub, text: event.target.value } : sub) })} /><button type="button" aria-label={`Remove item ${item.text || "untitled"}`} onClick={() => updateTask(task.id, { subtasks: task.subtasks.filter((sub) => sub.id !== item.id) })}><X size={13} /></button></div>)}</div>}
          {addingItem === task.id ? <form className="todo-subtask-add" onSubmit={(event) => { event.preventDefault(); const text = (subDrafts[task.id] ?? "").trim(); if (text && task.subtasks.length < 100 && updateTask(task.id, { subtasks: [...task.subtasks, { id: todoId(), text, done: false }] })) setSubDrafts((previous) => ({ ...previous, [task.id]: "" })); }}><input autoFocus aria-label={`New item for ${task.text || "to-do"}`} maxLength={500} placeholder="Add an item…" value={subDrafts[task.id] ?? ""} onChange={(event) => setSubDrafts((previous) => ({ ...previous, [task.id]: event.target.value }))} /><button type="submit" aria-label="Add item" disabled={task.subtasks.length >= 100 || !(subDrafts[task.id] ?? "").trim()}><Plus size={14} /></button><button type="button" aria-label="Close add item" onClick={() => setAddingItem("")}><X size={13} /></button></form> : <button type="button" className="todo-add-item" disabled={task.subtasks.length >= 100} onClick={() => setAddingItem(task.id)}><Plus size={13} /> Add item</button>}
          {expanded.has(task.id) && <div className="todo-card-detail"><label>Notes<textarea maxLength={200000} aria-label={`Notes for ${task.text || "to-do"}`} value={task.notes} onChange={(event) => updateTask(task.id, { notes: event.target.value })} placeholder="Add details, links, or context…" /></label><div className="todo-task-actions"><label>Category <select aria-label={`Category for ${task.text || "to-do"}`} value={task.categoryId ?? ""} onChange={(event) => updateTask(task.id, { categoryId: event.target.value || null })}><option value="">No category</option>{board.categories.map((item) => <option key={item.id} value={item.id}>{item.title || "Untitled category"}</option>)}</select></label>{deleteTask === task.id ? <><button type="button" className="todo-delete-confirm" onClick={() => { if (onChange({ ...board, tasks: board.tasks.filter((item) => item.id !== task.id), connections: board.connections.filter((edge) => edge.from !== task.id && edge.to !== task.id) })) setDeleteTask(""); }}>Delete</button><button type="button" aria-label="Cancel deleting to-do" onClick={() => setDeleteTask("")}><X size={13} /></button></> : <button type="button" aria-label={`Delete ${task.text || "to-do"}`} onClick={() => setDeleteTask(task.id)}><Trash2 size={14} /></button>}</div></div>}
          <button type="button" className="todo-connect-dot" aria-label={`Connect ${task.text || "to-do"} to another to-do`} title="Drag to another to-do" onPointerDown={(event) => startLink(event, task)} />
        </article>; })}
        {!board.tasks.length && <div className="todo-canvas-empty"><ListChecks size={26} /><strong>A blank canvas for your to-dos</strong><span>Add a to-do above, then drag it wherever it belongs.</span></div>}
      </div></div>
    </div>
    {menu && menuTask && createPortal(<div className="todo-context-menu" role="menu" aria-label={`Options for ${menuTask.text || "to-do"}`} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
      <button role="menuitem" type="button" onClick={() => { updateTask(menuTask.id, { done: !menuTask.done }); setMenu(null); }}>{menuTask.done ? "Mark incomplete" : "Mark complete"}</button>
      <button role="menuitem" type="button" onClick={() => { setAddingItem(menuTask.id); setMenu(null); }}>Add item</button>
      <button role="menuitem" type="button" onClick={() => { reveal(menuTask.id); setMenu(null); }}>Edit notes & category</button>
      <button role="menuitem" type="button" className="danger" onClick={() => { reveal(menuTask.id); setDeleteTask(menuTask.id); setMenu(null); }}>Delete to-do…</button>
    </div>, document.body)}
  </section>;
}
