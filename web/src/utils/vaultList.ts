import { fileName } from "./vault";

const KEY = "comet:vault-list:v1";
type Store = Pick<Storage, "getItem" | "setItem">;
function storage(): Store | undefined { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; } }

export function readVaultList(store: Store | undefined = storage()): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? [...new Set(parsed.filter((path): path is string => typeof path === "string" && Boolean(path) && !path.startsWith("comet-sample://")))].slice(0, 20) : [];
  } catch { return []; }
}
export function saveVaultList(paths: string[], store: Store | undefined = storage()): boolean {
  try { if (!store) return false; store.setItem(KEY, JSON.stringify([...new Set(paths)].slice(0, 20))); return true; } catch { return false; }
}
export function vaultLabel(path: string): string { return fileName(path) || path; }
