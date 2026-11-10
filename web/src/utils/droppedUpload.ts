export const DROPPED_CHUNK_BYTES = 512 * 1024;
type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Stream a browser File through bounded native IPC; a failed transfer is never published. */
export async function streamDroppedFile(file: File, vault: string, path: string, invoke: Invoke, onProgress: (loaded: number, total: number) => void, stillCurrent: () => boolean): Promise<void> {
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Couldn't determine this file's size.");
  if (!stillCurrent()) throw new Error("The workspace changed; the file was not added.");
  const id = await invoke("begin_dropped_upload", { vault, path, size: file.size });
  if (typeof id !== "string" || !id) throw new Error("Couldn't start the file import.");
  let finished = false;
  try {
    onProgress(0, file.size);
    for (let offset = 0; offset < file.size;) {
      if (!stillCurrent()) throw new Error("The workspace changed; the file was not added.");
      const end = Math.min(file.size, offset + DROPPED_CHUNK_BYTES);
      const data = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      if (data.length !== end - offset) throw new Error("The file changed or could not be read completely.");
      if (!stillCurrent()) throw new Error("The workspace changed; the file was not added.");
      await invoke("append_dropped_upload", { id, offset, bytes: Array.from(data) });
      offset = end; onProgress(offset, file.size);
    }
    if (!stillCurrent()) throw new Error("The workspace changed; the file was not added.");
    await invoke("finish_dropped_upload", { id }); finished = true;
  } finally {
    if (!finished) await invoke("abort_dropped_upload", { id }).catch(() => undefined);
  }
}

/** Reject only when the browser's actual localStorage cannot fit even a lower
 * bound of the imported data. This avoids reading a huge file into memory in
 * the sample workspace, whose backing store is localStorage rather than disk. */
export function ensureSampleStorageCapacity(size: number, text: boolean, storage: Storage): void {
  const minimum = text ? Math.floor(size / 4) : Math.ceil(size / 3) * 4;
  if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error("The browser can't store this file. Use a desktop workspace instead.");
  if (!minimum) return;
  const key = `comet:sample-quota-probe:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  try {
    let count = Math.min(minimum, 64 * 1024), probe = "x".repeat(count);
    for (;;) {
      storage.setItem(key, probe);
      if (count >= minimum) break;
      const next = Math.min(minimum, count * 2);
      probe += "x".repeat(next - count); count = next;
    }
  } catch {
    throw new Error("The browser's sample storage is full or can't hold this file. Use a desktop workspace for larger files.");
  } finally { try { storage.removeItem(key); } catch { /* storage may be unavailable */ } }
}
