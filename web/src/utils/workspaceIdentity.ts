import { normalizePath } from "./vault";
export interface WorkspaceIdentity { name: string; icon: string }
export type WorkspaceIdentities = Record<string, WorkspaceIdentity>;
const KEY = "comet:workspace-identities:v1";
type Store = Pick<Storage, "getItem" | "setItem">;
function storage(): Store | undefined { try { return window.localStorage; } catch { return undefined; } }
export function readWorkspaceIdentities(store: Store | undefined = storage()): WorkspaceIdentities {
  try {
    const value: unknown = JSON.parse(store?.getItem(KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: WorkspaceIdentities = {};
    for (const [path, raw] of Object.entries(value)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.name === "string" && typeof item.icon === "string" && item.name.length <= 60 && [...item.icon].length <= 8) result[normalizePath(path)] = { name: item.name, icon: item.icon };
    }
    return result;
  } catch { return {}; }
}
export function saveWorkspaceIdentities(value: WorkspaceIdentities, store: Store | undefined = storage()): boolean {
  try { if (!store) return false; store.setItem(KEY, JSON.stringify(value)); return true; } catch { return false; }
}
export function identityFor(items: WorkspaceIdentities, path: string, fallback: string): WorkspaceIdentity {
  const item = items[normalizePath(path)];
  return { name: item?.name.trim() || fallback, icon: item?.icon.trim() || (item?.name.trim() || fallback).slice(0, 1).toUpperCase() };
}
