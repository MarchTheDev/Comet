import { fileName } from "./vault";

export type FileKind = "markdown" | "text" | "image" | "audio" | "video" | "pdf" | "link" | "todo" | "other";
const TEXT_EXTENSIONS = new Set(["txt", "text", "log", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "html", "htm", "css", "js", "jsx", "ts", "tsx", "py", "rs", "sh", "sql", "tex", "rst"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "opus", "m4a", "aac", "flac", "weba"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "m4v", "mov", "ogv"]);

export function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileKind(path: string): FileKind {
  const extension = extensionOf(path);
  if (extension === "md" || extension === "markdown") return "markdown";
  if (!extension || TEXT_EXTENSIONS.has(extension)) return "text";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (extension === "pdf") return "pdf";
  if (extension === "url") return "link";
  if (extension === "comet-todo") return "todo";
  return "other";
}

/** Unknown extensions are only offered for text editing after an explicit user action. */
export function isTextFile(path: string): boolean {
  return fileKind(path) === "markdown" || fileKind(path) === "text";
}

export function fileKindLabel(path: string): string {
  const kind = fileKind(path);
  if (kind === "markdown") return "Markdown";
  if (kind === "text") return "Text file";
  if (kind === "image") return "Image";
  if (kind === "audio") return "Audio";
  if (kind === "video") return "Video";
  if (kind === "pdf") return "PDF document";
  if (kind === "link") return "Web link";
  if (kind === "todo") return "To-do board";
  const extension = extensionOf(path);
  return extension ? `${extension.toUpperCase()} file` : "File";
}

/** Extract only well-formed YouTube IDs; no user-provided URL is placed into an iframe. */
export function youtubeIds(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()\]]+/gi) ?? [];
  const ids = new Set<string>();
  for (const value of matches) {
    try {
      const url = new URL(value.replace(/[.,!?]+$/, ""));
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      let id = "";
      if (host === "youtu.be") id = url.pathname.split("/")[1] ?? "";
      else if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
        id = url.pathname === "/watch" ? (url.searchParams.get("v") ?? "") : (/^\/(?:embed|shorts)\/([^/]+)/.exec(url.pathname)?.[1] ?? "");
      }
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) ids.add(id);
    } catch {
      // Ignore incomplete URLs while the user is typing.
    }
  }
  return [...ids];
}
