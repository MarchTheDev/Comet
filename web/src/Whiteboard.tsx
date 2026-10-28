import { AppSelect } from "./AppSelect";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { CheckCircle2, ChevronDown, Circle, Diamond, GripVertical, ImagePlus, ListChecks, LoaderCircle, Minus, PaintBucket, Pencil, Plus, RotateCcw, Square, Trash2, Triangle, Type, X } from "lucide-react";
import { ColorMenu } from "./ColorMenu";
import { ClearBoardDialog } from "./ClearBoardDialog";
import { connectionGeometry, type Point } from "./utils/todoGeometry";
import { TODO_MAX_COORD, todoId } from "./utils/todo";
import { newWhiteboardItem, TODO_CONNECTION_COLOR, type WhiteboardDocument, type WhiteboardItem, type WhiteboardItemType, type WhiteboardShape, type WhiteboardStroke } from "./utils/whiteboard";
import type { SaveState } from "./utils/saveQueue";

const clamp = (value: number) => Math.max(0, Math.min(TODO_MAX_COORD, Math.round(value)));
const strokePath = (points: Point[]) => points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ") + (points.length === 1 ? " l0.01 0" : "");
const shapeBounds = (start: Point, end: Point) => ({ x: clamp(Math.min(start.x, end.x)), y: clamp(Math.min(start.y, end.y)), width: Math.max(30, Math.min(1600, Math.abs(end.x - start.x))), height: Math.max(30, Math.min(1200, Math.abs(end.y - start.y))) });
function ShapeOutline({ shape }: { shape: WhiteboardShape }) {
  return shape === "ellipse" ? <ellipse cx="50" cy="50" rx="48" ry="47" /> : shape === "diamond" ? <polygon points="50,2 98,50 50,98 2,50" /> : shape === "triangle" ? <polygon points="50,3 98,96 2,96" /> : <rect x="2" y="2" width="96" height="96" rx="3" />;
}
const SHAPES: { value: WhiteboardShape; label: string; icon: typeof Square }[] = [
  { value: "rectangle", label: "Rectangle", icon: Square }, { value: "ellipse", label: "Ellipse", icon: Circle },
  { value: "diamond", label: "Diamond", icon: Diamond }, { value: "triangle", label: "Triangle", icon: Triangle },
];
const layerKey = (path: string) => `comet:whiteboard-layers:v1:${encodeURIComponent(path)}`;
function readLayers(path: string): string[] {
  if (!path) return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(layerKey(path)) || "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length <= 100))].slice(-1000) : [];
  } catch { return []; }
}
export function Whiteboard({ board, name, path = "", saveState, onChange, onRename, onRetry }: { board: WhiteboardDocument; name: string; path?: string; saveState: SaveState; onChange: (board: WhiteboardDocument) => boolean; onRename: () => void; onRetry: () => void }) {
  // Layer order is local display metadata, not a board edit. Opening or focusing
  // an old board must not rewrite it or upgrade its on-disk format.
  const [layers, setLayers] = useState<string[]>(() => readLayers(path));
  useEffect(() => { if (path) try { localStorage.setItem(layerKey(path), JSON.stringify(layers)); } catch { /* arrangement still works for this session */ } }, [path, layers]);
  const bringToFront = (id: string) => setLayers((previous) => {
    if (previous.at(-1) === id) return previous;
    const existing = new Set(latest.current.items.map((item) => item.id));
    return [...previous.filter((item) => item !== id && existing.has(item)), id].slice(-1000);
  });
  const stage = useRef<HTMLDivElement>(null), file = useRef<HTMLInputElement>(null), latest = useRef(board), cleanupDrag = useRef<(() => void) | null>(null);
  latest.current = board;
  const [zoom, setZoom] = useState(1), [positions, setPositions] = useState<Record<string, Point>>({}), [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [drawing, setDrawing] = useState<{ from: string; end: Point } | null>(null), [selected, setSelected] = useState(""), [deleting, setDeleting] = useState(""), [error, setError] = useState("");
  const [clearOpen, setClearOpen] = useState(false);
  const [shapeOpen, setShapeOpen] = useState(false), [shapeTool, setShapeTool] = useState<WhiteboardShape | null>(null), [pen, setPen] = useState(false), [penColor, setPenColor] = useState("#9c9fe1"), [penWidth, setPenWidth] = useState(4);
  const [draftShape, setDraftShape] = useState<{ shape: WhiteboardShape; start: Point; end: Point } | null>(null);
  const shapeRef = useRef<{ shape: WhiteboardShape; start: Point; end: Point } | null>(null);
  const [draftStroke, setDraftStroke] = useState<WhiteboardStroke | null>(null), strokeRef = useRef<WhiteboardStroke | null>(null);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const canvasPointer = useRef<number | null>(null);
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => () => cleanupDrag.current?.(), []);
  useEffect(() => {
    if (!shapeTool) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") { setShapeTool(null); setShapeOpen(false); if (shapeRef.current) { shapeRef.current = null; setDraftShape(null); canvasPointer.current = null; } } };
    window.addEventListener("keydown", cancel); return () => window.removeEventListener("keydown", cancel);
  }, [shapeTool]);
  useEffect(() => {
    const element = stage.current; if (!element) return;
    const wheel = (event: WheelEvent) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); setZoom(Math.max(.4, Math.min(2, zoomRef.current * (event.deltaY < 0 ? 1.12 : 1 / 1.12)))); };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, []);
  const point = (item: WhiteboardItem) => positions[item.id] ?? { x: item.x, y: item.y };
  const size = (item: WhiteboardItem) => sizes[item.id] ?? { width: item.width, height: item.height };
  const rect = (item: WhiteboardItem) => ({ ...point(item), ...size(item) });
  const dimensions = board.items.reduce((space, item) => ({ width: Math.max(space.width, point(item).x + size(item).width + 180), height: Math.max(space.height, point(item).y + size(item).height + 170) }), { width: 1800, height: 1100 });
  for (const stroke of board.strokes) for (const p of stroke.points) { dimensions.width = Math.max(dimensions.width, p.x + 100); dimensions.height = Math.max(dimensions.height, p.y + 100); }
  const commit = (next: WhiteboardDocument) => {
    if (!onChange(next)) { setError("This change exceeds the board's save limit. Your previous content is intact."); return false; }
    setError(""); return true;
  };
  const add = (type: WhiteboardItemType, image = "", shape: WhiteboardShape = "rectangle") => {
    const el = stage.current, scale = zoomRef.current, count = latest.current.items.length;
    const columns = Math.max(1, Math.floor(((el?.clientWidth ?? 800) / scale - 100) / 270));
    const x = clamp((el?.scrollLeft ?? 0) / scale + 80 + (count % columns) * 270), y = clamp((el?.scrollTop ?? 0) / scale + 80 + (Math.floor(count / columns) % 8) * 180);
    setPen(false); setShapeOpen(false); setShapeTool(null);
    commit({ ...latest.current, items: [...latest.current.items, newWhiteboardItem(type, x, y, image, shape)] });
  };
  const update = (id: string, patch: Partial<WhiteboardItem>) => commit({ ...latest.current, items: latest.current.items.map((item) => item.id === id ? { ...item, ...patch } : item) });
  const move = (event: ReactPointerEvent, item: WhiteboardItem) => {
    if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); cleanupDrag.current?.();
    const id = event.pointerId, sx = event.clientX, sy = event.clientY, scale = (stage.current?.offsetWidth ? stage.current.getBoundingClientRect().width / stage.current.offsetWidth || 1 : 1) * zoomRef.current;
    let next = { x: item.x, y: item.y }, moved = false;
    const moving = (e: PointerEvent) => { if (e.pointerId !== id) return; if (Math.hypot(e.clientX - sx, e.clientY - sy) < 3 && !moved) return; moved = true; next = { x: clamp(item.x + (e.clientX - sx) / scale), y: clamp(item.y + (e.clientY - sy) / scale) }; setPositions({ [item.id]: next }); };
    const cleanup = () => { window.removeEventListener("pointermove", moving); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel); cleanupDrag.current = null; };
    const end = (e: PointerEvent) => { if (e.pointerId !== id) return; cleanup(); if (moved) update(item.id, next); setPositions({}); };
    const cancel = (e: PointerEvent) => { if (e.pointerId === id) { cleanup(); setPositions({}); } };
    cleanupDrag.current = cleanup; window.addEventListener("pointermove", moving); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", cancel);
  };
  const resize = (event: ReactPointerEvent, item: WhiteboardItem) => {
    if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); cleanupDrag.current?.();
    const id = event.pointerId, sx = event.clientX, sy = event.clientY, scale = (stage.current?.offsetWidth ? stage.current.getBoundingClientRect().width / stage.current.offsetWidth || 1 : 1) * zoomRef.current;
    let next = { width: item.width, height: item.height }, moved = false;
    const moving = (e: PointerEvent) => { if (e.pointerId !== id) return; moved = true; next = { width: Math.max(item.type === "shape" ? 30 : 160, Math.min(1600, Math.round(item.width + (e.clientX - sx) / scale))), height: Math.max(item.type === "shape" ? 30 : 110, Math.min(1200, Math.round(item.height + (e.clientY - sy) / scale))) }; setSizes({ [item.id]: next }); };
    const cleanup = () => { window.removeEventListener("pointermove", moving); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel); cleanupDrag.current = null; };
    const end = (e: PointerEvent) => { if (e.pointerId !== id) return; cleanup(); if (moved) update(item.id, next); setSizes({}); };
    const cancel = (e: PointerEvent) => { if (e.pointerId === id) { cleanup(); setSizes({}); } };
    cleanupDrag.current = cleanup; window.addEventListener("pointermove", moving); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", cancel);
  };
  const canvasPoint = (clientX: number, clientY: number): Point => {
    const surface = stage.current; if (!surface) return { x: 0, y: 0 };
    const r = surface.getBoundingClientRect(), scale = surface.offsetWidth ? r.width / surface.offsetWidth || 1 : 1;
    return { x: clamp(((clientX - r.left) / scale + surface.scrollLeft) / zoomRef.current), y: clamp(((clientY - r.top) / scale + surface.scrollTop) / zoomRef.current) };
  };
  const connect = (event: ReactPointerEvent, item: WhiteboardItem) => {
    if (event.button !== 0 || !stage.current) return; event.preventDefault(); event.stopPropagation(); cleanupDrag.current?.();
    const id = event.pointerId;
    setDrawing({ from: item.id, end: { x: item.x + item.width, y: item.y + item.height / 2 } });
    const moving = (e: PointerEvent) => { if (e.pointerId === id) setDrawing({ from: item.id, end: canvasPoint(e.clientX, e.clientY) }); };
    const cleanup = () => { window.removeEventListener("pointermove", moving); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel); setDrawing(null); cleanupDrag.current = null; };
    const end = (e: PointerEvent) => { if (e.pointerId !== id) return; const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-whiteboard-id]")?.dataset.whiteboardId; cleanup(); const current = latest.current; if (target && target !== item.id && current.items.some((other) => other.id === target) && !current.connections.some((edge) => edge.from === item.id && edge.to === target)) commit({ ...current, connections: [...current.connections, { from: item.id, to: target, color: TODO_CONNECTION_COLOR }] }); };
    const cancel = (e: PointerEvent) => { if (e.pointerId === id) cleanup(); };
    cleanupDrag.current = cleanup; window.addEventListener("pointermove", moving); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", cancel);
  };
  const byId = new Map(board.items.map((item) => [item.id, item]));
  const upload = (chosen: File | undefined) => { if (!chosen) return; if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(chosen.type) || chosen.size > 2 * 1024 * 1024) { setError("Choose a PNG, JPEG, GIF or WebP image up to 2 MB."); return; } const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === "string") add("image", reader.result); }; reader.onerror = () => setError("Couldn't read that image."); reader.readAsDataURL(chosen); };
  const finishCanvas = (cancelled = false) => {
    canvasPointer.current = null; pan.current = null;
    const stroke = strokeRef.current, shape = shapeRef.current;
    strokeRef.current = null; shapeRef.current = null; setDraftStroke(null); setDraftShape(null);
    if (cancelled) return;
    if (stroke) commit({ ...latest.current, strokes: [...latest.current.strokes, stroke] });
    if (shape) {
      const bounds = shapeBounds(shape.start, shape.end);
      const item = { ...newWhiteboardItem("shape", bounds.x, bounds.y, "", shape.shape), width: bounds.width, height: bounds.height };
      if (commit({ ...latest.current, items: [...latest.current.items, item] })) setShapeTool(null);
    }
  };
  return <section className="todo-board whiteboard" aria-labelledby="whiteboard-title">
    <div className="todo-header"><div className="explore-heading-icon"><Square size={20} /></div><div><span className="section-eyebrow">YOUR WHITEBOARD</span><h2 id="whiteboard-title"><button type="button" className="rename-title" title="Click to rename" onClick={onRename}>{name}<Pencil size={13} /></button></h2><p>A canvas for your ideas.</p></div><span className="todo-header-spacer" /><div className={`save-indicator ${saveState}`} role="status">{saveState === "saving" ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}<span>{saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved changes" : "Saved"}</span>{saveState === "error" && <button type="button" onClick={onRetry}>Retry</button>}</div></div>
    <div className="whiteboard-toolbar">
      <button type="button" onClick={() => add("text")}><Type size={16} /> Text</button><button type="button" onClick={() => add("todo")}><ListChecks size={16} /> To-do</button>
      <div className="whiteboard-shape-menu"><button type="button" className={shapeTool ? "active" : ""} aria-pressed={!!shapeTool} aria-expanded={shapeOpen} aria-haspopup="menu" onClick={() => setShapeOpen((value) => !value)}><Square size={16} /> Shape <ChevronDown size={13} /></button>{shapeOpen && <div className="whiteboard-shape-options" role="menu" aria-label="Add a shape">{SHAPES.map(({ value, label, icon: Icon }) => <button role="menuitem" type="button" key={value} onClick={() => { setShapeTool(value); setPen(false); setShapeOpen(false); }}><Icon size={15} /> {label}</button>)}</div>}</div>
      <button type="button" onClick={() => file.current?.click()}><ImagePlus size={16} /> Image</button><input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(event) => { upload(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
      <button type="button" className={pen ? "active" : ""} aria-pressed={pen} title="Draw on the canvas" onClick={() => { setPen((value) => !value); setShapeOpen(false); setShapeTool(null); }}><Pencil size={16} /> Pen</button>
      {shapeTool && <span className="whiteboard-shape-hint" role="status">Drag on a blank area to draw <button type="button" onClick={() => setShapeTool(null)}>Cancel</button></span>}
      {pen && <><ColorMenu color={penColor} label="Pen color" onChange={setPenColor} /><label className="whiteboard-pen-width">Pen size <AppSelect label="Pen size" value={penWidth} onChange={(value) => setPenWidth(Number(value))}><option value="2">Fine</option><option value="4">Medium</option><option value="8">Thick</option></AppSelect></label></>}
      <button type="button" aria-label="Remove last pen stroke" title="Remove last pen stroke" disabled={!board.strokes.length} onClick={() => commit({ ...latest.current, strokes: latest.current.strokes.slice(0, -1) })}><RotateCcw size={15} /></button>
      <button type="button" className="board-clear-button" disabled={!board.items.length && !board.connections.length && !board.strokes.length} onClick={() => setClearOpen(true)} title="Clear whiteboard contents"><Trash2 size={15} /> Clear board</button>
      <span className="todo-header-spacer" /><button type="button" aria-label="Zoom whiteboard out" onClick={() => setZoom((z) => Math.max(.4, z - .1))}><Minus size={15} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom whiteboard in" onClick={() => setZoom((z) => Math.min(2, z + .1))}><Plus size={15} /></button>
    </div>
    {clearOpen && <ClearBoardDialog kind="whiteboard" onCancel={() => setClearOpen(false)} onConfirm={() => {
      if (!commit({ ...latest.current, items: [], connections: [], strokes: [] })) return false;
      cleanupDrag.current?.(); setLayers([]); setPositions({}); setSizes({}); setSelected(""); setDeleting(""); setDrawing(null);
      shapeRef.current = null; strokeRef.current = null; canvasPointer.current = null; pan.current = null;
      setDraftShape(null); setDraftStroke(null); setShapeOpen(false); setShapeTool(null); setPen(false);
      return true;
    }} />}
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className={`todo-canvas whiteboard-stage${pen || shapeTool ? " pen-mode" : ""}`} ref={stage} aria-label="Whiteboard canvas" onPointerDown={(event) => {
      if (event.button !== 0 || (event.target as Element).closest("button,input,textarea,.whiteboard-item,.todo-link-hit,.todo-link-controls")) return;
      setSelected(""); setShapeOpen(false); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.getSelection()?.removeAllRanges();
      const el = event.currentTarget; if (canvasPointer.current !== null) return; canvasPointer.current = event.pointerId; el.setPointerCapture(event.pointerId); event.preventDefault();
      if (pen) { const stroke = { id: todoId(), color: penColor, width: penWidth, points: [canvasPoint(event.clientX, event.clientY)] }; strokeRef.current = stroke; setDraftStroke(stroke); }
      else if (shapeTool) { const start = canvasPoint(event.clientX, event.clientY); const draft = { shape: shapeTool, start, end: start }; shapeRef.current = draft; setDraftShape(draft); }
      else pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    }} onPointerMove={(event) => {
      if (canvasPointer.current !== event.pointerId) return;
      const shape = shapeRef.current;
      if (shape) { const next = { ...shape, end: canvasPoint(event.clientX, event.clientY) }; shapeRef.current = next; setDraftShape(next); return; }
      const stroke = strokeRef.current;
      if (stroke) { const next = canvasPoint(event.clientX, event.clientY), last = stroke.points[stroke.points.length - 1]; if (stroke.points.length < 5000 && Math.hypot(next.x - last.x, next.y - last.y) >= 2) { const updated = { ...stroke, points: [...stroke.points, next] }; strokeRef.current = updated; setDraftStroke(updated); } return; }
      const drag = pan.current; if (!drag || drag.id !== event.pointerId) return; const scale = event.currentTarget.offsetWidth ? event.currentTarget.getBoundingClientRect().width / event.currentTarget.offsetWidth || 1 : 1; event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x) / scale; event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y) / scale;
    }} onPointerUp={(event) => { if (canvasPointer.current === event.pointerId) { if (shapeRef.current) shapeRef.current = { ...shapeRef.current, end: canvasPoint(event.clientX, event.clientY) }; finishCanvas(); } }} onPointerCancel={(event) => { if (canvasPointer.current === event.pointerId) finishCanvas(true); }}>
      <div className="todo-canvas-size" style={{ width: dimensions.width * zoom, height: dimensions.height * zoom }}><div className="todo-canvas-inner" style={{ width: dimensions.width, height: dimensions.height, transform: `scale(${zoom})`, transformOrigin: "top left" }}>
        <svg className="todo-connections-svg" width={dimensions.width} height={dimensions.height} aria-label="Whiteboard connections and drawing">
          {[...board.strokes, ...(draftStroke ? [draftStroke] : [])].map((stroke) => <path key={stroke.id} d={strokePath(stroke.points)} fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" />)}
          {board.connections.map((edge) => { const from = byId.get(edge.from), to = byId.get(edge.to); if (!from || !to) return null; const path = connectionGeometry(rect(from), rect(to)).path, key = JSON.stringify([edge.from, edge.to]); return <g className={selected === key ? "selected" : ""} key={key}><path d={path} className="todo-link-selection" /><path d={path} className="todo-link-hit" role="button" tabIndex={0} aria-label="Select whiteboard connection" onClick={() => setSelected(key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(key); } }} /><path d={path} className="todo-link-line" style={{ stroke: edge.color }} /></g>; })}
          {drawing && byId.has(drawing.from) && <path className="todo-link-preview" d={connectionGeometry(rect(byId.get(drawing.from)!), { ...drawing.end, width: 0, height: 0 }).path} />}
        </svg>
        {board.connections.map((edge) => { const from = byId.get(edge.from), to = byId.get(edge.to), key = JSON.stringify([edge.from, edge.to]); if (!from || !to || key !== selected) return null; const { from: a, to: b } = connectionGeometry(rect(from), rect(to)); return <div className="todo-link-controls" key={key} style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 }}><ColorMenu color={edge.color} label="Connection color" onChange={(color) => commit({ ...latest.current, connections: latest.current.connections.map((item) => item.from === edge.from && item.to === edge.to ? { ...item, color } : item) })} /><button type="button" className="todo-link-remove" aria-label="Remove whiteboard connection" onClick={() => { commit({ ...latest.current, connections: latest.current.connections.filter((item) => item.from !== edge.from || item.to !== edge.to) }); setSelected(""); }}><X size={14} /></button></div>; })}
        {draftShape && (() => { const bounds = shapeBounds(draftShape.start, draftShape.end); return <svg className="whiteboard-shape-preview" style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><ShapeOutline shape={draftShape.shape} /></svg>; })()}
        {board.items.map((item) => { const p = point(item), dimensions = size(item), layer = layers.indexOf(item.id); return <article className={`whiteboard-item whiteboard-${item.type}${item.type === "shape" && item.filled ? " is-filled" : ""}`} data-whiteboard-id={item.id} key={item.id} onPointerDownCapture={(event) => { if (event.button === 0) bringToFront(item.id); }} onFocusCapture={() => bringToFront(item.id)} style={{ left: p.x, top: p.y, width: dimensions.width, height: dimensions.height, zIndex: layer < 0 ? item.type === "shape" ? 1 : 2 : layer + 3, "--item-color": item.color } as CSSProperties}>
          <div className="whiteboard-item-header" title="Drag to move" onPointerDown={(event) => { if (!(event.target as Element).closest("button,input,select")) move(event, item); }}><button type="button" title="Drag to move" aria-label={`Drag ${item.type}`} onPointerDown={(event) => move(event, item)}><GripVertical size={15} /></button><span>{item.type === "shape" ? item.shape.toUpperCase() : item.type.toUpperCase()}</span><ColorMenu color={item.color} label={`Color ${item.type}`} onChange={(color) => update(item.id, { color })} />{item.type === "shape" && <button type="button" aria-label={item.filled ? "Remove shape fill" : "Fill shape"} title={item.filled ? "Remove fill" : "Fill shape"} aria-pressed={!!item.filled} onClick={() => update(item.id, { filled: !item.filled })}><PaintBucket size={15} /></button>}{deleting === item.id ? <><button type="button" onClick={() => { commit({ ...latest.current, items: latest.current.items.filter((other) => other.id !== item.id), connections: latest.current.connections.filter((edge) => edge.from !== item.id && edge.to !== item.id) }); setDeleting(""); }}>Delete</button><button type="button" aria-label="Cancel deleting item" onClick={() => setDeleting("")}><X size={14} /></button></> : <button type="button" aria-label={`Delete ${item.type}`} onClick={() => setDeleting(item.id)}><Trash2 size={14} /></button>}</div>
          {item.type === "image" ? <img src={item.image} alt={item.text || "Whiteboard image"} /> : <div className={`whiteboard-item-content${item.type === "shape" ? " shape-content" : ""}`}>
            {item.type === "shape" && <svg className="whiteboard-shape-visual" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><ShapeOutline shape={item.shape} /></svg>}
            {item.type === "todo" && <input type="checkbox" checked={item.done} aria-label="Complete whiteboard to-do" onChange={(event) => update(item.id, { done: event.target.checked })} />}<textarea aria-label={`${item.type === "todo" ? "To-do" : item.type === "shape" ? "Shape" : "Text box"} text`} maxLength={10000} placeholder={item.type === "todo" ? "Something to do…" : item.type === "shape" ? "" : "Write something…"} value={item.text} onChange={(event) => update(item.id, { text: event.target.value })} /></div>}
          <button type="button" className="todo-connect-dot" title="Drag to connect" aria-label={`Connect ${item.type} to another item`} onPointerDown={(event) => connect(event, item)} /><button type="button" className="whiteboard-resize" title="Drag to resize" aria-label={`Resize ${item.type}`} onPointerDown={(event) => resize(event, item)} onKeyDown={(event) => { const delta = event.shiftKey ? 20 : 5; const dx = event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0, dy = event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0; if (dx || dy) { event.preventDefault(); update(item.id, { width: Math.max(item.type === "shape" ? 30 : 160, Math.min(1600, item.width + dx)), height: Math.max(item.type === "shape" ? 30 : 110, Math.min(1200, item.height + dy)) }); } }} />
        </article>; })}
        {!board.items.length && !board.strokes.length && <div className="todo-canvas-empty"><Square size={26} /><strong>A blank whiteboard</strong><span>Add an item or choose the pen to draw.</span></div>}
      </div></div>
    </div>
  </section>;
}
