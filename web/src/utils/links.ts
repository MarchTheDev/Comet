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

const SYNTHETIC_LINK_FILE = /\.(?:download|crdownload|part|webloc|url|desktop)$/i;

export interface MinimalDropTransfer {
  files?: ArrayLike<{ name: string; size?: number; type?: string }>;
  getData: (format: string) => string;
}

/**
 * Detect when a user drags a URL / YouTube video from a browser into Comet.
 * Chromium/WebKitGTK often attach a synthetic `watch.download` / `.webloc` file
 * in `dataTransfer.files` alongside `text/uri-list`, which previously caused Comet
 * to import a broken `.download` file instead of a playable link shortcut.
 */
export function droppedBrowserLink(dataTransfer: MinimalDropTransfer | null | undefined): string | null {
  if (!dataTransfer) return null;
  const safeGet = (type: string) => {
    try {
      return dataTransfer.getData(type) || "";
    } catch {
      return "";
    }
  };
  const url =
    firstDroppedUrl(safeGet("text/uri-list") || safeGet("URL"), safeGet("text/plain")) ??
    firstDroppedUrl(safeGet("text/x-moz-url"), "");
  if (!url) return null;

  const files = Array.from(dataTransfer.files ?? []);
  if (files.length === 0) return url;

  const looksLikeBrowserShortcut = files.every(
    (file) =>
      SYNTHETIC_LINK_FILE.test(file.name) ||
      file.size === 0 ||
      file.type === "text/uri-list" ||
      file.type === "text/x-moz-url" ||
      file.type === "application/internet-shortcut",
  );
  if (looksLikeBrowserShortcut || Boolean(videoLink(url))) {
    return url;
  }
  return null;
}

/** Extract a target URL from a browser-dropped `.download` / `.webloc` / `.desktop` / `.url` payload. */
export function parseDroppedShortcutFile(name: string, text: string): string | null {
  if (!SYNTHETIC_LINK_FILE.test(name) || !text || text.length > 32_768) return null;
  const fromIni = parseShortcut(text);
  if (fromIni) return fromIni;
  const plistMatch = /<string>\s*(https?:\/\/[^<\s]+)\s*<\/string>/i.exec(text);
  if (plistMatch) {
    const safe = safeWebUrl(plistMatch[1]);
    if (safe) return safe;
  }
  const urlMatch = /(?:^|\s|url=)(https?:\/\/[^\s"'<>]+)/i.exec(text);
  return urlMatch ? safeWebUrl(urlMatch[1]) : null;
}
