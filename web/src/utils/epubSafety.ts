import { Inflate } from "fflate";
const LIMIT = 100 * 1024 * 1024;

/** Read with an actual byte limit even when a server omits or lies about Content-Length. */
export async function boundedEpubResponse(response: Response, maximum = LIMIT): Promise<ArrayBuffer> {
  const limit = Math.min(LIMIT, Math.max(0, maximum));
  if (!response.ok) throw new Error("The file could not be read.");
  if (Number(response.headers.get("content-length") || 0) > limit) throw new Error("EPUB files are limited to 100 MB.");
  if (!response.body) throw new Error("This device cannot safely read the EPUB stream.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new Error("EPUB files are limited to 100 MB."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

/** Check central and local ZIP records and *actual* deflate output before
 * handing an EPUB to JSZip. Streaming inflation catches forged size fields. */
export function validateEpubArchive(buffer: ArrayBuffer): void {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (bytes.length < 22 || bytes.length > LIMIT) throw new Error("EPUB must be between 22 bytes and 100 MB.");
  let end = -1;
  for (let i = bytes.length - 22, min = Math.max(0, bytes.length - 65557); i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("This is not a supported EPUB archive.");
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
  if (!count || count !== view.getUint16(end + 8, true) || count > 5000 || count === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size > end) throw new Error("This EPUB is too large or uses unsupported ZIP64.");
  let cursor = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > offset + size || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("This EPUB archive is damaged.");
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), compressed = view.getUint32(cursor + 20, true), uncompressed = view.getUint32(cursor + 24, true), local = view.getUint32(cursor + 42, true);
    const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extra + comment;
    if (next > offset + size || (flags & 1) || ![0, 8].includes(method) || [compressed, uncompressed, local].includes(0xffffffff) || uncompressed > 40 * 1024 * 1024) throw new Error("This EPUB contains an encrypted, unsupported or oversized entry.");
    const centralName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder().decode(centralName);
    if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || name.split("/").includes("..")) throw new Error("This EPUB contains an unsafe path.");
    if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) throw new Error("This EPUB archive is damaged.");
    const localNameLength = view.getUint16(local + 26, true), localExtraLength = view.getUint16(local + 28, true), dataStart = local + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressed;
    if (dataEnd > offset || localNameLength !== nameLength || !centralName.every((byte, index) => byte === bytes[local + 30 + index])) throw new Error("This EPUB archive is damaged.");
    if (method === 0) { if (compressed !== uncompressed) throw new Error("This EPUB archive is damaged."); }
    else {
      let actual = 0;
      try {
        const inflate = new Inflate((chunk) => { actual += chunk.length; if (actual > uncompressed || actual > 40 * 1024 * 1024) throw new Error("Oversized entry"); });
        // Small input slices bound transient inflate output even for malicious streams.
        if (!compressed) inflate.push(new Uint8Array(), true);
        for (let start = dataStart; start < dataEnd; start += 256) inflate.push(bytes.subarray(start, Math.min(start + 256, dataEnd)), start + 256 >= dataEnd);
      } catch { throw new Error("This EPUB contains invalid or oversized compressed data."); }
      if (actual !== uncompressed) throw new Error("This EPUB contains invalid compressed data.");
    }
    total += uncompressed; if (total > 150 * 1024 * 1024) throw new Error("This EPUB expands beyond the safe reading limit.");
    cursor = next;
  }
  if (cursor !== offset + size) throw new Error("This EPUB archive is damaged.");
}

/** Resolve a table-of-contents link against the navigation file, but only
 * return targets already present in the book's own validated reading spine. */
export function resolveEpubSection(href: string, navigationPath: string, packagePath: string, spine: string[]): string | null {
  const relative = (value: string) => {
    try {
      const decoded = decodeURIComponent(value);
      return !!decoded && decoded.length <= 2000 && decoded === decoded.trim() && !/[\x00-\x1f\\]/.test(decoded) && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(decoded);
    } catch { return false; }
  };
  if (!relative(href) || !relative(navigationPath) || !relative(packagePath)) return null;
  try {
    const packageUrl = new URL(packagePath, "https://epub.invalid/");
    const navUrl = new URL(navigationPath, packageUrl), target = new URL(href, navUrl);
    if (packageUrl.origin !== "https://epub.invalid" || navUrl.origin !== packageUrl.origin || target.origin !== packageUrl.origin) return null;
    const match = spine.find((item) => {
      if (!relative(item)) return false;
      const candidate = new URL(item, packageUrl);
      return candidate.origin === packageUrl.origin && decodeURI(candidate.pathname) === decodeURI(target.pathname);
    });
    return match ? `${match.split("#", 1)[0]}${target.hash}` : null;
  } catch { return null; }
}
