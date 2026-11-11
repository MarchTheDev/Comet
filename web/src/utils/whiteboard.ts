import { safeWebUrl } from "./links";
import { TODO_CONNECTION_COLOR, TODO_MAX_COORD, todoId } from "./todo";

export type WhiteboardItemType = "text" | "todo" | "image" | "shape" | "link";
export type WhiteboardShape = "rectangle" | "ellipse" | "diamond" | "triangle";

export interface WhiteboardTodoEntry {
  id: string;
  text: string;
  done: boolean;
}

export interface WhiteboardLinkEntry {
  id: string;
  url: string;
  showEmbed: boolean;
}

export interface WhiteboardItem {
  id: string;
  type: WhiteboardItemType;
  x: number;
  y: number;
  text: string;
  done: boolean;
  color: string;
  image: string;
  width: number;
  height: number;
  shape: WhiteboardShape;
  filled: boolean;
  title: string;
  todos: WhiteboardTodoEntry[];
  links: WhiteboardLinkEntry[];
}

export interface WhiteboardConnection {
  from: string;
  to: string;
  color: string;
}

export interface WhiteboardStroke {
  id: string;
  color: string;
  width: number;
  points: { x: number; y: number }[];
}

export interface WhiteboardDocument {
  format: "comet-whiteboard";
  version: 2 | 3 | 4 | 5;
  items: WhiteboardItem[];
  connections: WhiteboardConnection[];
  strokes: WhiteboardStroke[];
}

export const newWhiteboard = (): WhiteboardDocument => ({
  format: "comet-whiteboard",
  version: 2,
  items: [],
  connections: [],
  strokes: [],
});

export const newWhiteboardTodo = (text = ""): WhiteboardTodoEntry => ({
  id: todoId(),
  text,
  done: false,
});

export const newWhiteboardLink = (url: string, showEmbed = true): WhiteboardLinkEntry => ({
  id: todoId(),
  url,
  showEmbed,
});

// Version 3 adds small shapes. Version 4 adds explicit per-shape fill.
// Version 5 adds custom card titles, multi-item whiteboard to-dos, and link cards.
// Older builds refuse versions they cannot faithfully preserve instead of losing data.
export const serializeWhiteboard = (board: WhiteboardDocument): string => {
  const needsV5 =
    board.version === 5 ||
    board.items.some(
      (item) =>
        item.type === "link" ||
        ((item.type === "text" || item.type === "todo") && !!item.title) ||
        (item.type === "todo" && (item.todos?.length ?? 0) > 0) ||
        (item.links?.length ?? 0) > 0,
    );
  const needsV4 =
    needsV5 ||
    board.version === 4 ||
    board.items.some((item) => item.type === "shape" && item.filled);
  const needsV3 =
    needsV4 ||
    board.version === 3 ||
    board.items.some((item) => item.type === "shape" && (item.width < 160 || item.height < 110));
  const version: WhiteboardDocument["version"] = needsV5 ? 5 : needsV4 ? 4 : needsV3 ? 3 : 2;
  const items = board.items.map(({ filled, title, todos, links, ...item }) => {
    const out: Record<string, unknown> = { ...item };
    if (version >= 4 && item.type === "shape") out.filled = !!filled;
    if (version >= 5 && item.type === "text") out.title = title ?? "";
    if (version >= 5 && item.type === "todo") {
      if (title) out.title = title;
      out.todos = (todos ?? []).map((entry) => ({
        id: entry.id,
        text: entry.text,
        done: !!entry.done,
      }));
    }
    if (version >= 5 && item.type === "link") {
      out.title = title ?? "";
      out.links = (links ?? []).map((entry) => ({
        id: entry.id,
        url: entry.url,
        showEmbed: entry.showEmbed !== false,
      }));
    }
    return out;
  });
  return `${JSON.stringify({ ...board, version, items }, null, 2)}\n`;
};

export function newWhiteboardItem(
  type: WhiteboardItemType,
  x: number,
  y: number,
  image = "",
  shape: WhiteboardShape = "rectangle",
): WhiteboardItem {
  return {
    id: todoId(),
    type,
    x,
    y,
    text: "",
    done: false,
    color: "#9c9fe1",
    image,
    width: type === "link" ? 330 : 240,
    // A to-do card no longer grows as items are added, so it starts with room for a few.
    height: type === "link" ? 230 : type === "todo" ? 200 : 150,
    shape,
    filled: false,
    title: "",
    todos: [],
    links: [],
  };
}

export { TODO_CONNECTION_COLOR };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const color = (value: unknown) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 100;
const position = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= TODO_MAX_COORD;
const legacyKeys = ["id", "type", "x", "y", "text", "done", "color", "image"];

/** Read legacy boards without changing the file; the new format is saved only on edit. */
export function parseWhiteboard(text: string): WhiteboardDocument | null {
  try {
    const root: unknown = JSON.parse(text);
    if (
      !object(root) ||
      root.format !== "comet-whiteboard" ||
      (root.version !== 1 &&
        root.version !== 2 &&
        root.version !== 3 &&
        root.version !== 4 &&
        root.version !== 5)
    ) {
      return null;
    }
    const ver = root.version;
    const legacy = ver === 1;
    if (
      !exact(
        root,
        legacy
          ? ["format", "version", "items", "connections"]
          : ["format", "version", "items", "connections", "strokes"],
      ) ||
      !Array.isArray(root.items) ||
      root.items.length > 1000 ||
      !Array.isArray(root.connections) ||
      root.connections.length > 5000
    ) {
      return null;
    }

    const allowedTypes = legacy
      ? ["text", "todo", "image"]
      : ver >= 5
        ? ["text", "todo", "image", "shape", "link"]
        : ["text", "todo", "image", "shape"];

    const ids = new Set<string>();
    const items: WhiteboardItem[] = [];
    for (const item of root.items) {
      if (!object(item)) return null;
      const hasTodoTitle =
        ver >= 5 && item.type === "todo" && Object.prototype.hasOwnProperty.call(item, "title");
      const expectedKeys = legacy
        ? legacyKeys
        : [
            ...legacyKeys,
            "width",
            "height",
            "shape",
            ...(ver >= 4 && item.type === "shape" ? ["filled"] : []),
            ...(ver >= 5 && item.type === "text" ? ["title"] : []),
            ...(hasTodoTitle ? ["title"] : []),
            ...(ver >= 5 && item.type === "todo" ? ["todos"] : []),
            ...(ver >= 5 && item.type === "link" ? ["title", "links"] : []),
          ];
      if (
        !exact(item, expectedKeys) ||
        !id(item.id) ||
        ids.has(item.id) ||
        !allowedTypes.includes(String(item.type)) ||
        typeof item.text !== "string" ||
        item.text.length > 10000 ||
        typeof item.done !== "boolean" ||
        !color(item.color) ||
        !position(item.x) ||
        !position(item.y) ||
        typeof item.image !== "string"
      ) {
        return null;
      }
      if (ver >= 4 && item.type === "shape" && typeof item.filled !== "boolean") return null;
      if (
        ver >= 5 &&
        (item.type === "text" || item.type === "link" || hasTodoTitle) &&
        (typeof item.title !== "string" || item.title.length > 120)
      ) {
        return null;
      }

      const parsedTodos: WhiteboardTodoEntry[] = [];
      if (ver >= 5 && item.type === "todo") {
        if (!Array.isArray(item.todos) || item.todos.length > 200) return null;
        const todoIds = new Set<string>();
        for (const entry of item.todos) {
          if (
            !object(entry) ||
            !exact(entry, ["id", "text", "done"]) ||
            !id(entry.id) ||
            todoIds.has(entry.id) ||
            typeof entry.text !== "string" ||
            entry.text.length > 2000 ||
            typeof entry.done !== "boolean"
          ) {
            return null;
          }
          todoIds.add(entry.id);
          parsedTodos.push({ id: entry.id, text: entry.text, done: entry.done });
        }
      }

      const parsedLinks: WhiteboardLinkEntry[] = [];
      if (ver >= 5 && item.type === "link") {
        if (!Array.isArray(item.links) || item.links.length > 100) return null;
        const linkIds = new Set<string>();
        for (const entry of item.links) {
          if (
            !object(entry) ||
            !exact(entry, ["id", "url", "showEmbed"]) ||
            !id(entry.id) ||
            linkIds.has(entry.id) ||
            typeof entry.url !== "string" ||
            entry.url.length > 2048 ||
            !safeWebUrl(entry.url) ||
            typeof entry.showEmbed !== "boolean"
          ) {
            return null;
          }
          linkIds.add(entry.id);
          parsedLinks.push({ id: entry.id, url: entry.url, showEmbed: entry.showEmbed });
        }
      }

      if (
        item.type === "image"
          ? item.image.length > 2_900_000 ||
            !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(item.image)
          : item.image !== ""
      ) {
        return null;
      }
      if (
        !legacy &&
        (typeof item.width !== "number" ||
          !Number.isFinite(item.width) ||
          item.width < (ver >= 3 && item.type === "shape" ? 30 : 160) ||
          item.width > 1600 ||
          typeof item.height !== "number" ||
          !Number.isFinite(item.height) ||
          item.height < (ver >= 3 && item.type === "shape" ? 30 : 110) ||
          item.height > 1200 ||
          !["rectangle", "ellipse", "diamond", "triangle"].includes(String(item.shape)))
      ) {
        return null;
      }

      ids.add(item.id);
      items.push({
        ...(item as unknown as WhiteboardItem),
        width: legacy ? 240 : (item.width as number),
        height: legacy ? 150 : (item.height as number),
        shape: legacy ? "rectangle" : (item.shape as WhiteboardShape),
        filled: ver >= 4 && item.type === "shape" ? (item.filled as boolean) : false,
        title:
          ver >= 5 && (item.type === "text" || item.type === "link" || hasTodoTitle)
            ? (item.title as string)
            : "",
        todos: parsedTodos,
        links: parsedLinks,
      });
    }

    const links = new Set<string>();
    for (const edge of root.connections) {
      if (
        !object(edge) ||
        !exact(edge, ["from", "to", "color"]) ||
        !id(edge.from) ||
        !id(edge.to) ||
        edge.from === edge.to ||
        !ids.has(edge.from) ||
        !ids.has(edge.to) ||
        !color(edge.color)
      ) {
        return null;
      }
      const key = JSON.stringify([edge.from, edge.to]);
      if (links.has(key)) return null;
      links.add(key);
    }

    const strokes: WhiteboardStroke[] = [];
    if (!legacy) {
      if (!Array.isArray(root.strokes) || root.strokes.length > 5000) return null;
      const strokeIds = new Set<string>();
      let points = 0;
      for (const stroke of root.strokes) {
        if (
          !object(stroke) ||
          !exact(stroke, ["id", "color", "width", "points"]) ||
          !id(stroke.id) ||
          strokeIds.has(stroke.id) ||
          !color(stroke.color) ||
          typeof stroke.width !== "number" ||
          !Number.isFinite(stroke.width) ||
          stroke.width < 1 ||
          stroke.width > 30 ||
          !Array.isArray(stroke.points) ||
          stroke.points.length < 1 ||
          stroke.points.length > 5000 ||
          (points += stroke.points.length) > 100_000
        ) {
          return null;
        }
        for (const p of stroke.points) {
          if (!object(p) || !exact(p, ["x", "y"]) || !position(p.x) || !position(p.y)) return null;
        }
        strokeIds.add(stroke.id);
        strokes.push(stroke as unknown as WhiteboardStroke);
      }
    }

    return {
      format: "comet-whiteboard",
      version: ver === 5 ? 5 : ver === 4 ? 4 : ver === 3 ? 3 : 2,
      items,
      connections: root.connections as unknown as WhiteboardConnection[],
      strokes,
    };
  } catch {
    return null;
  }
}
