import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  AlertCircle, ArrowRight, Bold, BookOpen, CheckCircle2,
  ChevronDown, ChevronRight, Code2, FileCode2, FilePlus2, FileText, Folder,
  FolderOpen, FolderPlus, Image as ImageIcon, Inbox, Italic, Link2, List,
  ListChecks, LoaderCircle, LockKeyhole, MapPin, Maximize2, Minimize2,
  MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Quote, Redo2,
  Search, Sparkles, Trash2, Undo2, X, type LucideIcon,
} from "lucide-react";
import type { EditorProps } from "@tiptap/pm/view";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { APP_VERSION } from "virtual:comet-version";
import { countWords } from "./utils/markdown";
import { loadMarkdownNote } from "./utils/editor";
import { SAMPLE_ROOT, SAMPLE_WELCOME, sampleVault } from "./utils/sampleVault";
import { SaveQueue, type SaveState } from "./utils/saveQueue";
import { clearSession, readSampleSelection, readSession, saveSampleSelection, saveSession } from "./utils/session";
import {
  buildTree,
  fileName,
  isMarkdown,
  isPathInside,
  joinPath,
  noteTitle,
  parentPath,
  relativePath,
  remapPath,
  resolveVaultAsset,
  validEntryName,
  type Entry,
  type SearchHit,
  type TreeNode,
} from "./utils/vault";
import {
  createFolder,
  createNote,
  deleteEntry,
  desktopAvailable,
  isSamplePath,
  listVault,
  readNote,
  renameEntry,
  restoreVaultAccess,
  searchVault,
  writeNote,
} from "./utils/vaultBridge";

type ViewMode = "write" | "source" | "read";
type WorkspaceView = "note" | "all" | "inbox";
type CaptureType = "text" | "link" | "image";
type CreateDialog = { kind: "note" | "folder"; folder: string };
type ContextMenu = { x: number; y: number; node: TreeNode };

function initialSample() {
  const entries = sampleVault.list();
  const previous = readSampleSelection();
  const selected = entries.find((entry) => entry.path === previous && entry.kind === "file" && isMarkdown(entry.path))
    ?? entries.find((entry) => entry.path === SAMPLE_WELCOME)
    ?? entries.find((entry) => entry.kind === "file" && isMarkdown(entry.path));
  return { entries, path: selected?.path ?? "", content: selected ? sampleVault.read(selected.path) : "" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [sampleStart] = useState(initialSample);
  const [lastSession] = useState(() => desktopAvailable ? readSession() : null);
  const [restoring, setRestoring] = useState(Boolean(lastSession));
  const [vaultPath, setVaultPath] = useState(SAMPLE_ROOT);
  const [entries, setEntries] = useState<Entry[]>(sampleStart.entries);
  const [selectedPath, setSelectedPath] = useState(sampleStart.path);
  const [content, setContent] = useState(sampleStart.content);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(sampleStart.path ? "note" : "all");
  const [viewMode, setViewMode] = useState<ViewMode>("write");
  const [focusMode, setFocusMode] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [loading, setLoading] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 760);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([
    parentPath(sampleStart.path),
    joinPath(SAMPLE_ROOT, "Notes"),
    joinPath(SAMPLE_ROOT, "01 - Notes"), // Keep previously saved samples easy to navigate.
  ]));
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [createDialog, setCreateDialog] = useState<CreateDialog | null>(null);
  const [renameNode, setRenameNode] = useState<TreeNode | null>(null);
  const [deleteNode, setDeleteNode] = useState<TreeNode | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
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
  const previousExplorerOpen = useRef(explorerOpen);
  const saveQueue = useRef<SaveQueue | null>(null);
  if (!saveQueue.current) {
    saveQueue.current = new SaveQueue((path, value) => writeNote(vaultRef.current, path, value), setSaveState, () => setNotice("Couldn't save this note. Your changes are still here; use Retry to try again."));
  }
  const loadRequest = useRef(0);
  const queueSaveRef = useRef<(path: string, value: string) => void>(() => {});
  const selectNoteRef = useRef<(path: string) => void>(() => {});

  const tree = useMemo(() => buildTree(entries, vaultPath), [entries, vaultPath]);
  const notes = useMemo(() => entries.filter((entry) => entry.kind === "file" && isMarkdown(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name)), [entries]);
  const inboxNotes = useMemo(() => notes.filter((entry) => relativePath(entry.path, vaultPath).toLowerCase().startsWith("inbox/")), [notes, vaultPath]);
  const noteCount = notes.length;
  const words = useMemo(() => countWords(content), [content]);
  const isSample = isSamplePath(vaultPath);
  const vaultName = isSample ? "Sample workspace" : fileName(vaultPath);
  const selectedName = selectedPath ? fileName(selectedPath) : "";
  const modifier = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘" : "Ctrl";

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
  useEffect(() => {
    if (!editor) return;
    loadMarkdownNote(editor, contentRef.current);
    editor.setEditable(modeRef.current === "write", false);
  }, [editor]);
  const formatting = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      heading: current?.isActive("heading", { level: 2 }) ?? false,
      bulletList: current?.isActive("bulletList") ?? false,
      taskList: current?.isActive("taskList") ?? false,
      quote: current?.isActive("blockquote") ?? false,
      link: current?.isActive("link") ?? false,
      undo: current?.can().undo() ?? false,
      redo: current?.can().redo() ?? false,
    }),
  });

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
      setWorkspaceView("note");
      if (window.innerWidth <= 760) setExplorerOpen(false);
      return;
    }
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return;
      loadingRef.current = true;
      setLoading(true);
      const next = await readNote(vaultRef.current, path);
      if (request !== loadRequest.current) return;
      selectedRef.current = path;
      contentRef.current = next;
      setSelectedPath(path);
      setContent(next);
      setWorkspaceView("note");
      loadMarkdownNote(editorRef.current, next);
      if (isSamplePath(vaultRef.current)) saveSampleSelection(path);
      else saveSession({ vault: vaultRef.current, note: path });
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

  useEffect(() => {
    if (!lastSession) return;
    let active = true;
    const request = ++loadRequest.current;
    loadingRef.current = true;
    setLoading(true);
    void (async () => {
      try {
        await restoreVaultAccess(lastSession.vault);
        const nextEntries = await listVault(lastSession.vault);
        let nextPath = nextEntries.some((entry) => entry.path === lastSession.note && entry.kind === "file" && isMarkdown(entry.path))
          ? lastSession.note : "";
        let nextContent = "";
        if (nextPath) {
          try { nextContent = await readNote(lastSession.vault, nextPath); } catch { nextPath = ""; }
        }
        if (!active || request !== loadRequest.current) return;
        vaultRef.current = lastSession.vault;
        selectedRef.current = nextPath;
        contentRef.current = nextContent;
        setVaultPath(lastSession.vault);
        setEntries(nextEntries);
        setSelectedPath(nextPath);
        setContent(nextContent);
        setWorkspaceView(nextPath ? "note" : "all");
        setExpanded(new Set());
        if (nextPath) expandParents(nextPath, lastSession.vault);
        loadMarkdownNote(editorRef.current, nextContent);
        saveSession({ vault: lastSession.vault, note: nextPath });
      } catch {
        if (!active || request !== loadRequest.current) return;
        clearSession();
        setNotice("Couldn't reopen your last workspace. Open its folder again to continue.");
      } finally {
        if (active && request === loadRequest.current) {
          loadingRef.current = false;
          setLoading(false);
          setRestoring(false);
        }
      }
    })();
    return () => { active = false; };
  }, [lastSession, expandParents]);

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
      if (request !== loadRequest.current) return;
      loadingRef.current = true;
      setLoading(true);
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
      setWorkspaceView("all");
      setExpanded(new Set());
      setSearchQuery("");
      setSaveState("saved");
      loadMarkdownNote(editorRef.current, "");
      saveSession({ vault: path, note: "" });
      setNotice("Workspace opened. Choose a note or create one to get started.");
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
      if (createDialog.kind === "note") await createNote(vaultRef.current, path, "");
      else await createFolder(vaultRef.current, path);
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

  const showOverview = useCallback(async (view: "all" | "inbox") => {
    try {
      await flushAll();
      setWorkspaceView(view);
      setSearchQuery("");
      if (window.innerWidth <= 760) setExplorerOpen(false);
    } catch {
      setNotice("Couldn't save this note. Retry the save before leaving it.");
    }
  }, [flushAll]);

  const toggleFocus = () => {
    if (focusMode) {
      setExplorerOpen(previousExplorerOpen.current);
      setFocusMode(false);
    } else {
      previousExplorerOpen.current = explorerOpen;
      setExplorerOpen(false);
      setFocusMode(true);
    }
  };

  const openRename = (node: TreeNode) => {
    setEntryName(node.kind === "file" && isMarkdown(node.name) ? noteTitle(node.name) : node.name);
    setDialogError("");
    setDialogBusy(false);
    setContextMenu(null);
    setRenameNode(node);
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!renameNode || dialogBusy) return;
    const kind = renameNode.kind === "folder" ? "folder" : isMarkdown(renameNode.name) ? "note" : "file";
    const { name, error } = validEntryName(entryName, kind);
    if (error) { setDialogError(error); return; }
    const destination = joinPath(parentPath(renameNode.path), name);
    if (destination === renameNode.path) { setRenameNode(null); return; }
    setDialogBusy(true);
    setDialogError("");
    try {
      await flushAll();
      await renameEntry(vaultRef.current, renameNode.path, destination);
      if (selectedRef.current && isPathInside(selectedRef.current, renameNode.path)) {
        const nextPath = remapPath(selectedRef.current, renameNode.path, destination);
        selectedRef.current = nextPath;
        setSelectedPath(nextPath);
        // Relative image URLs are resolved from the note's current location.
        loadMarkdownNote(editorRef.current, contentRef.current);
        if (isSamplePath(vaultRef.current)) saveSampleSelection(nextPath);
        else saveSession({ vault: vaultRef.current, note: nextPath });
      }
      setExpanded((previous) => new Set([...previous].map((path) => remapPath(path, renameNode.path, destination))));
      setSearchQuery("");
      await refresh(vaultRef.current);
      setRenameNode(null);
      setNotice(`Renamed to “${name}”.`);
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setDialogBusy(false);
    }
  };

  const openDelete = (node: TreeNode) => {
    setDialogError("");
    setDialogBusy(false);
    setContextMenu(null);
    setDeleteNode(node);
  };

  const confirmDelete = async () => {
    if (!deleteNode || dialogBusy) return;
    setDialogBusy(true);
    setDialogError("");
    try {
      await flushAll();
      await deleteEntry(vaultRef.current, deleteNode.path);
      if (selectedRef.current && isPathInside(selectedRef.current, deleteNode.path)) {
        selectedRef.current = "";
        contentRef.current = "";
        setSelectedPath("");
        setContent("");
        setWorkspaceView("all");
        loadMarkdownNote(editorRef.current, "");
        if (isSamplePath(vaultRef.current)) saveSampleSelection("");
        else saveSession({ vault: vaultRef.current, note: "" });
      }
      setExpanded((previous) => new Set([...previous].filter((path) => !isPathInside(path, deleteNode.path))));
      setSearchQuery("");
      await refresh(vaultRef.current);
      setDeleteNode(null);
      setNotice(`Deleted “${deleteNode.name}”.`);
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setDialogBusy(false);
    }
  };

  const openLink = () => {
    if (!editorRef.current) return;
    setLinkValue(String(editorRef.current.getAttributes("link").href || ""));
    setDialogError("");
    setLinkOpen(true);
  };

  const submitLink = (event: FormEvent) => {
    event.preventDefault();
    const current = editorRef.current;
    if (!current) return;
    try {
      const raw = linkValue.trim();
      const href = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? `mailto:${raw}` : `https://${raw}`;
      const url = new URL(href);
      if (!["http:", "https:", "mailto:"].includes(url.protocol) || !raw) throw new Error();
      if (current.state.selection.empty && !current.isActive("link")) {
        current.chain().focus().insertContent({ type: "text", text: url.href, marks: [{ type: "link", attrs: { href: url.href } }] }).run();
      } else {
        current.chain().focus().extendMarkRange("link").setLink({ href: url.href }).run();
      }
      setLinkOpen(false);
    } catch {
      setDialogError("Enter a valid web address or email link.");
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
    let captureTitle = captureType === "image" ? fileName(captureImage).replace(/\.[^.]+$/, "") : body.split(/\s+/).slice(0, 6).join(" ");
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
        captureTitle = url.hostname;
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
        await invoke("copy_asset", { vault: vaultRef.current, src: captureImage, dest });
        body = `![${fileName(captureImage).replace(/[\[\]]/g, "")}](../assets/${name})${body ? `\n\n${body}` : ""}`;
      }
      const inbox = joinPath(vaultRef.current, "Inbox");
      const title = captureTitle.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").slice(0, 45).trim() || "Quick capture";
      const path = joinPath(inbox, `${title} - ${stamp}.md`);
      await createNote(vaultRef.current, path, body);
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

  const modalOpen = Boolean(createDialog || renameNode || deleteNode || linkOpen || captureOpen || desktopInfoOpen);
  useEffect(() => {
    if (!modalOpen) return;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    if (!dialog) return;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    if (!dialog.contains(document.activeElement)) focusable()[0]?.focus();
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); return; }
      const active = document.activeElement;
      if (!dialog.contains(active) || (event.shiftKey && active === items[0]) || (!event.shiftKey && active === items[items.length - 1])) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };
    document.addEventListener("keydown", trapTab, true);
    return () => document.removeEventListener("keydown", trapTab, true);
  }, [modalOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        if (!dialogBusy) {
          setCreateDialog(null);
          setRenameNode(null);
          setDeleteNode(null);
          setLinkOpen(false);
          setCaptureOpen(false);
          setDesktopInfoOpen(false);
        }
        return;
      }
      if (createDialog || renameNode || deleteNode || linkOpen || captureOpen || desktopInfoOpen || restoring) return;
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
  }, [captureOpen, createDialog, renameNode, deleteNode, linkOpen, desktopInfoOpen, dialogBusy, restoring, flushAll, flushPending, openCapture, openCreate]);

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
    setContextMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 220)), y: Math.max(8, Math.min(y, window.innerHeight - 210)), node: item });
  }, []);

  const saveLabel = saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved changes" : "Saved";

  return (
    <div className={`comet-root${focusMode ? " focus-mode" : ""}`} onClick={() => contextMenu && setContextMenu(null)}>
      <div className="app-shell">
        {explorerOpen && <button className="sidebar-scrim" type="button" aria-label="Close sidebar" onClick={() => setExplorerOpen(false)} />}
        {explorerOpen && <aside className="sidebar" aria-label="Workspace navigation">
          <div className="sidebar-brand">
            <div className="brand-mark" aria-hidden="true"><Sparkles size={19} strokeWidth={2.2} /></div>
            <div className="brand-name">comet<span>.</span></div>
            <button className="sidebar-close-mobile icon-button" type="button" aria-label="Close sidebar" onClick={() => setExplorerOpen(false)}><X size={18} /></button>
          </div>

          <button className="workspace-picker" type="button" onClick={() => void openVault()} aria-label="Open another workspace" title="Open a local folder">
            <span className="workspace-avatar">{isSample ? "S" : vaultName.slice(0, 1).toUpperCase()}</span>
            <span className="workspace-picker-copy"><strong>{vaultName}</strong><small>{isSample ? (desktopAvailable ? "Sample data" : "Interactive browser sample") : "Local workspace"}</small></span>
            <ChevronDown size={16} className="workspace-chevron" aria-hidden="true" />
          </button>

          <button className="new-note-button" type="button" onClick={() => openCreate("note", vaultPath)}><Plus size={18} /> <span>New note</span><kbd>{modifier} N</kbd></button>

          <label className="sidebar-search">
            <Search size={16} aria-hidden="true" />
            <input ref={searchRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search notes" aria-label="Search notes" spellCheck={false} />
            {searchQuery ? <button type="button" onClick={() => setSearchQuery("")} aria-label="Clear search"><X size={15} /></button> : <kbd>{modifier} K</kbd>}
          </label>

          {!searchQuery.trim() && <nav className="primary-nav" aria-label="Library">
            <button className={workspaceView === "all" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "all" ? "page" : undefined} onClick={() => void showOverview("all")}><BookOpen size={17} /><span>All notes</span><small>{noteCount}</small></button>
            <button className={workspaceView === "inbox" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "inbox" ? "page" : undefined} onClick={() => void showOverview("inbox")}><Inbox size={17} /><span>Inbox</span><small>{inboxNotes.length}</small></button>
          </nav>}

          <div className="sidebar-section-heading">
            <span>{searchQuery.trim() ? "Search results" : "Your folders"}</span>
            {!searchQuery.trim() && <button type="button" className="icon-button section-add" onClick={() => openCreate("folder", vaultPath)} aria-label="New folder" title="New folder"><FolderPlus size={16} /></button>}
          </div>
          <div className="tree-scroll">
            {searchQuery.trim() ? <div className="search-results" aria-live="polite">
              {searching && <div className="tree-message">Searching your notes…</div>}
              {!searching && searchResults.length === 0 && <div className="tree-message">No notes found.<br /><span>Try a different search.</span></div>}
              {!searching && searchResults.map((result) => <button className="search-result" type="button" key={result.path} onClick={() => { setSearchQuery(""); void selectNote(result.path); }}>
                <span className="search-result-name"><FileText size={15} /> {noteTitle(result.name)}</span>
                <span className="search-result-snippet">{result.snippet}</span>
              </button>)}
            </div> : <>
              {tree.length === 0 && <div className="tree-message">Nothing here yet.<br /><span>Create a note to get started.</span></div>}
              <div className="tree-list">{tree.map((node) => <TreeNodeView key={node.path} node={node} depth={0} selectedPath={workspaceView === "note" ? selectedPath : ""} expanded={expanded} onToggle={toggleFolder} onSelect={handleTreeSelect} onContext={handleTreeContext} />)}</div>
            </>}
          </div>

          <div className="sidebar-bottom">
            <div className="privacy-card">
              <div className="privacy-icon"><LockKeyhole size={15} /></div>
              <div><strong>{isSample ? "You're in a sample" : "Your notes stay yours"}</strong><p>{isSample ? (sampleVault.isPersisted() ? (desktopAvailable ? "Changes stay in this app." : "Changes stay in this browser.") : "Changes last for this session.") : "Just Markdown files, right on your device."}</p></div>
              {isSample && <button type="button" onClick={() => void openVault()}>Open your folder <ArrowRight size={14} /></button>}
            </div>
            <div className="sidebar-footer"><span>Made for clear thinking</span><span>v{APP_VERSION}</span></div>
          </div>
        </aside>}

        <main className="main-area">
          <header className="app-topbar">
            <div className="topbar-left">
              <button className="icon-button sidebar-toggle" type="button" onClick={() => { setExplorerOpen((value) => !value); if (focusMode) setFocusMode(false); }} aria-label={explorerOpen ? "Hide sidebar" : "Show sidebar"} aria-expanded={explorerOpen} title={`Toggle sidebar (${modifier}+\\)`}>{explorerOpen ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}</button>
              <span className="topbar-divider" />
              <nav className="breadcrumbs" aria-label="Current location">
                <button type="button" onClick={() => void showOverview("all")}>My workspace</button>
                <ChevronRight size={14} aria-hidden="true" />
                <span className="breadcrumb-current">{workspaceView === "note" && selectedName ? noteTitle(selectedName) : workspaceView === "inbox" ? "Inbox" : "All notes"}</span>
              </nav>
            </div>
            <div className="topbar-actions">
              {isSample && <span className="sample-badge"><span /> Sample</span>}
              <button className="icon-button top-search-button" type="button" onClick={focusSearch} aria-label="Search notes" title={`Search (${modifier}+K)`}><Search size={18} /></button>
              <button className="capture-button" type="button" onClick={openCapture} title={`${modifier}+Shift+K`}><Sparkles size={15} /><span>Quick capture</span></button>
            </div>
          </header>

          <div className="workspace-scroll">
            {!focusMode && <section className="cover-card" aria-label="The Matterhorn">
              <div className="cover-copy">
                <span className="cover-eyebrow"><Sparkles size={13} /> A LITTLE SPACE TO THINK</span>
                <h1>Make space for<br />what matters.</h1>
                <p>A quieter place for all your ideas.</p>
              </div>
              <div className="cover-location"><MapPin size={13} /> The Matterhorn, Switzerland</div>
            </section>}

            {workspaceView === "note" && selectedPath ? <section className="note-card" aria-label={`Note: ${noteTitle(selectedName)}`}>
              <div className="document-header">
                <div className="document-heading">
                  <div className="document-icon"><FileText size={20} /></div>
                  <div className="document-heading-copy"><span>YOUR NOTE</span><h2 title={selectedName}>{noteTitle(selectedName)}</h2></div>
                </div>
                <div className="document-actions">
                  <div className={`save-indicator ${saveState}`} role="status">{saveState === "error" ? <AlertCircle size={15} /> : saveState === "saving" ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}<span>{saveLabel}</span>{saveState === "error" && <button type="button" onClick={() => void flushAll().catch(() => setNotice("Still couldn't save. Please check the folder and try again."))}>Retry</button>}</div>
                  <div className="view-tabs" role="tablist" aria-label="Note view">
                    {(["write", "source", "read"] as const).map((mode) => <button key={mode} role="tab" type="button" aria-selected={viewMode === mode} disabled={loading} className={viewMode === mode ? "active" : ""} onClick={() => changeMode(mode)}>{mode === "source" ? "Markdown" : mode === "write" ? "Write" : "Read"}</button>)}
                  </div>
                  <button className="icon-button focus-button" type="button" onClick={toggleFocus} aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"} title={focusMode ? "Exit focus mode" : "Focus mode"}>{focusMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
                  <button className="icon-button document-more" type="button" aria-label={`More options for ${selectedName}`} title="Note options" onClick={(event) => handleTreeContext(event, { name: selectedName, path: selectedPath, kind: "file", children: [] })}><MoreHorizontal size={19} /></button>
                </div>
              </div>
              <div className="format-toolbar" aria-label="Formatting toolbar">
                {viewMode === "write" ? <>
                  <button className={formatting?.heading ? "format-button active heading-button" : "format-button heading-button"} type="button" title="Heading" aria-label="Heading" aria-pressed={formatting?.heading} disabled={!editor || loading} onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H<span>2</span></button>
                  <span className="format-divider" />
                  <ToolButton label="Bold" icon={Bold} active={formatting?.bold} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleBold().run()} />
                  <ToolButton label="Italic" icon={Italic} active={formatting?.italic} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleItalic().run()} />
                  <ToolButton label="Add link" icon={Link2} active={formatting?.link} disabled={!editor || loading} onClick={openLink} />
                  <span className="format-divider" />
                  <ToolButton label="Bullet list" icon={List} active={formatting?.bulletList} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleBulletList().run()} />
                  <ToolButton label="Task list" icon={ListChecks} active={formatting?.taskList} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleTaskList().run()} />
                  <ToolButton label="Quote" icon={Quote} active={formatting?.quote} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleBlockquote().run()} />
                  <ToolButton label="Inline code" icon={Code2} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleCode().run()} />
                  <span className="format-divider" />
                  <ToolButton label="Undo" icon={Undo2} disabled={!formatting?.undo || loading} onClick={() => editor?.chain().focus().undo().run()} />
                  <ToolButton label="Redo" icon={Redo2} disabled={!formatting?.redo || loading} onClick={() => editor?.chain().focus().redo().run()} />
                  <span className="toolbar-end-hint">Make it yours</span>
                </> : <span className="mode-hint">{viewMode === "source" ? <><FileCode2 size={15} /> You're editing the plain Markdown file</> : <><BookOpen size={15} /> Reading view · select Write to make changes</>}</span>}
              </div>
              <div className="document-body">
                {loading ? <div className="document-loading"><LoaderCircle size={18} className="spin" /> Opening your note…</div> : viewMode === "source" ? <textarea ref={sourceRef} className="source-editor" aria-label="Markdown source" spellCheck={false} value={content} placeholder="Start writing in Markdown…" onChange={(event) => {
                  const next = event.target.value;
                  contentRef.current = next;
                  setContent(next);
                  queueSave(selectedRef.current, next);
                }} /> : <div className={viewMode === "read" ? "rich-editor is-reading" : "rich-editor"}>
                  <EditorContent editor={editor} />
                  {!content && viewMode === "write" && <button className="editor-placeholder" type="button" onClick={() => editor?.commands.focus()}>Start writing, or make a little space for an idea…</button>}
                  {!content && viewMode === "read" && <p className="empty-note">This note is empty. Switch to Write to get started.</p>}
                </div>}
              </div>
              <div className="document-footer"><div><span>{words} {words === 1 ? "word" : "words"}</span><span className="footer-dot" /> <span>Markdown</span></div><span>{isSample ? (sampleVault.isPersisted() ? (desktopAvailable ? "Sample saved in this app" : "Sample saved in this browser") : "Temporary sample") : "Saved locally"}</span></div>
            </section> : <section className="overview-card">
              <div className="overview-heading">
                <div><span className="section-eyebrow">YOUR WORKSPACE</span><h2>{workspaceView === "inbox" ? "Inbox" : "All notes"}</h2><p>{workspaceView === "inbox" ? "A landing spot for everything you want to remember." : "All your ideas, together in one place."}</p></div>
                <button className="primary-button overview-create" type="button" onClick={() => workspaceView === "inbox" ? openCapture() : openCreate("note", vaultPath)}><Plus size={16} /> {workspaceView === "inbox" ? "Quick capture" : "New note"}</button>
              </div>
              {(workspaceView === "inbox" ? inboxNotes : notes).length ? <div className="overview-list">
                <div className="overview-list-heading"><span>Name</span><span>Location</span></div>
                {(workspaceView === "inbox" ? inboxNotes : notes).map((entry) => <button className="overview-row" type="button" key={entry.path} onClick={() => void selectNote(entry.path)}>
                  <span className="overview-row-name"><span className="overview-file-icon"><FileText size={17} /></span><strong>{noteTitle(entry.name)}</strong></span>
                  <span className="overview-row-location">{parentPath(entry.path) === vaultPath ? "Workspace" : relativePath(parentPath(entry.path), vaultPath)}</span><ArrowRight size={16} className="overview-row-arrow" />
                </button>)}
              </div> : <div className="overview-empty"><div className="overview-empty-icon">{workspaceView === "inbox" ? <Inbox size={24} /> : <FilePlus2 size={24} />}</div><h3>{workspaceView === "inbox" ? "Your inbox is clear" : "A fresh start"}</h3><p>{workspaceView === "inbox" ? "Quick captures will appear here when you save them." : "Create your first note and let the ideas flow."}</p><button type="button" className="secondary-button" onClick={() => workspaceView === "inbox" ? openCapture() : openCreate("note", vaultPath)}>{workspaceView === "inbox" ? "Make a quick capture" : "Create a note"} <ArrowRight size={15} /></button></div>}
            </section>}
            <div className="workspace-endnote"><Sparkles size={13} /> A little room for your best ideas.</div>
          </div>
        </main>
      </div>

      {notice && <div className="toast" role="status"><AlertCircle size={17} /> <span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={16} /></button></div>}

      {contextMenu && <div className="context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
        <div className="context-heading" title={contextMenu.node.name}>{contextMenu.node.name}</div>
        <button role="menuitem" type="button" onClick={() => openCreate("note", contextMenu.node.kind === "folder" ? contextMenu.node.path : parentPath(contextMenu.node.path) || vaultPath)}><FilePlus2 size={16} /> New note here</button>
        <button role="menuitem" type="button" onClick={() => openCreate("folder", contextMenu.node.kind === "folder" ? contextMenu.node.path : parentPath(contextMenu.node.path) || vaultPath)}><FolderPlus size={16} /> New folder here</button>
        <div className="context-divider" />
        <button role="menuitem" type="button" onClick={() => openRename(contextMenu.node)}><Pencil size={16} /> Rename</button>
        <button role="menuitem" type="button" className="danger" onClick={() => openDelete(contextMenu.node)}><Trash2 size={16} /> Delete</button>
      </div>}

      {createDialog && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setCreateDialog(null)}>
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onSubmit={(event) => void submitCreate(event)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon"><FilePlus2 size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setCreateDialog(null)} aria-label="Close dialog" disabled={dialogBusy}><X size={18} /></button>
          <h2 id="create-title">New {createDialog.kind}</h2>
          <p>Give your {createDialog.kind} a name. It will be saved in <strong>{createDialog.folder === vaultPath ? vaultName : relativePath(createDialog.folder, vaultPath)}</strong>.</p>
          <label className="modal-label" htmlFor="entry-name">{createDialog.kind === "note" ? "Note name" : "Folder name"}</label>
          <input id="entry-name" autoFocus value={entryName} onChange={(event) => { setEntryName(event.target.value); setDialogError(""); }} placeholder={createDialog.kind === "note" ? "Give your note a name" : "Give your folder a name"} autoComplete="off" />
          {createDialog.kind === "note" && <span className="input-hint">Saved as a Markdown (.md) file.</span>}
          {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCreateDialog(null)} disabled={dialogBusy}>Cancel</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "Creating…" : `Create ${createDialog.kind}`}</button></div>
        </form>
      </div>}

      {renameNode && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setRenameNode(null)}>
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="rename-title" onSubmit={(event) => void submitRename(event)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon"><Pencil size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setRenameNode(null)} aria-label="Close dialog" disabled={dialogBusy}><X size={18} /></button>
          <h2 id="rename-title">Rename {renameNode.kind === "folder" ? "folder" : "file"}</h2><p>Choose a new name for <strong>{renameNode.name}</strong>. Links in other notes won't be updated automatically.</p>
          <label className="modal-label" htmlFor="rename-name">Name</label><input id="rename-name" autoFocus value={entryName} onChange={(event) => { setEntryName(event.target.value); setDialogError(""); }} autoComplete="off" />
          {renameNode.kind === "file" && isMarkdown(renameNode.name) && <span className="input-hint">The .md extension will be kept.</span>}
          {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setRenameNode(null)} disabled={dialogBusy}>Cancel</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "Renaming…" : "Rename"}</button></div>
        </form>
      </div>}

      {deleteNode && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setDeleteNode(null)}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon danger-icon"><Trash2 size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setDeleteNode(null)} aria-label="Close dialog" disabled={dialogBusy}><X size={18} /></button>
          <h2 id="delete-title">Delete {deleteNode.kind === "folder" ? "folder" : "file"}?</h2><p><strong>{deleteNode.name}</strong>{deleteNode.kind === "folder" ? " and everything inside it" : ""} will be permanently deleted {isSample ? "from the sample workspace" : "from your computer"}. This cannot be undone{isSample ? "." : " and does not move it to the trash."}</p>
          {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" autoFocus onClick={() => setDeleteNode(null)} disabled={dialogBusy}>Cancel</button><button type="button" className="danger-button" disabled={dialogBusy} onClick={() => void confirmDelete()}>{dialogBusy ? "Deleting…" : "Delete permanently"}</button></div>
        </div>
      </div>}

      {linkOpen && <div className="modal-backdrop" onMouseDown={() => setLinkOpen(false)}>
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="link-title" onSubmit={submitLink} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon"><Link2 size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setLinkOpen(false)} aria-label="Close dialog"><X size={18} /></button>
          <h2 id="link-title">Add a link</h2><p>Link the selected text, or insert an address at the cursor.</p>
          <label className="modal-label" htmlFor="link-url">Web address or email</label><input id="link-url" autoFocus value={linkValue} onChange={(event) => { setLinkValue(event.target.value); setDialogError(""); }} placeholder="example.com" />
          {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
          <div className="modal-actions">{formatting?.link && <button type="button" className="text-button" onClick={() => { editor?.chain().focus().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); }}>Remove link</button>}<button type="button" className="secondary-button" onClick={() => setLinkOpen(false)}>Cancel</button><button type="submit" className="primary-button">Add link</button></div>
        </form>
      </div>}

      {captureOpen && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setCaptureOpen(false)}>
        <form className="modal capture-modal" role="dialog" aria-modal="true" aria-labelledby="capture-title" onSubmit={(event) => void submitCapture(event)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon"><Sparkles size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setCaptureOpen(false)} aria-label="Close dialog" disabled={dialogBusy}><X size={18} /></button>
          <h2 id="capture-title">Quick capture</h2><p>Save a thought now and come back to it whenever you're ready.</p>
          <div className="capture-tabs" role="tablist" aria-label="Capture type">
            {(["text", "link", "image"] as const).map((type) => <button key={type} role="tab" type="button" aria-selected={captureType === type} className={captureType === type ? "active" : ""} onClick={() => { setCaptureType(type); setDialogError(""); }}>{type === "text" ? <FileText size={15} /> : type === "link" ? <Link2 size={15} /> : <ImageIcon size={15} />}{type[0].toUpperCase() + type.slice(1)}</button>)}
          </div>
          {captureType === "image" && <button className="image-picker" type="button" onClick={() => void chooseImage()}><ImageIcon size={17} /> {captureImage ? fileName(captureImage) : "Choose an image"}</button>}
          <label className="modal-label" htmlFor="capture-content">{captureType === "link" ? "Link" : captureType === "image" ? "Add a note (optional)" : "Your thought"}</label>
          <textarea id="capture-content" autoFocus value={captureText} onChange={(event) => { setCaptureText(event.target.value); setDialogError(""); }} placeholder={captureType === "link" ? "https://example.com" : captureType === "image" ? "A few words about this image…" : "What would you like to remember?"} />
          <span className="input-hint">Saved as a new Markdown note in Inbox{captureType === "image" && isSample ? ". Image capture requires a local folder." : "."}</span>
          {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCaptureOpen(false)} disabled={dialogBusy}>Cancel</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "Saving…" : "Save to inbox"}</button></div>
        </form>
      </div>}

      {desktopInfoOpen && <div className="modal-backdrop" onMouseDown={() => setDesktopInfoOpen(false)}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="desktop-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon"><FolderOpen size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setDesktopInfoOpen(false)} aria-label="Close dialog"><X size={18} /></button>
          <h2 id="desktop-title">Your notes, your folder</h2><p>Open a folder on your computer in the Comet desktop app. This browser preview is an interactive sample, {sampleVault.isPersisted() ? "saved only in this browser" : "kept temporarily for this session"}.</p>
          <div className="modal-actions"><button type="button" className="primary-button" onClick={() => setDesktopInfoOpen(false)}>Back to sample</button></div>
        </div>
      </div>}
      {restoring && <div className="restoring-overlay" role="status"><LoaderCircle size={20} className="spin" /> Reopening your workspace…</div>}
    </div>
  );
}

interface ToolButtonProps {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function ToolButton({ label, icon: Icon, active, disabled, onClick }: ToolButtonProps) {
  return <button className={active ? "format-button active" : "format-button"} type="button" title={label} aria-label={label} aria-pressed={active === undefined ? undefined : active} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick}><Icon size={17} /></button>;
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
    <div className={selected ? "tree-row selected" : "tree-row"}>
      <button type="button" className="tree-item" style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => folder ? onToggle(node.path) : onSelect(node.path)} onContextMenu={(event) => onContext(event, node)} aria-expanded={folder ? openFolder : undefined} aria-current={selected ? "page" : undefined} title={node.name}>
        <span className="tree-disclosure" aria-hidden="true">{folder ? (openFolder ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</span>
        {folder ? (openFolder ? <FolderOpen className="tree-icon folder" size={16} /> : <Folder className="tree-icon folder" size={16} />) : <FileText className="tree-icon" size={16} />}
        <span className="tree-name">{!folder && isMarkdown(node.name) ? noteTitle(node.name) : node.name}</span>
      </button>
      <button type="button" className="tree-action" aria-label={`More options for ${node.name}`} title={`More options for ${node.name}`} onClick={(event) => onContext(event, node)}><MoreHorizontal size={16} /></button>
    </div>
    {folder && openFolder && node.children.map((child) => <TreeNodeView key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} expanded={expanded} onToggle={onToggle} onSelect={onSelect} onContext={onContext} />)}
  </div>;
});

export default App;
