import { File, FileAudio, FileImage, FileText, FileVideo, FileType2, Link2, ListChecks, Folder, FolderOpen, type LucideIcon } from "lucide-react";
import { fileKind } from "./utils/fileTypes";
import type { Entry } from "./utils/vault";

export function entryIcon(entry: Entry, expanded = false): LucideIcon {
  if (entry.kind === "folder") return expanded ? FolderOpen : Folder;
  const kind = fileKind(entry.path);
  return kind === "image" ? FileImage : kind === "audio" ? FileAudio : kind === "video" ? FileVideo : kind === "pdf" ? FileType2 : kind === "link" ? Link2 : kind === "todo" ? ListChecks : kind === "other" ? File : FileText;
}
export function FileIcon({ entry, size = 18, expanded = false }: { entry: Entry; size?: number; expanded?: boolean }) {
  const Icon = entryIcon(entry, expanded);
  return <Icon size={size} strokeWidth={1.65} aria-hidden="true" />;
}
