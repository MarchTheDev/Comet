import { isPathInside } from "./vault";

const STORAGE_KEY = "comet:last-workspace:v1";
const SAMPLE_NOTE_KEY = "comet:sample-selected-note:v1";

export interface WorkspaceSession {
  vault: string;
  note: string;
}

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): SessionStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Only paths are remembered here; notes themselves stay in their vault. */
export function readSession(store: SessionStorage | undefined = storage()): WorkspaceSession | null {
  try {
    const value = store?.getItem(STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<WorkspaceSession>;
    if (typeof parsed.vault !== "string" || !parsed.vault || parsed.vault.startsWith("comet-sample://")) return null;
    const note = typeof parsed.note === "string" && isPathInside(parsed.note, parsed.vault) ? parsed.note : "";
    return { vault: parsed.vault, note };
  } catch {
    return null;
  }
}

export function saveSession(session: WorkspaceSession, store: SessionStorage | undefined = storage()): void {
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Reopening is a convenience; inaccessible browser storage must not block notes.
  }
}

export function readSampleSelection(store: SessionStorage | undefined = storage()): string {
  try {
    const path = store?.getItem(SAMPLE_NOTE_KEY) ?? "";
    return path.startsWith("comet-sample://") ? path : "";
  } catch {
    return "";
  }
}

export function saveSampleSelection(path: string, store: SessionStorage | undefined = storage()): void {
  try {
    if (path.startsWith("comet-sample://")) store?.setItem(SAMPLE_NOTE_KEY, path);
    else store?.removeItem(SAMPLE_NOTE_KEY);
  } catch {
    // Selection persistence is optional, just like the sample storage itself.
  }
}

export function clearSession(store: SessionStorage | undefined = storage()): void {
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    // A missing preference is harmless.
  }
}
