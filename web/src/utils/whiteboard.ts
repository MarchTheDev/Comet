import { TODO_CONNECTION_COLOR, TODO_MAX_COORD, todoId } from "./todo";
export type WhiteboardItemType = "text" | "todo" | "image" | "shape";
export interface WhiteboardItem { id: string; type: WhiteboardItemType; x: number; y: number; text: string; done: boolean; color: string; image: string }
export interface WhiteboardConnection { from: string; to: string; color: string }
export interface WhiteboardDocument { format: "comet-whiteboard"; version: 1; items: WhiteboardItem[]; connections: WhiteboardConnection[] }
export const newWhiteboard = (): WhiteboardDocument => ({ format: "comet-whiteboard", version: 1, items: [], connections: [] });
export const serializeWhiteboard = (board: WhiteboardDocument): string => `${JSON.stringify(board, null, 2)}\n`;
export function newWhiteboardItem(type: WhiteboardItemType, x: number, y: number, image = ""): WhiteboardItem { return { id: todoId(), type, x, y, text: "", done: false, color: "#9c9fe1", image }; }
export { TODO_CONNECTION_COLOR };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const color = (value: unknown) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;
export function parseWhiteboard(text: string): WhiteboardDocument | null {
  try {
    const root: unknown = JSON.parse(text);
    if (!object(root) || !exact(root, ["format", "version", "items", "connections"]) || root.format !== "comet-whiteboard" || root.version !== 1 || !Array.isArray(root.items) || root.items.length > 1000 || !Array.isArray(root.connections) || root.connections.length > 5000) return null;
    const ids = new Set<string>();
    for (const item of root.items) {
      if (!object(item) || !exact(item, ["id", "type", "x", "y", "text", "done", "color", "image"]) || !id(item.id) || ids.has(item.id) || !["text", "todo", "image", "shape"].includes(String(item.type)) || typeof item.text !== "string" || item.text.length > 10000 || typeof item.done !== "boolean" || !color(item.color) || typeof item.x !== "number" || !Number.isFinite(item.x) || item.x < 0 || item.x > TODO_MAX_COORD || typeof item.y !== "number" || !Number.isFinite(item.y) || item.y < 0 || item.y > TODO_MAX_COORD || typeof item.image !== "string") return null;
      if (item.type === "image" ? (item.image.length > 2_900_000 || !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(item.image)) : item.image !== "") return null;
      ids.add(item.id);
    }
    const links = new Set<string>();
    for (const edge of root.connections) {
      if (!object(edge) || !exact(edge, ["from", "to", "color"]) || !id(edge.from) || !id(edge.to) || edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to) || !color(edge.color)) return null;
      const key = JSON.stringify([edge.from, edge.to]); if (links.has(key)) return null; links.add(key);
    }
    return root as unknown as WhiteboardDocument;
  } catch { return null; }
}
