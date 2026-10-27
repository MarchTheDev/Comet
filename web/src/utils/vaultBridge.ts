import { invoke, isTauri } from "@tauri-apps/api/core";
import { sampleVault, SAMPLE_ROOT } from "./sampleVault";
import { fileName, joinPath, type Entry, type SearchHit } from "./vault";

export const desktopAvailable = isTauri();
export const isSamplePath = (path: string) => path === SAMPLE_ROOT || path.startsWith(`${SAMPLE_ROOT}/`);

export async function listVault(path: string): Promise<Entry[]> {
  return isSamplePath(path) ? sampleVault.list() : invoke<Entry[]>("list_vault", { path });
}

export async function readNote(vault: string, path: string): Promise<string> {
  return isSamplePath(vault) ? sampleVault.read(path) : invoke<string>("read_note", { vault, path });
}

export async function writeNote(vault: string, path: string, content: string): Promise<void> {
  if (isSamplePath(vault)) sampleVault.write(path, content);
  else await invoke("write_note", { vault, path, content });
}

export async function createNote(vault: string, path: string, content: string): Promise<void> {
  if (isSamplePath(vault)) sampleVault.createNote(path, content);
  else await invoke("create_note", { vault, path, content });
}

export async function createFolder(vault: string, path: string): Promise<void> {
  if (isSamplePath(vault)) sampleVault.createFolder(path);
  else await invoke("create_dir", { vault, path });
}

export async function restoreVaultAccess(path: string): Promise<void> {
  if (!isSamplePath(path)) await invoke("restore_vault_access", { path });
}

export async function renameEntry(vault: string, path: string, destination: string): Promise<void> {
  if (isSamplePath(vault)) sampleVault.rename(path, destination);
  else await invoke("rename_entry", { vault, path, newName: fileName(destination) });
}

export async function moveEntry(vault: string, path: string, folder: string): Promise<string> {
  return isSamplePath(vault) ? sampleVault.move(path, folder) : invoke<string>("move_entry", { vault, path, folder });
}

export async function importFile(vault: string, src: string, dest: string): Promise<void> {
  if (isSamplePath(vault)) throw new Error("Use the browser file picker to add files to the sample.");
  await invoke("copy_asset", { vault, src, dest: joinPath(dest, fileName(src)) });
}

export async function deleteEntry(vault: string, path: string): Promise<void> {
  if (isSamplePath(vault)) sampleVault.remove(path);
  else await invoke("delete_entry", { vault, path });
}

export async function searchVault(vault: string, query: string): Promise<SearchHit[]> {
  return isSamplePath(vault) ? sampleVault.search(query) : invoke<SearchHit[]>("search_vault", { vault, query });
}
