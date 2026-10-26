import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { parseBlocks, inlineText } from "./utils/markdown";

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

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  selectedPath: string;
  onSelect: (p: string) => void;
}

function TreeNodeView({ node, depth, selectedPath, onSelect }: TreeNodeViewProps) {
  const isFolder = node.kind === "folder";
  const isSelected = node.path === selectedPath;
  const indent = "  ".repeat(depth);
  return (
    <>
      <div
        className={isSelected ? "comet-tree-item comet-tree-selected" : "comet-tree-item"}
        onClick={() => onSelect(node.path)}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <span className="comet-tree-glyph">{isFolder ? "+" : " "}</span>
        {indent}
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
          />
        ))}
    </>
  );
}
function App() {
  const [vaultPath, setVaultPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState("ready");

  const tree = useMemo(() => buildTree(entries, vaultPath), [entries, vaultPath]);
  const blocks = useMemo(() => parseBlocks(content), [content]);
  const selectedBlocks = useMemo(() => blocks.filter((b) => b.kind !== "blank"), [blocks]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ path: string; name: string; snippet: string }[]>([]);

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

  const selectedName = selectedPath ? selectedPath.split(/[\\/]+/).pop() ?? "" : "";

  const refresh = useCallback(async (vault: string) => {
    const e = await invoke<Entry[]>("list_vault", { path: vault });
    setEntries(e);
  }, []);

  useEffect(() => {
    if (vaultPath) void refresh(vaultPath);
  }, [vaultPath, refresh]);

  useEffect(() => {
    if (!selectedPath) {
      setContent("");
      return;
    }
    let live = true;
    invoke<string>("read_note", { path: selectedPath }).then((c) => {
      if (live) setContent(c);
    });
    return () => {
      live = false;
    };
  }, [selectedPath]);

  useEffect(() => {
    if (!selectedPath) return;
    void invoke("write_note", { path: selectedPath, content });
  }, [content, selectedPath]);

  const openVault = async () => {
    const p = await open({ directory: true });
    if (p) {
      setVaultPath(p);
      setSelectedPath(p);
      setStatus(`vault: ${p}`);
    }
  };

  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureType, setCaptureType] = useState<"text" | "link" | "image">("text");
  const [captureText, setCaptureText] = useState("");
  const [captureStatus, setCaptureStatus] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openCapture();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPreview((p) => !p);
        return;
      }
      if (e.key === "Escape" && captureOpen) {
        closeCapture();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureOpen]);

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
    if (captureType === "image") {
      // image path is already embedded in captureText by pickImage
    }
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

  return (
    <div className="comet-root">
      <header className="comet-topbar">
        <div className="comet-brand">[ * ] COMET</div>
        <div className="comet-vault">{vaultPath || "no vault"}</div>
        <input
          className="comet-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="search notes..."
          spellCheck={false}
        />
        <div className="comet-actions">
          <button className="comet-btn" onClick={() => void openVault()}>[ open vault ]</button>
          <button className="comet-btn" onClick={openCapture}>[ capture ]</button>
          <button className="comet-btn" disabled={!selectedPath} onClick={() => setPreview((p) => !p)}>
            [ preview ]
          </button>
        </div>
      </header>
      <div className="comet-main">
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
        <section className="comet-pane comet-editor">
          <div className="comet-pane-title">{selectedName || "untitled.md"}</div>
          {selectedName.endsWith(".md") ? (
            <textarea
              className="comet-editor-area"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={"# heading\n\n- [ ] task\n\n> quote\n"}
              spellCheck={false}
            />
          ) : (
            <div className="comet-preview-note">not a markdown note</div>
          )}
        </section>
        {preview && (
          <section className="comet-pane comet-preview">
            <div className="comet-pane-title">preview</div>
            <div className="comet-preview-body">
              {selectedBlocks.map((block, i) => {
                if (block.kind === "h") {
                  const level = block.level === 1 ? "comet-h1" : block.level === 2 ? "comet-h2" : "comet-h3";
                  const text = inlineText(block.inlines);
                  return <div key={i} className={level}>{text}</div>;
                }
                if (block.kind === "p") {
                  return (
                    <div key={i}>
                      {block.inlines.map((x, j) =>
                        x.kind === "br" ? <br key={j} /> : x.kind === "text" ? <span key={j}>{x.text}</span> : <strong key={j}>{x.text}</strong>
                      )}
                    </div>
                  );
                }
                if (block.kind === "ul") {
                  return (
                    <div key={i}>
                      {block.items.map((item, j) => (
                        <div key={j}>
                          {item.box ? (item.done ? "[x] " : "[ ] ") : "- "}
                          {item.inlines.map((x, k) => (x.kind === "br" ? <br key={k} /> : x.kind === "text" ? <span key={k}>{x.text}</span> : <strong key={k}>{x.text}</strong>))}
                        </div>
                      ))}
                    </div>
                  );
                }
                if (block.kind === "code") {
                  return <pre key={i} className="comet-code">{block.text}</pre>;
                }
                return <div key={i} className="comet-padding" />;
              })}
            </div>
          </section>
        )}
      </div>
      <footer className="comet-statusbar">
        <span>{status}</span>
        <span>{selectedPath ? selectedPath : "no note open"}</span>
      </footer>
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
              placeholder={
                captureType === "link" ? "https://..." : "write something worth keeping"
              }
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

export default App;
