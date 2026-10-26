export interface Entry {
  name: string;
  path: string;
  kind: "folder" | "file";
}

export interface TreeNode extends Entry {
  children: TreeNode[];
}

export interface SearchHit {
  path: string;
  name: string;
  snippet: string;
}

/** Paths from Tauri can use either separator, depending on the OS. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function fileName(path: string): string {
  return normalizePath(path).split("/").pop() || path;
}

export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  return path.includes("\\") && !path.includes("/") ? parent.replace(/\//g, "\\") : parent;
}

export function joinPath(folder: string, name: string): string {
  const separator = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function relativePath(path: string, vault: string): string {
  const normalized = normalizePath(path);
  const root = normalizePath(vault);
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : fileName(path);
}

export function isMarkdown(path: string): boolean {
  return /\.md$/i.test(path);
}

/** Resolve a relative Markdown image without allowing it to escape the vault. */
export function resolveVaultAsset(vault: string, notePath: string, source: string): string | null {
  const root = normalizePath(vault);
  const note = normalizePath(notePath);
  if (!note.startsWith(`${root}/`) || !source || /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(source)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(source).replace(/\\/g, "/");
  } catch {
    return null;
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(decoded)) return null;
  const parts = parentPath(note).split("/");
  const rootDepth = root.split("/").length;
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length <= rootDepth) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const resolved = parts.join("/");
  if (!resolved.startsWith(`${root}/`)) return null;
  return notePath.includes("\\") && !notePath.includes("/") ? resolved.replace(/\//g, "\\") : resolved;
}

/** Build the tree in two passes so it doesn't depend on the order returned by the OS. */
export function buildTree(entries: Entry[], vault: string): TreeNode[] {
  const root = normalizePath(vault);
  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (!path.startsWith(`${root}/`)) continue;
    nodes.set(path, { ...entry, children: [] });
  }

  for (const [path, node] of nodes) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    const parentNode = nodes.get(parent);
    if (parentNode?.kind === "folder") parentNode.children.push(node);
    else roots.push(node);
  }

  const sort = (items: TreeNode[]) => {
    items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    items.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
}

export function validEntryName(value: string, kind: "note" | "folder"): { name: string; error: string } {
  const name = value.trim();
  if (!name) return { name: "", error: `Enter a ${kind} name.` };
  if (name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    return { name: "", error: "Use a name without slashes or special file characters." };
  }
  return { name: kind === "note" && !isMarkdown(name) ? `${name}.md` : name, error: "" };
}
