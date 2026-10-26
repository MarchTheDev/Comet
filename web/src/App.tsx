import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EditorContent, useEditor } from "@tiptap/react";
import type { EditorProps } from "@tiptap/pm/view";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { APP_VERSION } from "virtual:comet-version";
// Generated from the bundled Matterhorn photo; no network request is needed.
import matterhorn from "./assets/matterhorn-ascii.txt?raw";
import { countWords } from "./utils/markdown";
import { SAMPLE_ROOT, SAMPLE_WELCOME, sampleVault } from "./utils/sampleVault";
import { SaveQueue, type SaveState } from "./utils/saveQueue";
import {
  buildTree,
  fileName,
  isMarkdown,
  joinPath,
  parentPath,
  relativePath,
  resolveVaultAsset,
  validEntryName,
  type Entry,
  type SearchHit,
  type TreeNode,
} from "./utils/vault";
import {
  createFolder,
  createNote,
  desktopAvailable,
  isSamplePath,
  listVault,
  readNote,
  searchVault,
  writeNote,
} from "./utils/vaultBridge";

type ViewMode = "write" | "source" | "read";
type CaptureType = "text" | "link" | "image";
type CreateDialog = { kind: "note" | "folder"; folder: string };
type ContextMenu = { x: number; y: number; node: TreeNode };

const initialSampleContent = () => {
  try {
    return sampleVault.read(SAMPLE_WELCOME);
  } catch {
    return "";
  }
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [vaultPath, setVaultPath] = useState(SAMPLE_ROOT);
  const [entries, setEntries] = useState<Entry[]>(() => sampleVault.list());
  const [selectedPath, setSelectedPath] = useState(SAMPLE_WELCOME);
  const [content, setContent] = useState(initialSampleContent);
  const [viewMode, setViewMode] = useState<ViewMode>("write");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [loading, setLoading] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 760);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([
    joinPath(SAMPLE_ROOT, "00 - Start here"),
    joinPath(SAMPLE_ROOT, "01 - Notes"),
  ]));
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [createDialog, setCreateDialog] = useState<CreateDialog | null>(null);
  const [entryName, setEntryName] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureType, setCaptureType] = useState<CaptureType>("text");
  const [captureText, setCaptureText] = useState("");
  const [captureImage, setCaptureImage] = useState("");
  const [desktopInfoOpen, setDesktopInfoOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [notice, setNotice] = useState("");

  const selectedRef = useRef(selectedPath);
  const vaultRef = useRef(vaultPath);
  const contentRef = useRef(content);
  const initialEditorContent = useRef(content);
  const modeRef = useRef(viewMode);
  const loadingRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const saveQueue = useRef<SaveQueue | null>(null);
  if (!saveQueue.current) {
    saveQueue.current = new SaveQueue(writeNote, setSaveState, () => setNotice("Couldn't save this note. Your changes are still here; use Retry to try again."));
  }
  const loadRequest = useRef(0);
  const queueSaveRef = useRef<(path: string, value: string) => void>(() => {});
  const selectNoteRef = useRef<(path: string) => void>(() => {});

  const tree = useMemo(() => buildTree(entries, vaultPath), [entries, vaultPath]);
  const noteCount = useMemo(() => entries.filter((entry) => entry.kind === "file" && isMarkdown(entry.name)).length, [entries]);
  const words = useMemo(() => countWords(content), [content]);
  const isSample = isSamplePath(vaultPath);
  const vaultName = isSample ? "Sample vault" : fileName(vaultPath);
  const selectedName = selectedPath ? fileName(selectedPath) : "";
  const breadcrumbs = selectedPath ? relativePath(selectedPath, vaultPath).split("/") : [];
  const modifier = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "CMD" : "CTRL";

  // Markdown keeps relative image paths portable. Only the rendered image is
  // converted to a Tauri asset URL, and only when it resolves inside the vault.
  const localImage = useMemo(() => Image.extend({
    addNodeView() {
      return ({ node }) => {
        const image = document.createElement("img");
        const updateImage = (current: typeof node) => {
          const source = String(current.attrs.src || "");
          image.alt = String(current.attrs.alt || "");
          image.title = String(current.attrs.title || "");
          if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(source)) {
            image.src = source;
          } else {
            const path = resolveVaultAsset(vaultRef.current, selectedRef.current, source);
            if (path && desktopAvailable && !isSamplePath(vaultRef.current)) image.src = convertFileSrc(path);
            else image.removeAttribute("src");
          }
        };
        updateImage(node);
        return {
          dom: image,
          update: (next) => {
            if (next.type !== node.type) return false;
            updateImage(next);
            return true;
          },
        };
      };
    },
  }).configure({ allowBase64: true }), []);

  const extensions = useMemo(() => [
    StarterKit.configure({ link: { openOnClick: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    localImage,
    Markdown,
  ], [localImage]);
  const editorProps = useMemo<EditorProps>(() => ({
      attributes: {
        class: "comet-editor-prose",
        role: "textbox",
        "aria-label": "Note editor",
        "aria-multiline": "true",
        "aria-readonly": "false",
        spellcheck: "true",
      },
      handleClick: (_view, _position, event) => {
        const link = event.target instanceof Element ? event.target.closest("a") : null;
        if (!link) return false;
        event.preventDefault();
        if (modeRef.current !== "read") return false;
        const href = link.getAttribute("href") || "";
        const notePath = resolveVaultAsset(vaultRef.current, selectedRef.current, href);
        if (notePath && isMarkdown(notePath)) {
          selectNoteRef.current(notePath);
        } else {
          try {
            const url = new URL(href);
            if (!["https:", "http:", "mailto:"].includes(url.protocol)) return true;
            if (desktopAvailable) void openUrl(url.href).catch(() => setNotice("Couldn't open that link."));
            else window.open(url.href, "_blank", "noopener,noreferrer");
          } catch {
            setNotice("This link can't be opened from the current note.");
          }
        }
        return true;
      },
  }), []);

  const editor = useEditor({
    extensions,
    content: initialEditorContent.current,
    contentType: "markdown",
    editorProps,
    onUpdate: ({ editor: currentEditor }) => {
      if (loadingRef.current || !selectedRef.current || modeRef.current !== "write") return;
      const next = currentEditor.getMarkdown();
      contentRef.current = next;
      setContent(next);
      queueSaveRef.current(selectedRef.current, next);
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const flushPending = useCallback(() => saveQueue.current!.flush(), []);
  const flushAll = useCallback(() => saveQueue.current!.flushAll(), []);
  const queueSave = useCallback((path: string, value: string) => saveQueue.current!.queue(path, value), []);
  queueSaveRef.current = queueSave;

  const refresh = useCallback(async (path: string) => {
    const next = await listVault(path);
    if (vaultRef.current === path) setEntries(next);
  }, []);

  const expandParents = useCallback((path: string, root: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      let parent = parentPath(path);
      while (parent && parent !== root && parent.length > root.length) {
        next.add(parent);
        parent = parentPath(parent);
      }
      return next;
    });
  }, []);

  const selectNote = useCallback(async (path: string) => {
    if (!isMarkdown(path)) {
      setNotice("Comet edits Markdown notes. This file is kept safely in your vault.");
      return;
    }
    if (path === selectedRef.current && !loadingRef.current) {
      if (window.innerWidth <= 760) setExplorerOpen(false);
      return;
    }
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return;
      loadingRef.current = true;
      setLoading(true);
      const next = await readNote(path);
      if (request !== loadRequest.current) return;
      selectedRef.current = path;
      contentRef.current = next;
      setSelectedPath(path);
      setContent(next);
      editorRef.current?.commands.setContent(next, { contentType: "markdown", emitUpdate: false });
      setSaveState("saved");
      expandParents(path, vaultRef.current);
      if (window.innerWidth <= 760) setExplorerOpen(false);
    } catch (error) {
      if (request === loadRequest.current) setNotice(`Couldn't open note: ${errorMessage(error)}`);
    } finally {
      if (request === loadRequest.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [expandParents, flushAll]);
  selectNoteRef.current = (path) => { void selectNote(path); };

  const changeMode = useCallback((mode: ViewMode) => {
    if (modeRef.current === "source" && mode !== "source") {
      editorRef.current?.commands.setContent(contentRef.current, { contentType: "markdown", emitUpdate: false });
    }
    modeRef.current = mode;
    setViewMode(mode);
    editorRef.current?.setEditable(mode === "write", false);
    editorRef.current?.view.dom.setAttribute("aria-readonly", String(mode !== "write"));
    if (mode === "source") window.setTimeout(() => sourceRef.current?.focus(), 0);
    if (mode === "write") window.setTimeout(() => editorRef.current?.commands.focus(), 0);
  }, []);

  const openVault = useCallback(async () => {
    if (!desktopAvailable) {
      setDesktopInfoOpen(true);
      return;
    }
    let request = 0;
    try {
      const path = await open({ directory: true, multiple: false, title: "Open your Comet vault" });
      if (!path || Array.isArray(path)) return;
      request = ++loadRequest.current;
      await flushAll();
      const next = await listVault(path);
      if (request !== loadRequest.current) return;
      vaultRef.current = path;
      selectedRef.current = "";
      contentRef.current = "";
      loadingRef.current = false;
      setLoading(false);
      setVaultPath(path);
      setEntries(next);
      setSelectedPath("");
      setContent("");
      setExpanded(new Set());
      setSearchQuery("");
      setSaveState("saved");
      editorRef.current?.commands.clearContent(false);
      setNotice("Vault opened. Select a note or create a new one.");
    } catch (error) {
      setNotice(`Couldn't open vault: ${errorMessage(error)}`);
    } finally {
      if (request && request === loadRequest.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [flushAll]);

  const openCreate = useCallback((kind: "note" | "folder", folder: string) => {
    setEntryName("");
    setDialogError("");
    setDialogBusy(false);
    setCreateDialog({ kind, folder });
    setContextMenu(null);
  }, []);

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!createDialog || dialogBusy) return;
    const { name, error } = validEntryName(entryName, createDialog.kind);
    if (error) {
      setDialogError(error);
      return;
    }
    const path = joinPath(createDialog.folder, name);
    setDialogBusy(true);
    setDialogError("");
    try {
      if (createDialog.kind === "note") await createNote(path, "");
      else await createFolder(path);
      await refresh(vaultRef.current);
      setExpanded((previous) => new Set([...previous, createDialog.folder, ...(createDialog.kind === "folder" ? [path] : [])]));
      setCreateDialog(null);
      if (createDialog.kind === "note") {
        changeMode("write");
        await selectNote(path);
        window.setTimeout(() => editorRef.current?.commands.focus(), 0);
      } else {
        setNotice(`Folder "${name}" created.`);
      }
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setDialogBusy(false);
    }
  };

  const openCapture = useCallback(() => {
    setCaptureType("text");
    setCaptureText("");
    setCaptureImage("");
    setDialogError("");
    setDialogBusy(false);
    setContextMenu(null);
    setCaptureOpen(true);
  }, []);

  const chooseImage = async () => {
    if (isSamplePath(vaultRef.current)) {
      setDialogError("Open a local vault to capture an image.");
      return;
    }
    try {
      const path = await open({
        multiple: false,
        title: "Choose an image",
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      });
      if (path && !Array.isArray(path)) {
        setCaptureImage(path);
        setDialogError("");
      }
    } catch (error) {
      setDialogError(errorMessage(error));
    }
  };

  const submitCapture = async (event: FormEvent) => {
    event.preventDefault();
    if (dialogBusy) return;
    let body = captureText.trim();
    if (captureType === "image" && !captureImage) {
      setDialogError("Choose an image to capture.");
      return;
    }
    if (captureType !== "image" && !body) {
      setDialogError(captureType === "link" ? "Paste a link to capture." : "Write something to capture.");
      return;
    }
    if (captureType === "link") {
      try {
        const url = new URL(body);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
        body = `[${url.hostname}](${url.href})`;
      } catch {
        setDialogError("Enter a complete http or https link.");
        return;
      }
    }
    setDialogBusy(true);
    setDialogError("");
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      if (captureType === "image") {
        const name = `${stamp}-${fileName(captureImage).replace(/[^a-zA-Z0-9._-]/g, "-")}`;
        const dest = joinPath(joinPath(vaultRef.current, "assets"), name);
        await invoke("copy_asset", { src: captureImage, dest });
        body = `![${fileName(captureImage).replace(/[\[\]]/g, "")}](../assets/${name})${body ? `\n\n${body}` : ""}`;
      }
      const inbox = joinPath(vaultRef.current, "Inbox");
      const path = joinPath(inbox, `${stamp}.md`);
      await createNote(path, body);
      await refresh(vaultRef.current);
      setExpanded((previous) => new Set([...previous, inbox]));
      setCaptureOpen(false);
      changeMode("write");
      await selectNote(path);
      setNotice("Captured to Inbox.");
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setDialogBusy(false);
    }
  };

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await flushAll();
        } catch {
          if (active) setNotice("Couldn't save; search may not include your latest changes.");
        }
        return searchVault(vaultPath, query);
      })().then((results) => {
        if (active) setSearchResults(results);
      }).catch(() => {
        if (active) setNotice("Search couldn't finish. Please try again.");
      }).finally(() => {
        if (active) setSearching(false);
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [flushAll, searchQuery, vaultPath]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!desktopAvailable) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    // Keep the window open if the last edit cannot be written to disk.
    void (async () => {
      const stop = await getCurrentWindow().onCloseRequested(async (event) => {
        try {
          await flushAll();
        } catch {
          event.preventDefault();
          setNotice("Couldn't save your changes, so Comet stayed open. Retry the save before closing.");
        }
      });
      if (active) unlisten = stop;
      else stop();
    })().catch(() => {
      // Autosave and pagehide still work if the platform cannot register this event.
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [flushAll]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        if (!dialogBusy) {
          setCreateDialog(null);
          setCaptureOpen(false);
          setDesktopInfoOpen(false);
        }
        return;
      }
      if (createDialog || captureOpen || desktopInfoOpen) return;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (command && key === "k" && !event.shiftKey) {
        event.preventDefault();
        setExplorerOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      } else if (command && key === "k" && event.shiftKey) {
        event.preventDefault();
        openCapture();
      } else if (command && key === "n") {
        event.preventDefault();
        openCreate("note", vaultRef.current);
      } else if (command && event.key === "\\") {
        event.preventDefault();
        setExplorerOpen((previous) => !previous);
      } else if (command && key === "s") {
        event.preventDefault();
        void flushAll().catch(() => setNotice("Couldn't save this note. Your changes are still here; use Retry to try again."));
      }
    };
    const onPageHide = () => { void flushPending().catch(() => undefined); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [captureOpen, createDialog, desktopInfoOpen, dialogBusy, flushAll, flushPending, openCapture, openCreate]);

  const focusSearch = () => {
    setExplorerOpen(true);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  };

  const toggleFolder = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleTreeSelect = useCallback((path: string) => { void selectNote(path); }, [selectNote]);
  const handleTreeContext = useCallback((event: MouseEvent, item: TreeNode) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || bounds.right;
    const y = event.clientY || bounds.bottom;
    setContextMenu({ x: Math.max(0, Math.min(x, window.innerWidth - 190)), y: Math.max(0, Math.min(y, window.innerHeight - 130)), node: item });
  }, []);

  const saveLabel = saveState === "error" ? "SAVE FAILED" : saveState === "saving" ? "SAVING..." : saveState === "unsaved" ? "UNSAVED CHANGES" : "ALL CHANGES SAVED";

  return (
    <div className="comet-root" onClick={() => contextMenu && setContextMenu(null)}>
      <div className="app-frame">
        <header className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true"><span>+</span><span>*</span><span>+</span></div>
            <div className="brand-words"><strong>COMET<span className="brand-underscore">_</span></strong><small>A SPACE TO THINK</small></div>
          </div>
          <div className="topbar-main">
            <button className="icon-button sidebar-toggle" type="button" onClick={() => setExplorerOpen((value) => !value)} aria-label={explorerOpen ? "Hide explorer" : "Show explorer"} aria-expanded={explorerOpen} title="Toggle explorer (Ctrl+\\)">
              <span aria-hidden="true">[=]</span>
            </button>
            <div className="topbar-location"><span className="status-dot" /> <span>YOUR WORKSPACE</span><span className="topbar-slash">/</span><span className="topbar-location-name">{isSample ? "SAMPLE MODE" : "LOCAL VAULT"}</span></div>
            <div className="topbar-actions">
              <button className="top-search" type="button" onClick={focusSearch}><span className="search-glyph" aria-hidden="true">/</span><span>Search your notes</span><kbd>{modifier} K</kbd></button>
              <button className="capture-button" type="button" onClick={openCapture} title={`${modifier}+Shift+K`}><span aria-hidden="true">+</span><span>Quick capture</span></button>
            </div>
          </div>
        </header>

        <div className="app-body">
          {explorerOpen && <aside className="sidebar" aria-label="Vault explorer">
            <div className="sidebar-inner">
              <div className="section-label"><span>WORKSPACE</span><span className="muted">01 / 01</span></div>
              <button className="vault-picker" type="button" onClick={() => void openVault()} title="Open another vault">
                <span className="vault-icon" aria-hidden="true">[+]</span>
                <span className="vault-picker-text"><strong>{vaultName}</strong><small>{isSample ? "SAMPLE WORKSPACE" : "LOCAL FOLDER"}</small></span>
                <span className="vault-caret" aria-hidden="true">v</span>
              </button>
              <button className="new-note-button" type="button" onClick={() => openCreate("note", vaultPath)}><span aria-hidden="true">+</span> New note <kbd>{modifier} N</kbd></button>
              <label className="sidebar-search">
                <span aria-hidden="true">/</span>
                <input ref={searchRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search notes..." aria-label="Search notes" spellCheck={false} />
                {searchQuery ? <button type="button" onClick={() => setSearchQuery("")} aria-label="Clear search">x</button> : <kbd>{modifier} K</kbd>}
              </label>

              <div className="explorer-heading section-label">
                <span>{searchQuery.trim() ? "SEARCH RESULTS" : "EXPLORER"}</span>
                <div className="explorer-heading-actions">
                  <span className="note-count">{String(searchQuery.trim() ? searchResults.length : noteCount).padStart(2, "0")}</span>
                  {!searchQuery.trim() && <button type="button" className="tiny-action" onClick={() => openCreate("folder", vaultPath)} aria-label="New folder" title="New folder">+</button>}
                </div>
              </div>
              <div className="tree-scroll">
                {searchQuery.trim() ? (
                  <div className="search-results" aria-live="polite">
                    {searching && <div className="tree-message">Searching...</div>}
                    {!searching && searchResults.length === 0 && <div className="tree-message">No notes found.<br /><span>Try another search.</span></div>}
                    {!searching && searchResults.map((result) => <button className="search-result" type="button" key={result.path} onClick={() => { setSearchQuery(""); void selectNote(result.path); }}>
                      <span className="search-result-name"><span aria-hidden="true">-</span> {result.name}</span>
                      <span className="search-result-snippet">{result.snippet}</span>
                    </button>)}
                  </div>
                ) : <>
                  <div className="tree-root"><span aria-hidden="true">v</span><span>{vaultName}</span><span className="tree-root-slash">/</span></div>
                  {tree.length === 0 && <div className="tree-message">No notes yet.<br /><span>Start with a new note.</span></div>}
                  <div className="tree-list">
                    {tree.map((node) => <TreeNodeView key={node.path} node={node} depth={0} selectedPath={selectedPath} expanded={expanded} onToggle={toggleFolder} onSelect={handleTreeSelect} onContext={handleTreeContext} />)}
                  </div>
                </>}
              </div>
            </div>
            <div className="sidebar-bottom">
              <div className="local-card"><div className="local-card-art" aria-hidden="true">{`  /\\  \n /  \\ \n/____\\`}</div><div><strong>MADE FOR<br />CLEARER THINKING.</strong><span>YOUR SPACE, YOURS ALONE.</span></div></div>
              <button className="open-vault-link" type="button" onClick={() => void openVault()}><span aria-hidden="true">[&gt;]</span> Open a local vault <span aria-hidden="true">-&gt;</span></button>
            </div>
          </aside>}

          <main className="workspace">
            <div className="workspace-topline">
              <nav className="breadcrumbs" aria-label="Current note path">
                <span>{isSample ? "SAMPLE" : "VAULT"}</span>
                {breadcrumbs.length ? breadcrumbs.map((part, index) => <span className="breadcrumb-part" key={`${part}-${index}`}><i>/</i><span className={index === breadcrumbs.length - 1 ? "breadcrumb-current" : ""}>{part}</span></span>) : <span className="breadcrumb-part"><i>/</i><span className="breadcrumb-current">NO NOTE OPEN</span></span>}
              </nav>
              <div className="view-tabs" role="tablist" aria-label="Note view">
                {(["write", "source", "read"] as const).map((mode) => <button key={mode} role="tab" type="button" aria-selected={viewMode === mode} disabled={!selectedPath || loading} className={viewMode === mode ? "view-tab active" : "view-tab"} onClick={() => changeMode(mode)}>{mode}</button>)}
              </div>
            </div>

            <div className="document-viewport">
              <div className="mountain-wash" aria-hidden="true" />
              <pre className="mountain-ascii" aria-hidden="true">{matterhorn}</pre>
              <div className="mountain-caption" aria-hidden="true"><span>+ &nbsp; THE MATTERHORN</span><strong>4,478 M / 14,692 FT</strong><span>45.9763 N &nbsp; 07.6586 E</span><span className="mountain-caption-rule">------------------------</span><span>ANALOGUE LANDSCAPES / 01</span></div>
              {selectedPath ? <div className="document-scroll">
                <div className="document-content">
                  <div className="document-kicker"><span><b>+</b> &nbsp; A NOTE TO SELF</span><span className="kicker-line" /><span>{selectedName}</span></div>
                  {loading ? <div className="document-loading">[ ... ] OPENING NOTE</div> : <>
                    {viewMode === "source" ? <textarea ref={sourceRef} className="source-editor" aria-label="Markdown source" spellCheck={false} value={content} placeholder="# Start with a thought..." onChange={(event) => {
                      const next = event.target.value;
                      contentRef.current = next;
                      setContent(next);
                      queueSave(selectedRef.current, next);
                    }} /> : <div className={viewMode === "read" ? "rich-editor is-reading" : "rich-editor"}>
                      <EditorContent editor={editor} />
                      {!content && viewMode === "write" && <button className="editor-placeholder" type="button" onClick={() => editor?.commands.focus()}>Start with a thought<span>_</span></button>}
                      {!content && viewMode === "read" && <p className="empty-note">This note is a blank page. Switch to WRITE to begin.</p>}
                    </div>}
                  </>}
                </div>
              </div> : <div className="welcome-empty">
                <div className="empty-kicker">+ &nbsp; YOUR SPACE IS READY</div>
                <h1>Room to think<span>_</span></h1>
                <p>Every good idea starts somewhere. Select a note from your vault, or make a little space for something new.</p>
                <button type="button" className="empty-create" onClick={() => openCreate("note", vaultPath)}>+ &nbsp; Create a note</button>
              </div>}
            </div>

            <div className="editor-toolbar" aria-label="Formatting toolbar">
              <div className="toolbar-group">
                <span className="toolbar-label">FORMAT</span>
                <button type="button" disabled={!selectedPath || viewMode !== "write" || loading} title="Heading" aria-label="Heading" onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H<span>2</span></button>
                <button type="button" disabled={!selectedPath || viewMode !== "write" || loading} title="Bold (Ctrl+B)" aria-label="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().toggleBold().run()}><strong>B</strong></button>
                <button type="button" disabled={!selectedPath || viewMode !== "write" || loading} title="Italic (Ctrl+I)" aria-label="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().toggleItalic().run()}><em>I</em></button>
                <span className="toolbar-divider" />
                <button type="button" disabled={!selectedPath || viewMode !== "write" || loading} title="Bullet list" aria-label="Bullet list" onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().toggleBulletList().run()}>- =</button>
                <button type="button" disabled={!selectedPath || viewMode !== "write" || loading} title="Task list" aria-label="Task list" onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().toggleTaskList().run()}>[ ]</button>
                <button type="button" disabled={!selectedPath || viewMode !== "write" || loading} title="Quote" aria-label="Quote" onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>&gt;_</button>
                <button type="button" disabled={!selectedPath || viewMode !== "write" || loading} title="Code" aria-label="Code" onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().toggleCode().run()}>&lt;/&gt;</button>
              </div>
              <span className="toolbar-hint">{viewMode === "source" ? "PLAIN MARKDOWN" : viewMode === "read" ? "READING MODE" : "JUST START TYPING"} <span>_</span></span>
            </div>
          </main>
        </div>

        <footer className="statusbar">
          <div><span className={saveState === "error" ? "status-indicator error" : "status-indicator"}>*</span><span>{saveLabel}</span>{saveState === "error" && <button type="button" onClick={() => void flushAll().catch(() => setNotice("Still couldn't save. Please check the vault and try again."))}>RETRY</button>}<span className="status-separator">|</span><span className="status-secondary">{isSample ? (sampleVault.isPersisted() ? "SAMPLE / STORED ON THIS DEVICE" : "SAMPLE / TEMPORARY") : "LOCAL / PRIVATE"}</span></div>
          <div className="status-right"><span>{words} WORD{words === 1 ? "" : "S"}</span><span className="status-separator">|</span><span>MARKDOWN</span><span className="status-separator">|</span><span>COMET {APP_VERSION}</span></div>
        </footer>
      </div>

      {notice && <div className="toast" role="status"><span aria-hidden="true">[ ! ]</span>{notice}<button type="button" onClick={() => setNotice("")} aria-label="Dismiss message">x</button></div>}

      {contextMenu && <div className="context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
        <div className="context-heading">CREATE IN {contextMenu.node.kind === "folder" ? contextMenu.node.name : "FOLDER"}</div>
        <button role="menuitem" type="button" onClick={() => openCreate("note", contextMenu.node.kind === "folder" ? contextMenu.node.path : parentPath(contextMenu.node.path) || vaultPath)}>+ &nbsp; New note</button>
        <button role="menuitem" type="button" onClick={() => openCreate("folder", contextMenu.node.kind === "folder" ? contextMenu.node.path : parentPath(contextMenu.node.path) || vaultPath)}>+ &nbsp; New folder</button>
        <button role="menuitem" type="button" onClick={openCapture}>/ &nbsp; Quick capture</button>
      </div>}

      {createDialog && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setCreateDialog(null)}>
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onSubmit={(event) => void submitCreate(event)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-top"><span>+ &nbsp; COMET / CREATE</span><button type="button" onClick={() => setCreateDialog(null)} aria-label="Close dialog">[ x ]</button></div>
          <h2 id="create-title">New {createDialog.kind}<span>_</span></h2>
          <p>Give your {createDialog.kind} a name. It will live in <strong>{createDialog.folder === SAMPLE_ROOT ? "Sample vault" : isSamplePath(createDialog.folder) ? relativePath(createDialog.folder, SAMPLE_ROOT) : fileName(createDialog.folder)}</strong>.</p>
          <label className="modal-label" htmlFor="entry-name">{createDialog.kind === "note" ? "NOTE NAME" : "FOLDER NAME"}</label>
          <input id="entry-name" autoFocus value={entryName} onChange={(event) => { setEntryName(event.target.value); setDialogError(""); }} placeholder={createDialog.kind === "note" ? "A thought worth keeping" : "A place for your ideas"} autoComplete="off" />
          {createDialog.kind === "note" && <span className="input-hint">.md will be added automatically</span>}
          {dialogError && <div className="dialog-error" role="alert">[ ! ] {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCreateDialog(null)}>Cancel</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "Creating..." : `+ Create ${createDialog.kind}`}</button></div>
        </form>
      </div>}

      {captureOpen && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setCaptureOpen(false)}>
        <form className="modal capture-modal" role="dialog" aria-modal="true" aria-labelledby="capture-title" onSubmit={(event) => void submitCapture(event)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-top"><span>+ &nbsp; COMET / INBOX</span><button type="button" onClick={() => setCaptureOpen(false)} aria-label="Close dialog">[ x ]</button></div>
          <h2 id="capture-title">Catch a thought<span>_</span></h2>
          <p>A thought, a link, a moment. Save it now; find a place for it later.</p>
          <div className="capture-tabs" role="tablist" aria-label="Capture type">
            {(["text", "link", "image"] as const).map((type) => <button key={type} role="tab" type="button" aria-selected={captureType === type} className={captureType === type ? "active" : ""} onClick={() => { setCaptureType(type); setDialogError(""); }}>[ {type} ]</button>)}
          </div>
          {captureType === "image" && <button className="image-picker" type="button" onClick={() => void chooseImage()}>{captureImage ? `[ + ]  ${fileName(captureImage)}` : "[ + ]  Choose an image"}</button>}
          <label className="modal-label" htmlFor="capture-content">{captureType === "link" ? "LINK" : captureType === "image" ? "ADD A NOTE / OPTIONAL" : "YOUR THOUGHT"}</label>
          <textarea id="capture-content" autoFocus value={captureText} onChange={(event) => { setCaptureText(event.target.value); setDialogError(""); }} placeholder={captureType === "link" ? "https://..." : captureType === "image" ? "A few words about this image..." : "What would you like to remember?"} />
          <span className="input-hint">Saved as a new Markdown note in /Inbox</span>
          {dialogError && <div className="dialog-error" role="alert">[ ! ] {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCaptureOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "Saving..." : "+ Save to inbox"}</button></div>
        </form>
      </div>}

      {desktopInfoOpen && <div className="modal-backdrop" onMouseDown={() => setDesktopInfoOpen(false)}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="desktop-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-top"><span>+ &nbsp; COMET / LOCAL FIRST</span><button type="button" onClick={() => setDesktopInfoOpen(false)} aria-label="Close dialog">[ x ]</button></div>
          <h2 id="desktop-title">Your notes, your folder<span>_</span></h2>
          <p>Open a folder on your computer in the Comet desktop app. This browser preview is a sample workspace, {sampleVault.isPersisted() ? "stored only on this device" : "kept temporarily for this session"}.</p>
          <div className="modal-actions"><button type="button" className="primary-button" onClick={() => setDesktopInfoOpen(false)}>Back to sample -&gt;</button></div>
        </div>
      </div>}
    </div>
  );
}

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  selectedPath: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onContext: (event: MouseEvent, node: TreeNode) => void;
}

const TreeNodeView = memo(function TreeBranch({ node, depth, selectedPath, expanded, onToggle, onSelect, onContext }: TreeNodeViewProps) {
  const folder = node.kind === "folder";
  const openFolder = expanded.has(node.path);
  const selected = node.path === selectedPath;
  return <div className="tree-branch">
    <div className="tree-row">
      <button type="button" className={selected ? "tree-item selected" : "tree-item"} style={{ paddingLeft: `${12 + depth * 15}px` }} onClick={() => folder ? onToggle(node.path) : onSelect(node.path)} onContextMenu={(event) => onContext(event, node)} aria-expanded={folder ? openFolder : undefined} title={node.name}>
        <span className="tree-disclosure" aria-hidden="true">{folder ? (openFolder ? "v" : ">") : "-"}</span>
        <span className={folder ? "tree-file-glyph folder" : "tree-file-glyph"} aria-hidden="true">{folder ? "[ ]" : "."}</span>
        <span className="tree-name">{node.name}</span>
        {selected && <span className="tree-selected-mark" aria-hidden="true">*</span>}
      </button>
      {folder && <button type="button" className="tree-folder-action" aria-label={`Create in ${node.name}`} title={`Create in ${node.name}`} onClick={(event) => onContext(event, node)}>+</button>}
    </div>
    {folder && openFolder && node.children.map((child) => <TreeNodeView key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} expanded={expanded} onToggle={onToggle} onSelect={onSelect} onContext={onContext} />)}
  </div>;
});

export default App;
