/** Keep saved text readable by the native 16 MiB UTF-8 reader. */
export const MAX_EDITABLE_BYTES = 16 * 1024 * 1024;
export function editableTextError(content: string): string | null {
  if (content.includes("\0")) return "This text contains a NUL character and cannot be saved as an editable file.";
  // Every UTF-16 code unit uses at most three UTF-8 bytes. Avoid encoding the
  // common small case, but measure larger strings rather than guessing.
  if (content.length > MAX_EDITABLE_BYTES || (content.length > MAX_EDITABLE_BYTES / 3 && new TextEncoder().encode(content).byteLength > MAX_EDITABLE_BYTES)) {
    return "Text files are limited to 16 MB. Reduce the text before saving.";
  }
  return null;
}
