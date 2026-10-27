import { joinPath, normalizePath, relativePath, validEntryName, type Entry } from "./vault";

/** All paths shown in the address bar are relative to the open workspace. */
export function displayWorkspacePath(path: string, vault: string): string {
  if (!path || normalizePath(path) === normalizePath(vault)) return "Comet";
  return `Comet\\${relativePath(path, vault).replace(/\//g, "\\")}`;
}

export type PathPlan =
  | { kind: "root" }
  | { kind: "folder" | "note"; path: string }
  | { kind: "create"; path: string; missingFolders: string[] }
  | { kind: "error"; message: string };

/**
 * Interpret an address without touching the filesystem. Existing names are
 * resolved from the listing; missing segments are validated before creation.
 * The native bridge performs its own containment and exclusive-create checks.
 */
export function planWorkspacePath(input: string, vault: string, entries: Entry[]): PathPlan {
  const raw = input.trim();
  if (!raw) return { kind: "error", message: "Enter a workspace path." };
  if (/^(?:[\\/]|[a-z][a-z0-9+.-]*:)/i.test(raw)) {
    return { kind: "error", message: "Use a path inside this workspace, not an absolute path or URL." };
  }

  const trailingSlash = /[\\/]$/.test(raw);
  const parts = raw.split(/[\\/]/).map((part) => part.trim());
  if (parts.some((part, index) => (!part && index !== parts.length - 1) || part === "." || part === ".." || /[\u0000-\u001f]/.test(part))) {
    return { kind: "error", message: "Use folder and file names inside the workspace; . and .. are not allowed." };
  }
  if (!parts[parts.length - 1]) parts.pop();
  if (parts[0]?.toLowerCase() === "comet") parts.shift();
  if (!parts.length) return { kind: "root" };

  // Windows paths are case-insensitive. Use the spelling from the listing
  // whenever possible, while keeping case-distinct Unix filenames distinct.
  const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(vault);
  const findEntry = (path: string) => {
    const key = normalizePath(path);
    return entries.find((entry) => normalizePath(entry.path) === key)
      ?? (windows ? entries.find((entry) => normalizePath(entry.path).toLowerCase() === key.toLowerCase()) : undefined);
  };

  let folder = vault;
  const missingFolders: string[] = [];
  for (const name of parts.slice(0, -1)) {
    const candidate = joinPath(folder, name);
    const existing = findEntry(candidate);
    if (existing?.kind === "file") return { kind: "error", message: `“${name}” is a file, not a folder.` };
    if (existing) {
      folder = existing.path;
    } else {
      if (validEntryName(name, "folder").error) return { kind: "error", message: `“${name}” is not a valid folder name.` };
      folder = candidate;
      missingFolders.push(candidate);
    }
  }

  const name = parts[parts.length - 1];
  const candidate = joinPath(folder, name);
  const existing = findEntry(candidate);
  if (existing?.kind === "folder") return { kind: "folder", path: existing.path };
  if (existing?.kind === "file") {
    if (trailingSlash) return { kind: "error", message: `“${name}” is a file, not a folder.` };
    return { kind: "note", path: existing.path };
  }
  if (trailingSlash) return { kind: "error", message: "That folder doesn't exist yet. Enter a note name after it to create both." };
  const validated = validEntryName(name, "note");
  if (validated.error) return { kind: "error", message: validated.error };
  const path = joinPath(folder, validated.name);
  // A path without .md may resolve to an existing note after adding it.
  const note = findEntry(path);
  if (note?.kind === "file") return { kind: "note", path: note.path };
  if (note?.kind === "folder") return { kind: "error", message: "A folder already has that note name." };
  return { kind: "create", path, missingFolders };
}
