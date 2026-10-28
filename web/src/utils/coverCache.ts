// Artwork is optional and never touches the workspace. A small device-local
// cache keeps successful lookups across views and app restarts.
export interface CachedCover { url: string; blob?: Blob }
const INDEX_KEY = "comet:cover-art:v1";
const MAX_ENTRIES = 100;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function validCoverUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "mzstatic.com" || url.hostname.endsWith(".mzstatic.com")) && !url.username && !url.password; } catch { return false; }
}
function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      const request = indexedDB.open("comet-media-cache", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("covers");
      request.onerror = () => resolve(null); request.onblocked = () => resolve(null);
      request.onsuccess = () => resolve(request.result);
    } catch { resolve(null); }
  });
}
function readIndex(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(INDEX_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => key.length <= 1000 && typeof value === "string" && validCoverUrl(value)).slice(-MAX_ENTRIES)) as Record<string, string>;
  } catch { return {}; }
}
export function createCoverCache() {
const memory = new Map<string, CachedCover>();
async function readCover(key: string): Promise<CachedCover | null> {
  const cached = memory.get(key); if (cached) return cached;
  const url = readIndex()[key]; if (!url) return null;
  const db = await openDatabase();
  if (db) {
    try {
      const value = await new Promise<unknown>((resolve) => { const transaction = db.transaction("covers", "readonly"); const request = transaction.objectStore("covers").get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => resolve(null); });
      // Version 1 originally stored only a Blob. New entries bind image bytes
      // to their URL so an interrupted replacement cannot resurrect old art.
      const blob = value instanceof Blob ? value : value && typeof value === "object" && "url" in value && value.url === url && "blob" in value ? value.blob : undefined;
      if (blob instanceof Blob && blob.size <= MAX_IMAGE_BYTES && /^image\/(?:jpeg|png|gif|webp)$/i.test(blob.type)) { const result = { url, blob }; memory.set(key, result); db.close(); return result; }
    } catch { /* A URL remains useful if device storage is unavailable. */ }
    db.close();
  }
  const result = { url }; memory.set(key, result); return result;
}
async function saveCover(key: string, url: string, blob?: Blob): Promise<void> {
  if (!validCoverUrl(url) || key.length > 1000) return;
  const safeBlob = blob && blob.size <= MAX_IMAGE_BYTES && /^image\/(?:jpeg|png|gif|webp)$/i.test(blob.type) ? blob : undefined;
  memory.delete(key); memory.set(key, { url, blob: safeBlob });
  while (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value!);
  let evicted: string[] = [], indexed = false;
  try {
    const index = readIndex(); delete index[key]; index[key] = url;
    const keys = Object.keys(index); evicted = keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)); evicted.forEach((old) => { delete index[old]; memory.delete(old); });
    localStorage.setItem(INDEX_KEY, JSON.stringify(index)); indexed = true;
  } catch { /* Keep the bounded in-memory result when storage is full or disabled. */ }
  // Without the index an IndexedDB blob could become unreachable and accumulate.
  if (!indexed) return;
  const db = await openDatabase(); if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const transaction = db.transaction("covers", "readwrite");
      const store = transaction.objectStore("covers"); evicted.forEach((old) => store.delete(old));
      if (safeBlob) store.put({ url, blob: safeBlob }, key); else store.delete(key);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => resolve(); transaction.onabort = () => resolve();
    });
  } catch { /* Caching must never interrupt playback. */ }
  db.close();
}
return { readCover, saveCover };
}
export const { readCover, saveCover } = createCoverCache();

/** Bound downloaded artwork even if a server does not send Content-Length. */
export async function downloadCover(url: string, signal: AbortSignal): Promise<Blob | undefined> {
  const response = await fetch(url, { signal });
  const type = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? "";
  if (!response.ok || !response.body || !/^image\/(?:jpeg|png|gif|webp)$/.test(type) || Number(response.headers.get("content-length") || 0) > MAX_IMAGE_BYTES) return undefined;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_IMAGE_BYTES) { await reader.cancel(); return undefined; } chunks.push(value); }
    return new Blob(chunks.map((chunk) => Uint8Array.from(chunk)), { type });
  } finally { reader.releaseLock(); }
}
