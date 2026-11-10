import { invoke } from "@tauri-apps/api/core";
import { desktopAvailable } from "./vaultBridge";

interface WritableFile { write(data: string): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }
interface SaveHandle { createWritable(): Promise<WritableFile> }
interface PickerWindow extends Window { showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<SaveHandle> }
interface BackupBridge {
  desktop: boolean;
  call: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  pick?: () => Promise<SaveHandle>;
}
const suggestedName = "comet-passwords-encrypted.json";
function defaultBridge(): BackupBridge {
  const picker = (window as PickerWindow).showSaveFilePicker;
  return { desktop: desktopAvailable, call: (command, args) => invoke(command, args), pick: picker ? () => picker.call(window, { suggestedName, types: [{ description: "Encrypted Comet backup", accept: { "application/json": [".json"] } }] }) : undefined };
}
/** A picker is mandatory. Desktop writes only via the one-use native capability. */
export async function savePasswordBackup(encrypted: string, current: () => boolean, bridge = defaultBridge()): Promise<boolean> {
  if (!current()) throw new Error("This vault changed elsewhere. Reopen password settings before making a backup.");
  if (bridge.desktop) {
    const token = await bridge.call("choose_password_backup");
    if (token === null || token === undefined) return false;
    if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) throw new Error("Couldn't prepare the backup destination.");
    try {
      if (!current()) throw new Error("This vault changed while the save dialog was open. No backup was written; reopen password settings.");
      await bridge.call("write_password_backup", { token, encrypted });
      return true;
    } catch (error) {
      await bridge.call("cancel_password_backup", { token }).catch(() => {});
      throw error;
    }
  }
  if (!bridge.pick) throw new Error("This browser can't choose a save location. Use Comet's desktop app or a browser with Save As support.");
  let handle: SaveHandle;
  try { handle = await bridge.pick(); }
  catch (error) { if (error instanceof Error && error.name === "AbortError") return false; throw error; }
  if (!current()) throw new Error("This vault changed while the save dialog was open. No backup data was written; reopen password settings.");
  const writable = await handle.createWritable();
  try {
    if (!current()) throw new Error("This vault changed while the save dialog was open. No backup data was written; reopen password settings.");
    await writable.write(encrypted); await writable.close();
  } catch (error) { await writable.abort?.().catch(() => {}); throw error; }
  return true;
}
