import { fileName } from "./vault";
import { SAMPLE_ROOT } from "./sampleVault";

const KEY = "comet:vault-list:v2";
const LEGACY_KEY = "comet:vault-list:v1";
type Store = Pick<Storage, "getItem" | "setItem">;
function storage(): Store | undefined { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; } }
const valid = (path: unknown): path is string => typeof path === "string" && Boolean(path) && (!path.startsWith("comet-sample://") || path === SAMPLE_ROOT);

/** The v2 list includes the sample explicitly, so removing it remains intentional. */
export function readVaultList(store: Store | undefined = storage()): string[] {
  try {
    const saved = store?.getItem(KEY);
    if (saved !== null && saved !== undefined) {
      const parsed: unknown = JSON.parse(saved);
      return Array.isArray(parsed) ? [...new Set(parsed.filter(valid))].slice(0, 21) : [SAMPLE_ROOT];
    }
    const legacy: unknown = JSON.parse(store?.getItem(LEGACY_KEY) ?? "[]");
    return [SAMPLE_ROOT, ...(Array.isArray(legacy) ? [...new Set(legacy.filter(valid).filter((path) => path !== SAMPLE_ROOT))].slice(0, 20) : [])];
  } catch { return [SAMPLE_ROOT]; }
}
export function saveVaultList(paths: string[], store: Store | undefined = storage()): boolean {
  try { if (!store) return false; store.setItem(KEY, JSON.stringify([...new Set(paths.filter(valid))].slice(0, 21))); return true; } catch { return false; }
}
export function reorderVaults(paths: string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !paths.includes(source) || !paths.includes(target)) return paths;
  const next = paths.filter((path) => path !== source); const index = next.indexOf(target);
  next.splice(index + (after ? 1 : 0), 0, source); return next;
}
export function vaultLabel(path: string): string { return fileName(path) || path; }
