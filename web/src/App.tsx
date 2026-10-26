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

function App() {
  const [vaultPath, setVaultPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState("ready");

  const tree = useMemo(() => buildTree(entries, vaultPath), [entries, vaultPath]);
  const blocks = useMemo(() => parseBlocks(content), [content]);
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

  const selectedBlocks = useMemo(() => blocks.filter((b) => b.kind !== "blank"), [blocks]);

  return (
    <div className="comet-root">
      <header className="comet-topbar">
        <div className="comet-brand">[ * ] COMET</div>
        <div className="comet-vault">{vaultPath || "no vault"}</div>
        <div className="comet-actions">
          <button className="comet-btn" onClick={() => void openVault()}>[ open vault ]</button>
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
    </div>
  );
}

export default App;
