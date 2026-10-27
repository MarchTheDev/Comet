/** Bound ZIP archives before handing them to an EPUB parser; reject ZIP64,
 * encrypted entries, traversal and declared decompression bombs. */
export function validateEpubArchive(buffer: ArrayBuffer): void {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (bytes.length < 22 || bytes.length > 100 * 1024 * 1024) throw new Error("EPUB must be between 22 bytes and 100 MB.");
  let end = -1;
  for (let i = bytes.length - 22, min = Math.max(0, bytes.length - 65557); i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("This is not a supported EPUB archive.");
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
  if (!count || count > 5000 || count === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size > end) throw new Error("This EPUB is too large or uses unsupported ZIP64.");
  let cursor = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > offset + size || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("This EPUB archive is damaged.");
    const flags = view.getUint16(cursor + 8, true), uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extra + comment;
    if (next > offset + size || (flags & 1) || uncompressed === 0xffffffff || uncompressed > 40 * 1024 * 1024) throw new Error("This EPUB contains an encrypted or oversized entry.");
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || name.split("/").includes("..")) throw new Error("This EPUB contains an unsafe path.");
    total += uncompressed; if (total > 150 * 1024 * 1024) throw new Error("This EPUB expands beyond the safe reading limit.");
    cursor = next;
  }
  if (cursor !== offset + size) throw new Error("This EPUB archive is damaged.");
}
