import { invoke, isTauri } from "@tauri-apps/api/core";
import { sampleVault, SAMPLE_ROOT } from "./sampleVault";
import type { Entry, SearchHit } from "./vault";

export const desktopAvailable = isTauri();
export const isSamplePath = (path: string) => path === SAMPLE_ROOT || path.startsWith(`${SAMPLE_ROOT}/`);

export async function listVault(path: string): Promise<Entry[]> {
  return isSamplePath(path) ? sampleVault.list() : invoke<Entry[]>("list_vault", { path });
}

export async function readNote(path: string): Promise<string> {
  return isSamplePath(path) ? sampleVault.read(path) : invoke<string>("read_note", { path });
}

export async function writeNote(path: string, content: string): Promise<void> {
  if (isSamplePath(path)) sampleVault.write(path, content);
  else await invoke("write_note", { path, content });
}

export async function createNote(path: string, content: string): Promise<void> {
  if (isSamplePath(path)) sampleVault.createNote(path, content);
  else await invoke("create_note", { path, content });
}

export async function createFolder(path: string): Promise<void> {
  if (isSamplePath(path)) sampleVault.createFolder(path);
  else await invoke("create_dir", { path });
}

export async function searchVault(vault: string, query: string): Promise<SearchHit[]> {
  return isSamplePath(vault) ? sampleVault.search(query) : invoke<SearchHit[]>("search_vault", { vault, query });
}
