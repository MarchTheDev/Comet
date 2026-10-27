export interface TodoTask { id: string; text: string; done: boolean; notes: string; x: number; y: number; categoryId: string | null }
export interface TodoCategory { id: string; title: string; color: string }
export interface TodoConnection { from: string; to: string }
export interface TodoDocument {
  format: "comet-todo";
  version: 2;
  tasks: TodoTask[];
  categories: TodoCategory[];
  connections: TodoConnection[];
  /** Version 1 connected lists, not tasks. Keep those links without drawing them. */
  legacyListConnections: TodoConnection[];
}

export const TODO_MAX_COORD = 100_000;
export function todoId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
export function newTodoDocument(): TodoDocument {
  return { format: "comet-todo", version: 2, tasks: [], categories: [], connections: [], legacyListConnections: [] };
}
export function serializeTodo(value: TodoDocument): string { return `${JSON.stringify(value, null, 2)}\n`; }

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;
const position = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= TODO_MAX_COORD;
const taskContent = (task: Record<string, unknown>) => id(task.id) && typeof task.text === "string" && task.text.length <= 500 && typeof task.done === "boolean" && typeof task.notes === "string" && task.notes.length <= 200_000;
const categoryContent = (category: Record<string, unknown>) => id(category.id) && typeof category.title === "string" && category.title.length <= 120 && typeof category.color === "string" && /^#[0-9a-f]{6}$/i.test(category.color);
function edges(value: unknown, ids: Set<string>): value is TodoConnection[] {
  if (!Array.isArray(value) || value.length > 5000) return false;
  const seen = new Set<string>();
  for (const edge of value) {
    if (!object(edge) || !exact(edge, ["from", "to"]) || !id(edge.from) || !id(edge.to) || edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to)) return false;
    const key = `${edge.from}\0${edge.to}`; if (seen.has(key)) return false; seen.add(key);
  }
  return true;
}

/** Read v1 without modifying it on disk. Its lists become categories on first edit. */
function readLegacy(root: Record<string, unknown>): TodoDocument | null {
  if (!exact(root, ["format", "version", "lists", "connections"]) || !Array.isArray(root.lists) || root.lists.length > 100) return null;
  const categories: TodoCategory[] = [], tasks: TodoTask[] = [];
  const categoryIds = new Set<string>(), taskIds = new Set<string>();
  for (const [column, list] of root.lists.entries()) {
    if (!object(list) || !exact(list, ["id", "title", "color", "tasks"]) || !categoryContent(list) || !Array.isArray(list.tasks) || categoryIds.has(list.id as string)) return null;
    const category = { id: list.id as string, title: list.title as string, color: list.color as string };
    categories.push(category); categoryIds.add(category.id);
    for (const [row, task] of list.tasks.entries()) {
      if (!object(task) || !exact(task, ["id", "text", "done", "notes"]) || !taskContent(task) || taskIds.has(task.id as string) || tasks.length >= 5000) return null;
      taskIds.add(task.id as string);
      tasks.push({ id: task.id as string, text: task.text as string, done: task.done as boolean, notes: task.notes as string, x: Math.min(TODO_MAX_COORD, 100 + column * 300), y: Math.min(TODO_MAX_COORD, 110 + row * 175), categoryId: category.id });
    }
  }
  if (!edges(root.connections, categoryIds)) return null;
  return { format: "comet-todo", version: 2, tasks, categories, connections: [], legacyListConnections: root.connections };
}

// Reject unknown fields, corrupt data and newer versions instead of dropping
// anything. A valid legacy file is converted only in memory until an edit.
export function parseTodo(text: string): TodoDocument | null {
  try {
    const root: unknown = JSON.parse(text);
    if (!object(root) || root.format !== "comet-todo") return null;
    if (root.version === 1) return readLegacy(root);
    if (root.version !== 2 || !exact(root, ["format", "version", "tasks", "categories", "connections", "legacyListConnections"]) || !Array.isArray(root.tasks) || root.tasks.length > 5000 || !Array.isArray(root.categories) || root.categories.length > 100) return null;
    const categoryIds = new Set<string>(), taskIds = new Set<string>();
    for (const category of root.categories) {
      if (!object(category) || !exact(category, ["id", "title", "color"]) || !categoryContent(category) || categoryIds.has(category.id as string)) return null;
      categoryIds.add(category.id as string);
    }
    for (const task of root.tasks) {
      if (!object(task) || !exact(task, ["id", "text", "done", "notes", "x", "y", "categoryId"]) || !taskContent(task) || !position(task.x) || !position(task.y) || (task.categoryId !== null && (!id(task.categoryId) || !categoryIds.has(task.categoryId))) || taskIds.has(task.id as string)) return null;
      taskIds.add(task.id as string);
    }
    if (!edges(root.connections, taskIds) || !edges(root.legacyListConnections, categoryIds)) return null;
    return root as unknown as TodoDocument;
  } catch { return null; }
}
