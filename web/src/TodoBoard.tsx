import { useState, type CSSProperties, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Link2, ListChecks, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { ColorMenu } from "./ColorMenu";
import { todoId, type TodoDocument, type TodoList, type TodoTask } from "./utils/todo";
import type { SaveState } from "./utils/saveQueue";

interface Props { board: TodoDocument; name: string; saveState: SaveState; onChange: (board: TodoDocument) => boolean; onRetry: () => void }
export function TodoBoard({ board, name, saveState, onChange, onRetry }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [deleteList, setDeleteList] = useState("");
  const [deleteTask, setDeleteTask] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [error, setError] = useState("");
  const modifyList = (id: string, change: (list: TodoList) => TodoList) => onChange({ ...board, lists: board.lists.map((list) => list.id === id ? change(list) : list) });
  const modifyTask = (listId: string, id: string, patch: Partial<TodoTask>) => modifyList(listId, (list) => ({ ...list, tasks: list.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) }));
  const addTask = (event: FormEvent, listId: string) => {
    event.preventDefault(); const text = (drafts[listId] || "").trim(); if (!text) return;
    if (modifyList(listId, (list) => ({ ...list, tasks: [...list.tasks, { id: todoId(), text, done: false, notes: "" }] }))) {
      setDrafts((previous) => ({ ...previous, [listId]: "" }));
    }
  };
  const moveList = (index: number, delta: number) => {
    const next = [...board.lists]; const target = index + delta; if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; onChange({ ...board, lists: next });
  };
  const moveTask = (source: string, target: string, task: TodoTask) => {
    if (source === target) return;
    onChange({ ...board, lists: board.lists.map((list) => list.id === source ? { ...list, tasks: list.tasks.filter((item) => item.id !== task.id) } : list.id === target ? { ...list, tasks: [...list.tasks, task] } : list) });
  };
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (!board.lists.some((list) => list.id === from) || !board.lists.some((list) => list.id === to) || from === to) { setError("Choose two different lists."); return; }
    if (board.connections.some((edge) => edge.from === from && edge.to === to)) { setError("These lists are already connected in that direction."); return; }
    onChange({ ...board, connections: [...board.connections, { from, to }] }); setError("");
  };
  const width = Math.max(276, board.lists.length * 276);
  return <section className="todo-board" aria-labelledby="todo-title">
    <div className="todo-header"><div className="explore-heading-icon"><ListChecks size={20} /></div><div><span className="section-eyebrow">YOUR TO-DO BOARD</span><h2 id="todo-title">{name}</h2><p>Organize tasks in lists and connect your workflow.</p></div><span className="todo-header-spacer" /><div className={`save-indicator ${saveState}`} role="status">{saveState === "error" ? <AlertCircle size={15} /> : saveState === "saving" ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}<span>{saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved changes" : "Saved"}</span>{saveState === "error" && <button type="button" onClick={onRetry}>Retry</button>}</div></div>
    <div className="todo-board-actions"><button type="button" className="secondary-button" disabled={board.lists.length >= 100} onClick={() => onChange({ ...board, lists: [...board.lists, { id: todoId(), title: "New list", color: "#9c9fe1", tasks: [] }] })}><Plus size={15} /> Add list</button><span>Changes save to this .comet-todo file.</span></div>
    <div className="todo-scroll"><div className="todo-inner" style={{ width }}>
      <svg className="todo-flow" width={width} height="74" aria-label="Workflow connections" role="img"><defs><marker id="todo-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" /></marker></defs>
        {board.connections.map((edge) => { const a = board.lists.findIndex((list) => list.id === edge.from), b = board.lists.findIndex((list) => list.id === edge.to); if (a < 0 || b < 0) return null; const x1 = a * 276 + 130, x2 = b * 276 + 130; return <path key={`${edge.from}:${edge.to}`} d={`M ${x1} 58 Q ${(x1 + x2) / 2} ${Math.max(-14, 28 - Math.abs(a - b) * 5)} ${x2} 58`} markerEnd="url(#todo-arrow)" />; })}
        {board.lists.map((list, index) => <circle key={list.id} cx={index * 276 + 130} cy="58" r="4" style={{ fill: list.color }} />)}
      </svg>
      <div className="todo-lanes">{board.lists.map((list, index) => <div className="todo-lane" key={list.id} style={{ "--list-color": list.color } as CSSProperties}>
        <div className="todo-lane-heading"><span className="todo-lane-dot" /><input value={list.title} maxLength={120} aria-label="List name" onChange={(event) => modifyList(list.id, (current) => ({ ...current, title: event.target.value }))} /><span className="todo-count">{list.tasks.length}</span><ColorMenu color={list.color} label={`Color for ${list.title || "list"}`} onChange={(color) => modifyList(list.id, (current) => ({ ...current, color }))} /></div>
        <div className="todo-lane-config"><button type="button" disabled={index === 0} aria-label={`Move ${list.title} left`} onClick={() => moveList(index, -1)}><ArrowLeft size={13} /></button><button type="button" disabled={index === board.lists.length - 1} aria-label={`Move ${list.title} right`} onClick={() => moveList(index, 1)}><ArrowRight size={13} /></button><span />{deleteList === list.id ? <><button type="button" className="todo-delete-confirm" onClick={() => { onChange({ ...board, lists: board.lists.filter((item) => item.id !== list.id), connections: board.connections.filter((edge) => edge.from !== list.id && edge.to !== list.id) }); setDeleteList(""); }}>Delete list & tasks</button><button type="button" aria-label="Cancel deleting list" onClick={() => setDeleteList("")}><X size={13} /></button></> : <button type="button" aria-label={`Delete ${list.title} list`} title="Delete list" onClick={() => setDeleteList(list.id)}><Trash2 size={13} /></button>}</div>
        <div className="todo-tasks">{list.tasks.map((task) => <article className={`todo-task${task.done ? " done" : ""}`} key={task.id}>
          <div className="todo-task-line"><input type="checkbox" checked={task.done} aria-label={`Complete ${task.text || "task"}`} onChange={(event) => modifyTask(list.id, task.id, { done: event.target.checked })} /><input className="todo-task-text" maxLength={500} value={task.text} aria-label="Task name" onChange={(event) => modifyTask(list.id, task.id, { text: event.target.value })} /><button type="button" aria-expanded={expanded.has(task.id)} aria-label={`${expanded.has(task.id) ? "Hide" : "Show"} notes for ${task.text || "task"}`} onClick={() => setExpanded((previous) => { const next = new Set(previous); if (next.has(task.id)) next.delete(task.id); else next.add(task.id); return next; })}>{expanded.has(task.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button></div>
          {expanded.has(task.id) && <div className="todo-task-detail"><label>Task notes<textarea maxLength={200000} aria-label={`Notes for ${task.text || "task"}`} value={task.notes} onChange={(event) => modifyTask(list.id, task.id, { notes: event.target.value })} placeholder="Add details, links, or a little context…" /></label><div className="todo-task-actions">{board.lists.length > 1 && <label>Move to <select aria-label={`Move ${task.text || "task"} to list`} value={list.id} onChange={(event) => moveTask(list.id, event.target.value, task)}>{board.lists.map((target) => <option key={target.id} value={target.id}>{target.title || "Untitled list"}</option>)}</select></label>}{deleteTask === task.id ? <><button type="button" className="todo-delete-confirm" onClick={() => { modifyList(list.id, (current) => ({ ...current, tasks: current.tasks.filter((item) => item.id !== task.id) })); setDeleteTask(""); }}>Delete task</button><button type="button" aria-label="Cancel deleting task" onClick={() => setDeleteTask("")}><X size={13} /></button></> : <button type="button" aria-label={`Delete ${task.text || "task"}`} onClick={() => setDeleteTask(task.id)}><Trash2 size={14} /></button>}</div></div>}
        </article>)}</div>
        <form className="todo-add-task" onSubmit={(event) => addTask(event, list.id)}><input aria-label={`New task in ${list.title || "list"}`} maxLength={500} value={drafts[list.id] || ""} onChange={(event) => setDrafts((previous) => ({ ...previous, [list.id]: event.target.value }))} placeholder="Add a task…" /><button type="submit" aria-label={`Add task to ${list.title || "list"}`}><Plus size={16} /></button></form>
      </div>)}</div>
      {!board.lists.length && <div className="todo-empty">Add a list to start your board.</div>}
    </div></div>
    <div className="todo-connections"><div><h3><Link2 size={15} /> Workflow connections</h3><p>Connect lists to show the direction work flows between them.</p></div><form onSubmit={connect}><select aria-label="Connect from list" value={from} onChange={(event) => { setFrom(event.target.value); setError(""); }}><option value="">From list…</option>{board.lists.map((list) => <option value={list.id} key={list.id}>{list.title || "Untitled list"}</option>)}</select><ArrowRight size={15} /><select aria-label="Connect to list" value={to} onChange={(event) => { setTo(event.target.value); setError(""); }}><option value="">To list…</option>{board.lists.map((list) => <option value={list.id} key={list.id}>{list.title || "Untitled list"}</option>)}</select><button className="secondary-button" type="submit"><Plus size={14} /> Connect</button></form>{error && <div className="dialog-error" role="alert">{error}</div>}
      <div className="todo-connection-list">{board.connections.map((edge) => <span key={`${edge.from}:${edge.to}`}>{board.lists.find((list) => list.id === edge.from)?.title || "Untitled"} <ArrowRight size={12} /> {board.lists.find((list) => list.id === edge.to)?.title || "Untitled"}<button type="button" aria-label={`Remove connection from ${board.lists.find((list) => list.id === edge.from)?.title} to ${board.lists.find((list) => list.id === edge.to)?.title}`} onClick={() => onChange({ ...board, connections: board.connections.filter((item) => item.from !== edge.from || item.to !== edge.to) })}><X size={13} /></button></span>)}</div>
    </div>
  </section>;
}
