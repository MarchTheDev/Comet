import { isPathInside, normalizePath, parentPath } from "./vault";

export interface WorkspaceTag { id: string; name: string; color: string }
export interface ItemMeta { tags: string[]; pinned: boolean; favorite: boolean }
export interface WorkspaceMeta { tags: WorkspaceTag[]; items: Record<string, ItemMeta>; order: Record<string, string[]> }

const KEY = "comet:workspace-meta:v1:";
type Store = Pick<Storage, "getItem" | "setItem">;
const emptyItem = (): ItemMeta => ({ tags: [], pinned: false, favorite: false });
export const emptyWorkspaceMeta = (): WorkspaceMeta => ({ tags: [], items: {}, order: {} });
const keyFor = (vault: string) => `${KEY}${encodeURIComponent(normalizePath(vault))}`;

function storage(): Store | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** Per-workspace organization is stored on this device, never inside note files. */
export function readWorkspaceMeta(vault: string, store: Store | undefined = storage()): WorkspaceMeta {
  try {
    const raw = store?.getItem(keyFor(vault));
    if (!raw) return emptyWorkspaceMeta();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyWorkspaceMeta();
    const source = parsed as Partial<WorkspaceMeta>;
    const tags = Array.isArray(source.tags) ? source.tags.filter((tag): tag is WorkspaceTag =>
      Boolean(tag && typeof tag.id === "string" && typeof tag.name === "string" && tag.name.trim() && /^#[0-9a-f]{6}$/i.test(tag.color))) : [];
    const tagIds = new Set(tags.map((tag) => tag.id));
    const items: Record<string, ItemMeta> = {};
    if (source.items && typeof source.items === "object" && !Array.isArray(source.items)) {
      for (const [path, item] of Object.entries(source.items)) {
        if (!isPathInside(path, vault) || path === normalizePath(vault) || !item || typeof item !== "object") continue;
        items[path] = {
          tags: Array.isArray(item.tags) ? item.tags.filter((id) => typeof id === "string" && tagIds.has(id)) : [],
          pinned: item.pinned === true,
          favorite: item.favorite === true,
        };
      }
    }
    const order: Record<string, string[]> = {};
    if (source.order && typeof source.order === "object" && !Array.isArray(source.order)) {
      for (const [parent, children] of Object.entries(source.order)) {
        if (!isPathInside(parent, vault) || !Array.isArray(children)) continue;
        order[parent] = children.filter((path): path is string => typeof path === "string" && isPathInside(path, parent) && path !== parent);
      }
    }
    return { tags, items, order };
  } catch { return emptyWorkspaceMeta(); }
}

export function saveWorkspaceMeta(vault: string, meta: WorkspaceMeta, store: Store | undefined = storage()): boolean {
  try { if (!store) return false; store.setItem(keyFor(vault), JSON.stringify(meta)); return true; } catch { return false; }
}

export function itemMeta(meta: WorkspaceMeta, path: string): ItemMeta {
  return meta.items[normalizePath(path)] ?? emptyItem();
}

export function updateItem(meta: WorkspaceMeta, path: string, patch: Partial<ItemMeta>): WorkspaceMeta {
  const key = normalizePath(path);
  return { ...meta, items: { ...meta.items, [key]: { ...itemMeta(meta, key), ...patch } } };
}

export function renameMeta(meta: WorkspaceMeta, from: string, to: string): WorkspaceMeta {
  const source = normalizePath(from), destination = normalizePath(to);
  const remap = (value: string) => value === source || value.startsWith(`${source}/`) ? `${destination}${value.slice(source.length)}` : value;
  const items = Object.fromEntries(Object.entries(meta.items).map(([key, value]) => [remap(key), value]));
  const order = Object.fromEntries(Object.entries(meta.order).map(([key, value]) => {
    const parent = remap(key);
    // A cross-folder move removes the item from its old sibling ordering.
    return [parent, value.map(remap).filter((child) => normalizePath(parentPath(child)) === parent)];
  }));
  return { ...meta, items, order };
}

export function removeMeta(meta: WorkspaceMeta, path: string): WorkspaceMeta {
  const root = normalizePath(path);
  const inside = (value: string) => value === root || value.startsWith(`${root}/`);
  return {
    ...meta,
    items: Object.fromEntries(Object.entries(meta.items).filter(([key]) => !inside(key))),
    order: Object.fromEntries(Object.entries(meta.order).filter(([key]) => !inside(key)).map(([key, value]) => [key, value.filter((item) => !inside(item))])),
  };
}

export function reorderChildren(meta: WorkspaceMeta, parent: string, children: string[], dragged: string, target: string, after: boolean): WorkspaceMeta {
  const key = normalizePath(parent), source = normalizePath(dragged), destination = normalizePath(target);
  const list = children.map(normalizePath).filter((path) => path !== source);
  const index = list.indexOf(destination);
  if (!children.map(normalizePath).includes(source) || index < 0) return meta;
  list.splice(index + (after ? 1 : 0), 0, source);
  return { ...meta, order: { ...meta.order, [key]: list } };
}
