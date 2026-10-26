import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";

interface Entry {
  name: string;
  path: string;
  kind: string;
}

interface TreeNode {
  name: string;
  path: string;
  kind: string;
  children: TreeNode[];
}

interface CtxMenu {
  x: number;
  y: number;
  path: string;
  kind: string;
}

function buildTree(entries: Entry[], vault: string): TreeNode[] {
  const prefix = vault ? vault.replace(/[\\/]+$/, "") + "/" : "";
  const roots: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();

  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const rel = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
    const parts = rel.split("/").filter(Boolean);
    const name = parts[parts.length - 1];
    const node: TreeNode = { name, path: entry.path, kind: entry.kind, children: [] };
    const parentRel = parts.slice(0, -1).join("/");
    const parentKey = parentRel === "" ? "" : prefix + parentRel;
    const parentNode = parentKey === "" ? undefined : folders.get(parentKey);
    const parentChildren = parentNode ? parentNode.children : roots;
    parentChildren.push(node);
    if (entry.kind === "folder") folders.set(entry.path, node);
  }

  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function App() {
  const [vaultPath, setVaultPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureType, setCaptureType] = useState<"text" | "link" | "image">("text");
  const [captureText, setCaptureText] = useState("");
  const [captureStatus, setCaptureStatus] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ path: string; name: string; snippet: string }[]>([]);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [status, setStatus] = useState("ready");

  const loadingRef = useRef(false);
  const saveTimer = useRef<number | null>(null);

  const tree = useMemo(() => buildTree(entries, vaultPath), [entries, vaultPath]);
  const selectedName = selectedPath ? selectedPath.split(/[\\/]+/).pop() ?? "" : "";

  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: "",
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "comet-editor-prose",
        spellcheck: "false",
      },
    },
    onUpdate: ({ editor }) => {
      if (loadingRef.current) return;
      const md = (editor.storage as { markdown?: { getMarkdown?: () => string } }).markdown?.getMarkdown?.() ?? "";
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        if (selectedPath) void invoke("write_note", { path: selectedPath, content: md });
      }, 300);
    },
  });

  const refresh = useCallback(async (vault: string) => {
    const e = await invoke<Entry[]>("list_vault", { path: vault });
    setEntries(e);
  }, []);

  useEffect(() => {
    if (vaultPath) void refresh(vaultPath);
  }, [vaultPath, refresh]);

  useEffect(() => {
    if (!selectedPath || !editor) return;
    loadingRef.current = true;
    invoke<string>("read_note", { path: selectedPath }).then((c) => {
      editor.commands.setContent(c, { contentType: "markdown" });
      // allow update handler after load settles
      requestAnimationFrame(() => {
        loadingRef.current = false;
      });
    });
  }, [selectedPath, editor]);

  useEffect(() => {
    if (!vaultPath || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      invoke<{ path: string; name: string; snippet: string }[]>("search_vault", {
        vault: vaultPath,
        query: searchQuery,
      }).then((r) => {
        if (live) setSearchResults(r);
      });
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [vaultPath, searchQuery]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openCapture();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setExplorerOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") {
        if (captureOpen) closeCapture();
        if (ctx) setCtx(null);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureOpen, ctx]);

  const openVault = async () => {
    const p = await open({ directory: true });
    if (p) {
      setVaultPath(p);
      setStatus(`vault: ${p}`);
    }
  };

  const openCapture = () => {
    setCaptureText("");
    setCaptureStatus("");
    setCaptureOpen(true);
  };

  const closeCapture = () => setCaptureOpen(false);

  const saveCapture = async () => {
    if (!vaultPath) {
      setCaptureStatus("open a vault first");
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const folder = `${vaultPath.replace(/[\\/]+$/, "")}/Inbox`;
    const path = `${folder}/${stamp}.md`;
    let body = captureText.trim();
    if (captureType === "link") body = `[link](${body})`;
    await invoke("create_note", { path, content: body });
    await refresh(vaultPath);
    setCaptureStatus("saved");
    setTimeout(() => setCaptureOpen(false), 600);
  };

  const pickImage = async () => {
    const src = await open({ multiple: false });
    if (!src || Array.isArray(src)) return;
    const name = src.split(/[\\/]+/).pop() ?? "image.png";
    const dest = `${vaultPath.replace(/[\\/]+$/, "")}/assets/${name}`;
    await invoke("copy_asset", { src, dest });
    const rel = `./assets/${name}`;
    setCaptureText((t) => (t ? `${t}\n\n![](${rel})` : `![](${rel})`));
    setCaptureType("image");
  };

  const newNote = async (folder: string) => {
    const name = window.prompt("note name", "untitled.md");
    if (!name) return;
    const path = `${folder.replace(/[\\/]+$/, "")}/${name.endsWith(".md") ? name : name + ".md"}`;
    await invoke("create_note", { path, content: "" });
    await refresh(vaultPath);
    setSelectedPath(path);
  };

  const newFolder = async (folder: string) => {
    const name = window.prompt("folder name", "new folder");
    if (!name) return;
    await invoke("create_dir", { path: `${folder.replace(/[\\/]+$/, "")}/${name}` });
    await refresh(vaultPath);
  };

  return (
    <div className="comet-root" onClick={() => setCtx(null)}>
      <header className="comet-topbar">
        <div className="comet-brand">[ * ] COMET</div>
        <input
          className="comet-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="search notes..."
          spellCheck={false}
        />
        <div className="comet-vault">{vaultPath || "no vault"}</div>
        <div className="comet-actions">
          <button className="comet-btn" onClick={() => void openVault()}>[ open vault ]</button>
          <button className="comet-btn" onClick={openCapture}>[ capture ]</button>
          <button className="comet-btn" onClick={() => setExplorerOpen((o) => !o)}>[ explorer ]</button>
        </div>
      </header>
      <div className="comet-main">
        {explorerOpen && (
          <aside className="comet-pane comet-explorer">
            <div className="comet-pane-title">explorer</div>
            <div className="comet-tree">
              {tree.length === 0 && <div className="comet-empty">empty vault</div>}
              {tree.map((node) => (
                <TreeNodeView
                  key={node.path}
                  node={node}
                  depth={0}
                  selectedPath={selectedPath}
                  onSelect={setSelectedPath}
                  onContext={(e, n) => {
                    e.preventDefault();
                    setCtx({ x: e.clientX, y: e.clientY, path: n.path, kind: n.kind });
                  }}
                />
              ))}
              {searchResults.length > 0 && (
                <div className="comet-search-results">
                  <div className="comet-pane-title">results</div>
                  {searchResults.map((r) => (
                    <div
                      key={r.path}
                      className="comet-search-hit"
                      onClick={() => {
                        setSelectedPath(r.path);
                        setSearchQuery("");
                      }}
                    >
                      <div className="comet-search-name">{r.name}</div>
                      <div className="comet-search-snippet">{r.snippet}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}
        <section className="comet-pane comet-editor">
          <div className="comet-pane-title">{selectedName || "untitled"}</div>
          <div className="comet-editor-area">
            <EditorContent editor={editor} />
          </div>
        </section>
      </div>
      <footer className="comet-statusbar">
        <span>{status}</span>
        <span>{selectedPath ? selectedPath : "no note open"}</span>
      </footer>
      {ctx && (
        <div className="comet-ctx" style={{ left: ctx.x, top: ctx.y }}>
          <div
            className="comet-ctx-item"
            onClick={() => {
              const base = ctx.kind === "folder" ? ctx.path : ctx.path.replace(/[\\/]+[^\\/]+$/, "");
              void newNote(base || vaultPath);
              setCtx(null);
            }}
          >
            new note
          </div>
          <div
            className="comet-ctx-item"
            onClick={() => {
              const base = ctx.kind === "folder" ? ctx.path : ctx.path.replace(/[\\/]+[^\\/]+$/, "");
              void newFolder(base || vaultPath);
              setCtx(null);
            }}
          >
            new folder
          </div>
          <div
            className="comet-ctx-item"
            onClick={() => {
              setCaptureOpen(true);
              setCtx(null);
            }}
          >
            capture
          </div>
        </div>
      )}
      {captureOpen && (
        <div className="comet-modal-backdrop" onClick={closeCapture}>
          <div className="comet-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comet-modal-title">capture</div>
            <div className="comet-modal-row">
              <button
                className={captureType === "text" ? "comet-btn comet-btn-active" : "comet-btn"}
                onClick={() => setCaptureType("text")}
              >
                [ text ]
              </button>
              <button
                className={captureType === "link" ? "comet-btn comet-btn-active" : "comet-btn"}
                onClick={() => setCaptureType("link")}
              >
                [ link ]
              </button>
              <button className="comet-btn" onClick={() => void pickImage()}>
                [ image ]
              </button>
            </div>
            <textarea
              className="comet-modal-area"
              value={captureText}
              onChange={(e) => setCaptureText(e.target.value)}
              placeholder={captureType === "link" ? "https://..." : "write something worth keeping"}
              spellCheck={false}
            />
            <div className="comet-modal-row">
              <button className="comet-btn" onClick={() => void saveCapture()}>
                [ save ]
              </button>
              <button className="comet-btn" onClick={closeCapture}>
                [ cancel ]
              </button>
              {captureStatus && <span className="comet-modal-status">{captureStatus}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  selectedPath: string;
  onSelect: (p: string) => void;
  onContext: (e: React.MouseEvent, n: TreeNode) => void;
}

function TreeNodeView({ node, depth, selectedPath, onSelect, onContext }: TreeNodeViewProps) {
  const isFolder = node.kind === "folder";
  const isSelected = node.path === selectedPath;
  return (
    <>
      <div
        className={isSelected ? "comet-tree-item comet-tree-selected" : "comet-tree-item"}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => onSelect(node.path)}
        onContextMenu={(e) => onContext(e, node)}
      >
        <span className="comet-tree-glyph">{isFolder ? "+" : " "}</span>
        {node.name}
      </div>
      {isFolder &&
        node.children.map((child) => (
          <TreeNodeView
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onContext={onContext}
          />
        ))}
    </>
  );
}

export default App;
