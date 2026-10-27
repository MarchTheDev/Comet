import { TODO_CONNECTION_COLOR, TODO_MAX_COORD, todoId } from "./todo";
export type WhiteboardItemType = "text" | "todo" | "image" | "shape";
export type WhiteboardShape = "rectangle" | "ellipse" | "diamond" | "triangle";
export interface WhiteboardItem { id: string; type: WhiteboardItemType; x: number; y: number; text: string; done: boolean; color: string; image: string; width: number; height: number; shape: WhiteboardShape }
export interface WhiteboardConnection { from: string; to: string; color: string }
export interface WhiteboardStroke { id: string; color: string; width: number; points: { x: number; y: number }[] }
export interface WhiteboardDocument { format: "comet-whiteboard"; version: 2 | 3; items: WhiteboardItem[]; connections: WhiteboardConnection[]; strokes: WhiteboardStroke[] }
export const newWhiteboard = (): WhiteboardDocument => ({ format: "comet-whiteboard", version: 2, items: [], connections: [], strokes: [] });
// Small shapes need a new version so older builds refuse them instead of
// misinterpreting the expanded dimension limits of version 2.
export const serializeWhiteboard = (board: WhiteboardDocument): string => {
  const needsV3 = board.version === 3 || board.items.some((item) => item.type === "shape" && (item.width < 160 || item.height < 110));
  return `${JSON.stringify({ ...board, version: needsV3 ? 3 : 2 }, null, 2)}\n`;
};
export function newWhiteboardItem(type: WhiteboardItemType, x: number, y: number, image = "", shape: WhiteboardShape = "rectangle"): WhiteboardItem { return { id: todoId(), type, x, y, text: "", done: false, color: "#9c9fe1", image, width: 240, height: 150, shape }; }
export { TODO_CONNECTION_COLOR };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const color = (value: unknown) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;
const position = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= TODO_MAX_COORD;
const legacyKeys = ["id", "type", "x", "y", "text", "done", "color", "image"];
/** Read legacy boards without changing the file; the new format is saved only on edit. */
export function parseWhiteboard(text: string): WhiteboardDocument | null {
  try {
    const root: unknown = JSON.parse(text);
    if (!object(root) || root.format !== "comet-whiteboard" || (root.version !== 1 && root.version !== 2 && root.version !== 3)) return null;
    const legacy = root.version === 1;
    if (!exact(root, legacy ? ["format", "version", "items", "connections"] : ["format", "version", "items", "connections", "strokes"]) || !Array.isArray(root.items) || root.items.length > 1000 || !Array.isArray(root.connections) || root.connections.length > 5000) return null;
    const ids = new Set<string>(); const items: WhiteboardItem[] = [];
    for (const item of root.items) {
      if (!object(item) || !exact(item, legacy ? legacyKeys : [...legacyKeys, "width", "height", "shape"]) || !id(item.id) || ids.has(item.id) || !(legacy ? ["text", "todo", "image"] : ["text", "todo", "image", "shape"]).includes(String(item.type)) || typeof item.text !== "string" || item.text.length > 10000 || typeof item.done !== "boolean" || !color(item.color) || !position(item.x) || !position(item.y) || typeof item.image !== "string") return null;
      if (item.type === "image" ? (item.image.length > 2_900_000 || !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(item.image)) : item.image !== "") return null;
      if (!legacy && (typeof item.width !== "number" || !Number.isFinite(item.width) || item.width < (root.version === 3 && item.type === "shape" ? 30 : 160) || item.width > 1600 || typeof item.height !== "number" || !Number.isFinite(item.height) || item.height < (root.version === 3 && item.type === "shape" ? 30 : 110) || item.height > 1200 || !["rectangle", "ellipse", "diamond", "triangle"].includes(String(item.shape)))) return null;
      ids.add(item.id); items.push({ ...(item as unknown as WhiteboardItem), width: legacy ? 240 : item.width as number, height: legacy ? 150 : item.height as number, shape: legacy ? "rectangle" : item.shape as WhiteboardShape });
    }
    const links = new Set<string>();
    for (const edge of root.connections) {
      if (!object(edge) || !exact(edge, ["from", "to", "color"]) || !id(edge.from) || !id(edge.to) || edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to) || !color(edge.color)) return null;
      const key = JSON.stringify([edge.from, edge.to]); if (links.has(key)) return null; links.add(key);
    }
    const strokes: WhiteboardStroke[] = [];
    if (!legacy) {
      if (!Array.isArray(root.strokes) || root.strokes.length > 5000) return null;
      const strokeIds = new Set<string>(); let points = 0;
      for (const stroke of root.strokes) {
        if (!object(stroke) || !exact(stroke, ["id", "color", "width", "points"]) || !id(stroke.id) || strokeIds.has(stroke.id) || !color(stroke.color) || typeof stroke.width !== "number" || !Number.isFinite(stroke.width) || stroke.width < 1 || stroke.width > 30 || !Array.isArray(stroke.points) || stroke.points.length < 1 || stroke.points.length > 5000 || (points += stroke.points.length) > 100_000) return null;
        for (const p of stroke.points) if (!object(p) || !exact(p, ["x", "y"]) || !position(p.x) || !position(p.y)) return null;
        strokeIds.add(stroke.id); strokes.push(stroke as unknown as WhiteboardStroke);
      }
    }
    return { format: "comet-whiteboard", version: root.version === 3 ? 3 : 2, items, connections: root.connections as unknown as WhiteboardConnection[], strokes };
  } catch { return null; }
}
