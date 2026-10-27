import { File, BookOpen, Music2, FileImage, FileText, Clapperboard, FileType2, Link2, ListChecks, Square, Folder, FolderOpen, type LucideIcon } from "lucide-react";
import { fileKind } from "./utils/fileTypes";
import type { Entry } from "./utils/vault";

export function entryIcon(entry: Entry, expanded = false): LucideIcon {
  if (entry.kind === "folder") return expanded ? FolderOpen : Folder;
  const kind = fileKind(entry.path);
  return kind === "image" ? FileImage : kind === "audio" ? Music2 : kind === "video" ? Clapperboard : kind === "pdf" ? FileType2 : kind === "ebook" ? BookOpen : kind === "link" ? Link2 : kind === "todo" ? ListChecks : kind === "whiteboard" ? Square : kind === "other" ? File : FileText;
}
export function FileIcon({ entry, size = 18, expanded = false }: { entry: Entry; size?: number; expanded?: boolean }) {
  const Icon = entryIcon(entry, expanded);
  return <Icon className={`file-kind-icon ${entry.kind === "folder" ? "kind-folder" : `kind-${fileKind(entry.path)}`}`} size={size} strokeWidth={1.85} aria-hidden="true" />;
}
