export interface TodoTask { id: string; text: string; done: boolean; notes: string }
export interface TodoList { id: string; title: string; color: string; tasks: TodoTask[] }
export interface TodoConnection { from: string; to: string }
export interface TodoDocument { format: "comet-todo"; version: 1; lists: TodoList[]; connections: TodoConnection[] }

export function todoId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
export function newTodoDocument(): TodoDocument {
  const lists: TodoList[] = [
    { id: todoId(), title: "To do", color: "#78b5cf", tasks: [] },
    { id: todoId(), title: "In progress", color: "#e8cf72", tasks: [] },
    { id: todoId(), title: "Done", color: "#8bc49f", tasks: [] },
  ];
  return { format: "comet-todo", version: 1, lists, connections: [{ from: lists[0].id, to: lists[1].id }, { from: lists[1].id, to: lists[2].id }] };
}
export function serializeTodo(value: TodoDocument): string { return `${JSON.stringify(value, null, 2)}\n`; }

// Reject unknown fields and versions instead of dropping information when a
// newer, corrupt, or unrelated file is opened. Nothing is saved on failure.
export function parseTodo(text: string): TodoDocument | null {
  try {
    const root: unknown = JSON.parse(text);
    const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
    const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
    const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;
    if (!object(root) || !exact(root, ["format", "version", "lists", "connections"]) || root.format !== "comet-todo" || root.version !== 1 || !Array.isArray(root.lists) || root.lists.length > 100 || !Array.isArray(root.connections) || root.connections.length > 5000) return null;
    const listIds = new Set<string>(); const taskIds = new Set<string>(); let tasks = 0;
    for (const list of root.lists) {
      if (!object(list) || !exact(list, ["id", "title", "color", "tasks"]) || !id(list.id) || listIds.has(list.id) || typeof list.title !== "string" || list.title.length > 120 || typeof list.color !== "string" || !/^#[0-9a-f]{6}$/i.test(list.color) || !Array.isArray(list.tasks)) return null;
      listIds.add(list.id); tasks += list.tasks.length; if (tasks > 5000) return null;
      for (const task of list.tasks) {
        if (!object(task) || !exact(task, ["id", "text", "done", "notes"]) || !id(task.id) || taskIds.has(task.id) || typeof task.text !== "string" || task.text.length > 500 || typeof task.done !== "boolean" || typeof task.notes !== "string" || task.notes.length > 200_000) return null;
        taskIds.add(task.id);
      }
    }
    const connections = new Set<string>();
    for (const edge of root.connections) {
      if (!object(edge) || !exact(edge, ["from", "to"]) || !id(edge.from) || !id(edge.to) || edge.from === edge.to || !listIds.has(edge.from) || !listIds.has(edge.to)) return null;
      const key = `${edge.from}\0${edge.to}`; if (connections.has(key)) return null; connections.add(key);
    }
    return root as unknown as TodoDocument;
  } catch { return null; }
}
