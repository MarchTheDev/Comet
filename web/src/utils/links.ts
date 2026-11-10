import { youtubeIds } from "./fileTypes";

/** Accept only ordinary web URLs; never allow script, file, or credentials. */
export function safeWebUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
export function parseShortcut(value: string): string | null {
  // Standard Windows Internet Shortcut format; ignore any other fields.
  const match = /^URL\s*=\s*(.+)$/im.exec(value);
  return match ? safeWebUrl(match[1]) : null;
}
export function serializeShortcut(url: string): string {
  const safe = safeWebUrl(url);
  if (!safe) throw new Error("Use a complete HTTP or HTTPS link.");
  return `[InternetShortcut]\nURL=${safe}\n`;
}
export type VideoLink = { kind: "youtube"; id: string } | { kind: "video"; url: string };
export function videoLink(value: string): VideoLink | null {
  const url = safeWebUrl(value);
  if (!url) return null;
  const id = youtubeIds(url)[0];
  if (id) return { kind: "youtube", id };
  const pathname = new URL(url).pathname;
  return /\.(?:mp4|webm|m4v|mov|ogv)$/i.test(pathname) ? { kind: "video", url } : null;
}
export function firstDroppedUrl(uriList: string, text: string): string | null {
  for (const line of `${uriList}\n${text}`.split(/[\r\n]+/)) {
    if (!line.startsWith("#")) { const url = safeWebUrl(line); if (url) return url; }
  }
  return null;
}
