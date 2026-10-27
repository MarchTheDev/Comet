import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type MouseEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  AlertCircle, ArrowRight, Bold, BookOpen, CheckCircle2,
  ChevronDown, ChevronRight, Code2, FileCode2, FilePlus2, FileText, Folder,
  FolderOpen, FolderPlus, Image as ImageIcon, Italic, Link2, List,
  ListChecks, LoaderCircle, Maximize2, Minimize2,
  MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Quote, Redo2,
  Search, Settings2, Sparkles, Star, Pin, Tag, Upload, Underline, Strikethrough, Highlighter, ListOrdered, Trash2, Undo2, X, type LucideIcon,
} from "lucide-react";
import type { EditorProps } from "@tiptap/pm/view";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { APP_VERSION } from "virtual:comet-version";
import { SettingsPage } from "./SettingsPage";
import { WorkspacePanel, type WorkspaceLayout } from "./WorkspacePanel";
import { MediaView, YouTubeEmbeds } from "./MediaView";
import { SearchDialog } from "./SearchDialog";
import { TagDialog } from "./TagDialog";
import { isTextFile } from "./utils/fileTypes";
import { richTextExtensions } from "./utils/richText";
import { itemMeta, readWorkspaceMeta, saveWorkspaceMeta, updateItem, renameMeta, removeMeta, reorderChildren, type WorkspaceMeta } from "./utils/workspaceMeta";
import { readVaultList, saveVaultList, vaultLabel } from "./utils/vaultList";
import { countWords } from "./utils/markdown";
import { displayWorkspacePath, planWorkspacePath, type PathPlan } from "./utils/pathNavigation";
import { readSettings, saveSettings, type Settings } from "./utils/settings";
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
  normalizePath,
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
  importFile,
  moveEntry,
  readNote,
  renameEntry,
  restoreVaultAccess,
  searchVault,
  writeNote,
} from "./utils/vaultBridge";

type ViewMode = "write" | "source" | "read";
type WorkspaceView = "note" | "file" | "all" | "folder" | "pinned" | "favorites" | "settings";
type CaptureType = "text" | "link" | "image";
type CreateDialog = { kind: "note" | "folder"; folder: string };
type PathCreateDialog = Extract<PathPlan, { kind: "create" }> & { vault: string };
type ContextMenu = { x: number; y: number; node?: TreeNode; folder: string };

function initialSample() {
  const entries = sampleVault.list();
  const previous = readSampleSelection();
  const selected = entries.find((entry) => entry.path === previous && entry.kind === "file")
    ?? entries.find((entry) => entry.path === SAMPLE_WELCOME)
    ?? entries.find((entry) => entry.kind === "file" && isTextFile(entry.path));
  const path = selected?.path ?? "";
  const raw = path ? sampleVault.read(path) : "";
  const editable = Boolean(path && isTextFile(path) && !isSampleDataUrl(raw) && !raw.includes("\0"));
  return { entries, path, editable, content: editable ? raw : "", mediaUrl: isSampleDataUrl(raw) ? raw : "" };
}

function isSampleDataUrl(value: string): boolean { return /^data:[^,\s]*;base64,/i.test(value); }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [settings, setSettings] = useState(readSettings);
  const [settingsPersisted, setSettingsPersisted] = useState(true);
  const [sampleStart] = useState(initialSample);
  const [lastSession] = useState(() => desktopAvailable && settings.reopenWorkspace ? readSession() : null);
  const [restoring, setRestoring] = useState(Boolean(lastSession));
  const [vaultPath, setVaultPath] = useState(SAMPLE_ROOT);
  const [entries, setEntries] = useState<Entry[]>(sampleStart.entries);
  const [selectedPath, setSelectedPath] = useState(sampleStart.path);
  const [content, setContent] = useState(sampleStart.content);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(sampleStart.path ? (sampleStart.editable ? "note" : "file") : "all");
  const [folderPath, setFolderPath] = useState("");
  const [mediaUrl, setMediaUrl] = useState(sampleStart.mediaUrl);
  const [layout, setLayout] = useState<WorkspaceLayout>(() => { try { return localStorage.getItem("comet:workspace-layout") === "gallery" ? "gallery" : "list"; } catch { return "list"; } });
  const [iconSize, setIconSize] = useState(() => { try { const size = Number(localStorage.getItem("comet:workspace-icon-size")); return size >= 24 && size <= 72 ? size : 32; } catch { return 32; } });
  const [metadata, setMetadata] = useState<WorkspaceMeta>(() => readWorkspaceMeta(SAMPLE_ROOT));
  const [vaults, setVaults] = useState(readVaultList);
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [tagTarget, setTagTarget] = useState<string | null>(null);
  const [moveDialog, setMoveDialog] = useState<TreeNode | null>(null);
  const [moveFolder, setMoveFolder] = useState(SAMPLE_ROOT);
  const [uploadFolder, setUploadFolder] = useState(SAMPLE_ROOT);
  const [captureFolder, setCaptureFolder] = useState(SAMPLE_ROOT);
  const [pathDraft, setPathDraft] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  const [pathCreateDialog, setPathCreateDialog] = useState<PathCreateDialog | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(sampleStart.path && !isMarkdown(sampleStart.path) ? "source" : "write");
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

  const metaRef = useRef(metadata);
  const metaCache = useRef<Record<string, WorkspaceMeta>>({ [SAMPLE_ROOT]: metadata });
  metaRef.current = metadata;
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selectedRef = useRef(selectedPath);
  const vaultRef = useRef(vaultPath);
  const contentRef = useRef(content);
  const initialEditorContent = useRef(content);
  const modeRef = useRef(viewMode);
  const loadingRef = useRef(false);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const workspaceScrollRef = useRef<HTMLDivElement>(null);
  const previousExplorerOpen = useRef(explorerOpen);
  const previousWorkspaceView = useRef<WorkspaceView>(workspaceView);
  const saveQueue = useRef<SaveQueue | null>(null);
  if (!saveQueue.current) {
    saveQueue.current = new SaveQueue((path, value) => writeNote(vaultRef.current, path, value), setSaveState, () => setNotice("Couldn't save this note. Your changes are still here; use Retry to try again."));
  }
  const loadRequest = useRef(0);
  const queueSaveRef = useRef<(path: string, value: string) => void>(() => {});
  const selectNoteRef = useRef<(path: string) => void>(() => {});

  const orderItems = useCallback(<T extends Entry>(items: T[], parent: string) => {
    const order = metadata.order[normalizePath(parent)] ?? [];
    return [...items].sort((a, b) => {
      const ai = order.indexOf(normalizePath(a.path)), bi = order.indexOf(normalizePath(b.path));
      if (ai >= 0 || bi >= 0) return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
      return a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "folder" ? -1 : 1;
    });
  }, [metadata.order]);
  const tree = useMemo(() => {
    const sort = (items: TreeNode[], parent: string): TreeNode[] => orderItems(items, parent).map((item) => ({ ...item, children: sort(item.children, item.path) }));
    return sort(buildTree(entries, vaultPath), vaultPath);
  }, [entries, vaultPath, orderItems]);
  const notes = useMemo(() => entries.filter((entry) => entry.kind === "file"), [entries]);
  const noteCount = notes.length;
  const words = useMemo(() => countWords(content), [content]);
  const isSample = isSamplePath(vaultPath);
  const vaultName = isSample ? "Sample workspace" : fileName(vaultPath);
  const selectedName = selectedPath ? fileName(selectedPath) : "";
  const modifier = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘" : "Ctrl";
  const currentLocation = workspaceView === "note" || workspaceView === "file" ? selectedPath : workspaceView === "folder" ? folderPath : vaultPath;
  const displayedPath = displayWorkspacePath(currentLocation, vaultPath);
  const pathPlan = useMemo(() => planWorkspacePath(pathDraft, vaultPath, entries), [pathDraft, vaultPath, entries]);
  const folderEntries = useMemo(() => orderItems(entries.filter((entry) => parentPath(entry.path) === folderPath), folderPath), [entries, folderPath, orderItems]);
  const folderParent = parentPath(folderPath);
  const folderParentIsRoot = normalizePath(folderParent) === normalizePath(vaultPath);
  const workspaceDestination = workspaceView === "folder" ? folderPath : (workspaceView === "note" || workspaceView === "file") && selectedPath ? parentPath(selectedPath) || vaultPath : vaultPath;
  const workspaceEntries = workspaceView === "folder" ? folderEntries : workspaceView === "pinned" ? entries.filter((entry) => itemMeta(metadata, entry.path).pinned) : workspaceView === "favorites" ? entries.filter((entry) => itemMeta(metadata, entry.path).favorite) : orderItems(entries, vaultPath);

  useEffect(() => {
    const next = metaCache.current[vaultPath] ?? readWorkspaceMeta(vaultPath);
    metaCache.current[vaultPath] = next;
    metaRef.current = next;
    setMetadata(next);
  }, [vaultPath]);
  useEffect(() => { try { localStorage.setItem("comet:workspace-layout", layout); localStorage.setItem("comet:workspace-icon-size", String(iconSize)); } catch {} }, [layout, iconSize]);
  const commitMeta = useCallback((change: (current: WorkspaceMeta) => WorkspaceMeta) => {
    const next = change(metaRef.current);
    metaRef.current = next;
    metaCache.current[vaultRef.current] = next;
    setMetadata(next);
    if (!saveWorkspaceMeta(vaultRef.current, next)) setNotice("Organization changes will last for this session only.");
  }, []);
  const rememberVault = useCallback((path: string) => {
    if (isSamplePath(path)) return;
    setVaults((previous) => {
      const next = [path, ...previous.filter((item) => item !== path)].slice(0, 20);
      saveVaultList(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (workspaceScrollRef.current) workspaceScrollRef.current.scrollTop = 0;
  }, [workspaceView, selectedPath, folderPath, vaultPath]);

  useEffect(() => {
    setSettingsPersisted(saveSettings(settings));
  }, [settings]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = settings.theme === "system" ? (!media || media.matches ? "dark" : "light") : settings.theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#11171d" : "#f5f7f8");
    };
    applyTheme();
    if (settings.theme === "system") media?.addEventListener?.("change", applyTheme);
    return () => media?.removeEventListener?.("change", applyTheme);
  }, [settings.theme]);

  useEffect(() => {
    if (!settings.reopenWorkspace) clearSession();
    else if (desktopAvailable && !isSamplePath(vaultRef.current)) saveSession({ vault: vaultRef.current, note: selectedRef.current });
  }, [settings.reopenWorkspace]);

  const persistSession = useCallback((vault: string, note: string) => {
    if (settingsRef.current.reopenWorkspace) saveSession({ vault, note });
  }, []);
  const updateSettings = useCallback((patch: Partial<Settings>) => setSettings((previous) => ({ ...previous, ...patch })), []);

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
    ...richTextExtensions,
    localImage,
    Markdown,
  ], [localImage]);
  const editorProps = useMemo<EditorProps>(() => ({
      attributes: {
        class: "comet-editor-prose",
        role: "textbox",
        "aria-label": "Note editor",
        "aria-multiline": "true",
        "aria-readonly": String(viewMode !== "write"),
        spellcheck: String(settings.spellcheck),
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
  }), [settings.spellcheck, viewMode]);

  const editor = useEditor({
    extensions,
    content: initialEditorContent.current,
    contentType: "markdown",
    editorProps,
    onUpdate: ({ editor: currentEditor }) => {
      if (loadingRef.current || !selectedRef.current || modeRef.current !== "write" || !isMarkdown(selectedRef.current)) return;
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
    if (isMarkdown(selectedRef.current)) loadMarkdownNote(editor, contentRef.current);
    editor.setEditable(modeRef.current === "write" && isMarkdown(selectedRef.current), false);
  }, [editor]);
  const formatting = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      headingLevel: [1, 2, 3].find((level) => current?.isActive("heading", { level })) ?? 0,
      underline: current?.isActive("underline") ?? false,
      strike: current?.isActive("strike") ?? false,
      highlight: current?.isActive("highlight") ?? false,
      orderedList: current?.isActive("orderedList") ?? false,
      fontSize: String(current?.getAttributes("textStyle").fontSize || ""),
      textColor: String(current?.getAttributes("textStyle").color || "#e6a17f"),
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
    if (!isPathInside(path, vaultRef.current) || normalizePath(path) === normalizePath(vaultRef.current)) {
      setNotice("Choose a file inside the current workspace.");
      return;
    }
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return;
      loadingRef.current = true;
      setLoading(true);
      const text = isTextFile(path);
      const next = text ? await readNote(vaultRef.current, path) : "";
      if (text && ((isSamplePath(vaultRef.current) && isSampleDataUrl(next)) || next.includes("\0"))) throw new Error("This file contains binary data, not editable text.");
      const asset = text ? "" : isSamplePath(vaultRef.current) ? sampleVault.read(path) : convertFileSrc(path);
      if (request !== loadRequest.current) return;
      const previousWasMarkdown = isMarkdown(selectedRef.current);
      selectedRef.current = path;
      contentRef.current = next;
      setSelectedPath(path);
      setContent(next);
      setMediaUrl(asset);
      setWorkspaceView(text ? "note" : "file");
      if (text) {
        const mode: ViewMode = isMarkdown(path) ? (previousWasMarkdown ? modeRef.current : "write") : "source";
        modeRef.current = mode;
        setViewMode(mode);
        if (isMarkdown(path)) loadMarkdownNote(editorRef.current, next);
        editorRef.current?.setEditable(mode === "write" && isMarkdown(path), false);
      }
      if (isSamplePath(vaultRef.current)) saveSampleSelection(path);
      else persistSession(vaultRef.current, path);
      setSaveState("saved");
      expandParents(path, vaultRef.current);
      if (window.innerWidth <= 760) setExplorerOpen(false);
    } catch (error) {
      if (request === loadRequest.current) setNotice(`Couldn't open file: ${errorMessage(error)}`);
    } finally {
      if (request === loadRequest.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [expandParents, flushAll, persistSession]);
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
        let nextPath = nextEntries.some((entry) => entry.path === lastSession.note && entry.kind === "file")
          ? lastSession.note : "";
        let nextContent = "";
        if (nextPath && isTextFile(nextPath)) {
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
        setMediaUrl(nextPath && !isTextFile(nextPath) ? convertFileSrc(nextPath) : "");
        setWorkspaceView(nextPath ? (isTextFile(nextPath) ? "note" : "file") : "all");
        modeRef.current = nextPath && !isMarkdown(nextPath) ? "source" : "write";
        setViewMode(modeRef.current);
        setExpanded(new Set());
        if (nextPath) expandParents(nextPath, lastSession.vault);
        loadMarkdownNote(editorRef.current, isMarkdown(nextPath) ? nextContent : "");
        persistSession(lastSession.vault, nextPath);
        rememberVault(lastSession.vault);
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
  }, [lastSession, expandParents, persistSession, rememberVault]);

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

  const activateVault = useCallback(async (path: string, restore: boolean) => {
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return;
      loadingRef.current = true;
      setLoading(true);
      if (restore) await restoreVaultAccess(path);
      const next = await listVault(path);
      if (request !== loadRequest.current) return;
      vaultRef.current = path;
      selectedRef.current = "";
      contentRef.current = "";
      setVaultPath(path);
      setEntries(next);
      setSelectedPath("");
      setContent("");
      setMediaUrl("");
      setWorkspaceView("all");
      setFolderPath("");
      setExpanded(new Set());
      setSearchQuery("");
      setSaveState("saved");
      loadMarkdownNote(editorRef.current, "");
      persistSession(path, "");
      rememberVault(path);
      setVaultMenuOpen(false);
      setNotice("Workspace opened.");
    } catch (error) {
      if (request === loadRequest.current) setNotice(`Couldn't open workspace: ${errorMessage(error)}`);
    } finally {
      if (request === loadRequest.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [flushAll, persistSession, rememberVault]);

  const openVault = useCallback(async () => {
    if (!desktopAvailable) { setDesktopInfoOpen(true); setVaultMenuOpen(false); return; }
    try {
      const path = await open({ directory: true, multiple: false, title: "Open your Comet vault" });
      if (path && !Array.isArray(path)) await activateVault(path, false);
    } catch (error) { setNotice(`Couldn't open workspace: ${errorMessage(error)}`); }
  }, [activateVault]);

  const activateSample = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return;
      const sample = initialSample();
      vaultRef.current = SAMPLE_ROOT; selectedRef.current = sample.path; contentRef.current = sample.content;
      setVaultPath(SAMPLE_ROOT); setEntries(sample.entries); setSelectedPath(sample.path); setContent(sample.content); setMediaUrl(sample.mediaUrl);
      setExpanded(new Set()); setFolderPath(""); setVaultMenuOpen(false);
      modeRef.current = sample.path && !isMarkdown(sample.path) ? "source" : "write";
      setViewMode(modeRef.current);
      setWorkspaceView(sample.path ? (sample.editable ? "note" : "file") : "all");
      loadMarkdownNote(editorRef.current, isMarkdown(sample.path) ? sample.content : "");
    } catch (error) { setNotice(`Couldn't switch workspace: ${errorMessage(error)}`); }
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

  const showOverview = useCallback(async (view: "all" | "pinned" | "favorites") => {
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return;
      loadingRef.current = false;
      setLoading(false);
      setWorkspaceView(view);
      setSearchQuery("");
      if (window.innerWidth <= 760) setExplorerOpen(false);
    } catch {
      if (request === loadRequest.current) {
        loadingRef.current = false;
        setLoading(false);
        setNotice("Couldn't save this note. Retry the save before leaving it.");
      }
    }
  }, [flushAll]);

  const showFolder = useCallback(async (path: string) => {
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return;
      loadingRef.current = false;
      setLoading(false);
      setFolderPath(path);
      setWorkspaceView("folder");
      setExpanded((previous) => new Set([...previous, path]));
      expandParents(path, vaultRef.current);
      setSearchQuery("");
      if (window.innerWidth <= 760) setExplorerOpen(false);
    } catch {
      if (request === loadRequest.current) {
        loadingRef.current = false;
        setLoading(false);
        setNotice("Couldn't save this note. Retry the save before leaving it.");
      }
    }
  }, [expandParents, flushAll]);

  const showSettings = useCallback(async () => {
    if (workspaceView === "settings") return;
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return;
      loadingRef.current = false;
      setLoading(false);
      previousWorkspaceView.current = workspaceView;
      setWorkspaceView("settings");
      setContextMenu(null);
      if (window.innerWidth <= 760) setExplorerOpen(false);
    } catch {
      if (request === loadRequest.current) {
        loadingRef.current = false;
        setLoading(false);
        setNotice("Couldn't save this note. Retry the save before opening settings.");
      }
    }
  }, [flushAll, workspaceView]);

  const goToPath = (plan: PathPlan) => {
    if (plan.kind === "error") return;
    setPathEditing(false);
    pathInputRef.current?.blur();
    setSearchQuery("");
    if (plan.kind === "root") void showOverview("all");
    else if (plan.kind === "folder") void showFolder(plan.path);
    else if (plan.kind === "note") void selectNote(plan.path);
    else if (plan.kind === "create") {
      ++loadRequest.current;
      loadingRef.current = false;
      setLoading(false);
      setDialogError("");
      setDialogBusy(false);
      setPathCreateDialog({ ...plan, vault: vaultRef.current });
    }
  };

  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    goToPath(planWorkspacePath(pathEditing ? pathDraft : displayedPath, vaultRef.current, entries));
  };

  const confirmPathCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!pathCreateDialog || dialogBusy) return;
    setDialogBusy(true);
    setDialogError("");
    try {
      await flushAll();
      if (vaultRef.current !== pathCreateDialog.vault) throw new Error("The workspace changed. Please enter the path again.");
      // The bridge creates missing parents and uses exclusive creation; it never overwrites a file.
      await createNote(pathCreateDialog.vault, pathCreateDialog.path, "");
      try {
        await refresh(pathCreateDialog.vault);
      } catch {
        setNotice("The note was created, but the folder list couldn't refresh.");
      }
      expandParents(pathCreateDialog.path, pathCreateDialog.vault);
      setPathCreateDialog(null);
      changeMode("write");
      await selectNote(pathCreateDialog.path);
      window.setTimeout(() => editorRef.current?.commands.focus(), 0);
    } catch (error) {
      // Refresh the listing after a collision or partial parent creation.
      void refresh(pathCreateDialog.vault).catch(() => undefined);
      setDialogError(errorMessage(error));
    } finally {
      setDialogBusy(false);
    }
  };

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
    setEntryName(node.name);
    setDialogError("");
    setDialogBusy(false);
    setContextMenu(null);
    setRenameNode(node);
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!renameNode || dialogBusy) return;
    const kind = renameNode.kind === "folder" ? "folder" : "file";
    const { name, error } = validEntryName(entryName, kind);
    if (error) { setDialogError(error); return; }
    const destination = joinPath(parentPath(renameNode.path), name);
    if (destination === renameNode.path) { setRenameNode(null); return; }
    setDialogBusy(true);
    setDialogError("");
    try {
      await flushAll();
      await renameEntry(vaultRef.current, renameNode.path, destination);
      let selectedToReload = "";
      if (selectedRef.current && isPathInside(selectedRef.current, renameNode.path)) {
        const nextPath = remapPath(selectedRef.current, renameNode.path, destination);
        selectedRef.current = nextPath;
        setSelectedPath(nextPath);
        if (workspaceView === "note" || workspaceView === "file") {
          selectedToReload = nextPath;
          loadingRef.current = true;
          setLoading(true);
        }
        if (isSamplePath(vaultRef.current)) saveSampleSelection(nextPath);
        else persistSession(vaultRef.current, nextPath);
      }
      setFolderPath((previous) => previous ? remapPath(previous, renameNode.path, destination) : previous);
      commitMeta((current) => renameMeta(current, renameNode.path, destination));
      setExpanded((previous) => new Set([...previous].map((path) => remapPath(path, renameNode.path, destination))));
      setSearchQuery("");
      await refresh(vaultRef.current);
      setRenameNode(null);
      setNotice(`Renamed to “${name}”.`);
      if (selectedToReload) await selectNote(selectedToReload);
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
        else persistSession(vaultRef.current, "");
      }
      if (folderPath && isPathInside(folderPath, deleteNode.path)) {
        setFolderPath("");
        if (workspaceView === "folder") setWorkspaceView("all");
        else if (workspaceView === "settings" && previousWorkspaceView.current === "folder") previousWorkspaceView.current = "all";
      }
      commitMeta((current) => removeMeta(current, deleteNode.path));
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
    setCaptureFolder(workspaceDestination);
    setDialogError("");
    setDialogBusy(false);
    setContextMenu(null);
    setCaptureOpen(true);
  }, [workspaceDestination]);

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
    if (captureFolder !== vaultRef.current && !entries.some((entry) => entry.kind === "folder" && entry.path === captureFolder)) {
      setDialogError("Choose a folder inside your current workspace.");
      return;
    }
    setDialogBusy(true);
    setDialogError("");
    try {
      await flushAll();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      if (captureType === "image") {
        const name = `${stamp}-${fileName(captureImage).replace(/[^a-zA-Z0-9._-]/g, "-")}`;
        const dest = joinPath(captureFolder, name);
        await invoke("copy_asset", { vault: vaultRef.current, src: captureImage, dest });
        body = `![${fileName(captureImage).replace(/[\[\]]/g, "")}](./${name})${body ? `\n\n${body}` : ""}`;
      }
      const title = captureTitle.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").slice(0, 45).trim() || "Quick capture";
      const path = joinPath(captureFolder, `${title} - ${stamp}.md`);
      await createNote(vaultRef.current, path, body);
      await refresh(vaultRef.current);
      setExpanded((previous) => new Set([...previous, captureFolder]));
      setCaptureOpen(false);
      changeMode("write");
      await selectNote(path);
      setNotice(`Captured to ${captureFolder === vaultRef.current ? "workspace" : fileName(captureFolder)}.`);
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setDialogBusy(false);
    }
  };

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query || !searchOpen) { setSearchResults([]); setSearching(false); return; }
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try { await flushAll(); } catch { if (active) setNotice("Couldn't save; search may not include your latest changes."); }
        const tagOnly = query.startsWith("#");
        const term = (tagOnly ? query.slice(1) : query).trim().toLowerCase();
        const matchingTags = metadata.tags.filter((tag) => tag.name.toLowerCase().includes(term));
        const ids = new Set(matchingTags.map((tag) => tag.id));
        const matched = entries.filter((entry) => {
          const hasTag = itemMeta(metadata, entry.path).tags.some((id) => ids.has(id));
          return tagOnly ? hasTag : entry.name.toLowerCase().includes(term) || hasTag;
        }).map((entry) => ({ path: entry.path, name: entry.name, snippet: itemMeta(metadata, entry.path).tags.map((id) => metadata.tags.find((tag) => tag.id === id)?.name).filter(Boolean).map((name) => `#${name}`).join(" ") || (entry.kind === "folder" ? "Folder" : "File") }));
        const contentResults = tagOnly ? [] : await searchVault(vaultPath, query);
        const combined = new Map<string, SearchHit>();
        for (const result of [...matched, ...contentResults]) combined.set(result.path, result);
        return [...combined.values()].slice(0, 100);
      })().then((results) => { if (active) setSearchResults(results); })
        .catch(() => { if (active) setNotice("Search couldn't finish. Please try again."); })
        .finally(() => { if (active) setSearching(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [entries, flushAll, metadata, searchOpen, searchQuery, vaultPath]);

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

  const modalOpen = Boolean(createDialog || pathCreateDialog || renameNode || deleteNode || linkOpen || captureOpen || desktopInfoOpen || searchOpen || tagDialogOpen || moveDialog);
  useEffect(() => {
    if (!modalOpen) return;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    if (!dialog) return;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
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
  }, [modalOpen, searchOpen, tagDialogOpen, moveDialog]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        if (!dialogBusy) {
          setCreateDialog(null);
          setPathCreateDialog(null);
          setRenameNode(null);
          setDeleteNode(null);
          setLinkOpen(false);
          setCaptureOpen(false);
          setDesktopInfoOpen(false);
          setSearchOpen(false);
          setTagDialogOpen(false);
          setMoveDialog(null);
          setVaultMenuOpen(false);
        }
        return;
      }
      if (createDialog || pathCreateDialog || renameNode || deleteNode || linkOpen || captureOpen || desktopInfoOpen || searchOpen || tagDialogOpen || moveDialog || restoring) return;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (command && key === "k" && !event.shiftKey) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (command && key === "k" && event.shiftKey) {
        event.preventDefault();
        openCapture();
      } else if (command && key === "l") {
        event.preventDefault();
        pathInputRef.current?.focus();
        pathInputRef.current?.select();
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
  }, [captureOpen, createDialog, pathCreateDialog, renameNode, deleteNode, linkOpen, desktopInfoOpen, searchOpen, tagDialogOpen, moveDialog, dialogBusy, restoring, flushAll, flushPending, openCapture, openCreate]);

  const focusSearch = () => { setSearchOpen(true); };

  const toggleFolder = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleTreeSelect = useCallback((path: string) => { void selectNote(path); }, [selectNote]);
  const handleTreeFolder = useCallback((path: string) => { void showFolder(path); }, [showFolder]);
  const handleTreeContext = useCallback((event: MouseEvent, item: TreeNode) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || bounds.right;
    const y = event.clientY || bounds.bottom;
    setContextMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 240)), y: Math.max(8, Math.min(y, window.innerHeight - 390)), node: item, folder: item.kind === "folder" ? item.path : parentPath(item.path) || vaultRef.current });
  }, []);

  const openNewMenu = (event: MouseEvent, folder: string) => {
    event.preventDefault(); event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || bounds.left, y = event.clientY || bounds.bottom;
    setContextMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 240)), y: Math.max(8, Math.min(y, window.innerHeight - 190)), folder });
  };
  const entryContext = (event: MouseEvent, entry: Entry) => handleTreeContext(event, { ...entry, children: [] });
  const openEntry = (entry: Entry) => { if (entry.kind === "folder") void showFolder(entry.path); else void selectNote(entry.path); };
  const toggleProperty = (path: string, property: "pinned" | "favorite") => {
    commitMeta((current) => updateItem(current, path, { [property]: !itemMeta(current, path)[property] }));
    setContextMenu(null);
  };
  const openTags = (path: string | null = null) => { setTagTarget(path); setTagDialogOpen(true); setContextMenu(null); };
  const createTag = (name: string, color: string): string => {
    const clean = name.trim();
    if (!clean || clean.length > 40) return "Use a tag name between 1 and 40 characters.";
    if (metaRef.current.tags.some((tag) => tag.name.toLowerCase() === clean.toLowerCase())) return "A tag with this name already exists.";
    const tag = { id: globalThis.crypto?.randomUUID?.() ?? `tag-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: clean, color };
    commitMeta((current) => {
      const next = { ...current, tags: [...current.tags, tag] };
      return tagTarget ? updateItem(next, tagTarget, { tags: [...itemMeta(next, tagTarget).tags, tag.id] }) : next;
    });
    return "";
  };
  const deleteTag = (id: string) => commitMeta((current) => ({
    ...current,
    tags: current.tags.filter((tag) => tag.id !== id),
    items: Object.fromEntries(Object.entries(current.items).map(([path, item]) => [path, { ...item, tags: item.tags.filter((tag) => tag !== id) }])),
  }));
  const toggleTag = (path: string, id: string) => commitMeta((current) => {
    const tags = itemMeta(current, path).tags;
    return updateItem(current, path, { tags: tags.includes(id) ? tags.filter((tag) => tag !== id) : [...tags, id] });
  });

  const moveItem = useCallback(async (source: string, folder: string) => {
    if (!isPathInside(source, vaultRef.current) || !isPathInside(folder, vaultRef.current)) return;
    const request = ++loadRequest.current;
    const vault = vaultRef.current;
    try {
      await flushAll();
      if (request !== loadRequest.current || vaultRef.current !== vault) return;
      const next = await moveEntry(vault, source, folder);
      if (vaultRef.current !== vault) {
        const updated = renameMeta(metaCache.current[vault] ?? readWorkspaceMeta(vault), source, next);
        metaCache.current[vault] = updated;
        saveWorkspaceMeta(vault, updated);
        return;
      }
      commitMeta((current) => renameMeta(current, source, next));
      setExpanded((previous) => new Set([...previous].map((path) => remapPath(path, source, next))));
      setFolderPath((previous) => remapPath(previous, source, next));
      if (selectedRef.current && isPathInside(selectedRef.current, source)) {
        const selected = remapPath(selectedRef.current, source, next);
        selectedRef.current = selected;
        setSelectedPath(selected);
        if (isMarkdown(selected)) loadMarkdownNote(editorRef.current, contentRef.current);
        if (!isTextFile(selected)) setMediaUrl(isSamplePath(vaultRef.current) ? sampleVault.read(selected) : convertFileSrc(selected));
        if (isSamplePath(vaultRef.current)) saveSampleSelection(selected); else persistSession(vaultRef.current, selected);
      }
      await refresh(vaultRef.current);
      setExpanded((previous) => new Set([...previous, folder]));
      setMoveDialog(null);
      setNotice(`Moved to ${folder === vaultRef.current ? "workspace" : fileName(folder)}. Links in other notes are unchanged.`);
    } catch (error) { setNotice(`Couldn't move: ${errorMessage(error)}`); }
  }, [commitMeta, flushAll, persistSession, refresh]);

  const importPaths = useCallback(async (paths: string[], folder: string) => {
    const vault = vaultRef.current;
    if (!paths.length || !isPathInside(folder, vault)) return;
    try {
      await flushAll();
      let imported = 0;
      const errors: string[] = [];
      for (const path of paths) {
        try { await importFile(vault, path, folder); imported++; }
        catch (error) { errors.push(`${fileName(path)}: ${errorMessage(error)}`); }
      }
      await refresh(vault);
      if (vaultRef.current === vault) setExpanded((previous) => new Set([...previous, folder]));
      setNotice(errors.length ? `${imported} imported. ${errors.join(" ")}` : `${imported} ${imported === 1 ? "file" : "files"} added.`);
    } catch (error) { setNotice(`Couldn't import: ${errorMessage(error)}`); }
  }, [flushAll, refresh]);

  const importBrowserFiles = async (files: File[], folder: string) => {
    if (!isSamplePath(vaultRef.current)) { setNotice("Use the desktop file picker to import files into your workspace."); return; }
    let imported = 0;
    const errors: string[] = [];
    for (const file of files) {
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("The browser sample supports files up to 20 MB; use the desktop app for larger files.");
        const checked = validEntryName(file.name, "file");
        if (checked.error) throw new Error(checked.error);
        let value: string;
        if (isTextFile(file.name)) {
          value = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
          if (value.includes("\0")) throw new Error("This text file contains binary data.");
        } else {
          value = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Couldn't read file."));
            reader.onerror = () => reject(reader.error ?? new Error("Couldn't read file."));
            reader.readAsDataURL(file);
          });
        }
        sampleVault.createNote(joinPath(folder, checked.name), value);
        imported++;
      } catch (error) { errors.push(`${file.name}: ${errorMessage(error)}`); }
    }
    await refresh(vaultRef.current);
    setExpanded((previous) => new Set([...previous, folder]));
    const temporary = !sampleVault.isPersisted() ? " Browser storage is full or unavailable; sample changes last only for this session." : "";
    setNotice((errors.length ? `${imported} imported. ${errors.join(" ")}` : `${imported} ${imported === 1 ? "file" : "files"} added to the sample.`) + temporary);
  };

  const upload = async (folder: string) => {
    setContextMenu(null);
    if (isSamplePath(vaultRef.current)) { setUploadFolder(folder); uploadInputRef.current?.click(); return; }
    try {
      const paths = await open({ directory: false, multiple: true, title: "Add files to your workspace" });
      if (paths) await importPaths(Array.isArray(paths) ? paths : [paths], folder);
    } catch (error) { setNotice(`Couldn't choose files: ${errorMessage(error)}`); }
  };
  const dragStart = (event: DragEvent, entry: Entry) => {
    event.dataTransfer.setData("application/x-comet-entry", JSON.stringify({ vault: vaultRef.current, path: entry.path }));
    event.dataTransfer.effectAllowed = "move";
  };
  const draggedPath = (event: DragEvent): string => {
    try {
      const data = JSON.parse(event.dataTransfer.getData("application/x-comet-entry"));
      return data.vault === vaultRef.current && typeof data.path === "string" ? data.path : "";
    } catch { return ""; }
  };
  const dropToFolder = (event: DragEvent, folder: string) => {
    event.preventDefault(); event.stopPropagation();
    const path = draggedPath(event);
    if (path) void moveItem(path, folder);
    else if (event.dataTransfer.files.length) void importBrowserFiles([...event.dataTransfer.files], folder);
  };
  const dropOnTree = (event: DragEvent, item: TreeNode) => {
    event.preventDefault(); event.stopPropagation();
    const source = draggedPath(event);
    if (!source) { if (item.kind === "folder" && event.dataTransfer.files.length) void importBrowserFiles([...event.dataTransfer.files], item.path); return; }
    if (source === item.path) return;
    const sourceParent = parentPath(source), targetParent = parentPath(item.path);
    const bounds = event.currentTarget.getBoundingClientRect();
    const before = event.clientY < bounds.top + bounds.height / 2;
    const nearEdge = event.clientY < bounds.top + bounds.height * 0.25 || event.clientY > bounds.bottom - bounds.height * 0.25;
    if (sourceParent === targetParent && (item.kind !== "folder" || nearEdge)) {
      const siblings = orderItems(entries.filter((entry) => parentPath(entry.path) === targetParent), targetParent).map((entry) => entry.path);
      commitMeta((current) => reorderChildren(current, targetParent, siblings, source, item.path, !before));
    } else if (item.kind === "folder") void moveItem(source, item.path);
    else setNotice("Drop on a folder to move an item, or on a sibling to reorder it.");
  };

  useEffect(() => {
    if (!desktopAvailable || isSamplePath(vaultPath)) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const scale = window.devicePixelRatio || 1;
      const target = document.elementFromPoint(event.payload.position.x / scale, event.payload.position.y / scale);
      const folder = target?.closest<HTMLElement>("[data-drop-folder]")?.dataset.dropFolder;
      if (folder) void importPaths(event.payload.paths, folder);
      else setNotice("Drop files on a workspace or folder to import them.");
    }).then((off) => { if (disposed) off(); else unlisten = off; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [vaultPath, importPaths]);

  const openUnknownAsText = async () => {
    try {
      let next = await readNote(vaultRef.current, selectedRef.current);
      if (isSamplePath(vaultRef.current) && isSampleDataUrl(next)) {
        // Browser sample uploads are stored as data URLs; decode only after the
        // user explicitly asks to try text, and reject invalid UTF-8.
        try { next = new TextDecoder("utf-8", { fatal: true }).decode(await (await fetch(next)).arrayBuffer()); }
        catch { throw new Error("This file contains binary data and cannot be edited as text."); }
      }
      if (next.includes("\0")) throw new Error("This file contains binary data and cannot be edited as text.");
      contentRef.current = next; setContent(next);
      modeRef.current = "source"; setViewMode("source"); setWorkspaceView("note");
    } catch (error) { setNotice(`Couldn't open as text: ${errorMessage(error)}`); }
  };
  const openExternal = async () => {
    try { await invoke("open_vault_file", { vault: vaultRef.current, path: selectedRef.current }); }
    catch (error) { setNotice(`Couldn't open file: ${errorMessage(error)}`); }
  };

  const saveLabel = saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved changes" : "Saved";

  return (
    <div className={`comet-root${focusMode ? " focus-mode" : ""}${settings.showCover ? " mountain-visible" : ""}`} style={{ "--editor-font-size": `${settings.editorFontSize}px` } as CSSProperties} onClick={(event) => { if (contextMenu) setContextMenu(null); if (vaultMenuOpen && !(event.target as Element).closest(".workspace-switcher")) setVaultMenuOpen(false); }}>
      <div className="app-shell">
        {explorerOpen && <button className="sidebar-scrim" type="button" aria-label="Close sidebar" onClick={() => setExplorerOpen(false)} />}
        {explorerOpen && <aside className="sidebar" aria-label="Workspace navigation">
          <div className="sidebar-brand">
            <div className="brand-mark" aria-hidden="true"><img src="/comet.svg" alt="" /></div>
            <div className="brand-name">comet<span>.</span></div>
            <button className="sidebar-close-mobile icon-button" type="button" aria-label="Close sidebar" onClick={() => setExplorerOpen(false)}><X size={18} /></button>
          </div>

          <div className="workspace-switcher">
            <button className="workspace-picker" type="button" onClick={() => setVaultMenuOpen((value) => !value)} aria-label="Switch workspace" aria-expanded={vaultMenuOpen}>
              <span className="workspace-avatar">{isSample ? "S" : vaultName.slice(0, 1).toUpperCase()}</span>
              <span className="workspace-picker-copy"><strong>{vaultName}</strong><small>{isSample ? (desktopAvailable ? "Sample data" : "Interactive browser sample") : "Local workspace"}</small></span>
              <ChevronDown size={16} className="workspace-chevron" aria-hidden="true" />
            </button>
            {vaultMenuOpen && <div className="vault-dropdown">
              <span className="dropdown-label">WORKSPACES</span>
              <button type="button" className={isSample ? "vault-option selected" : "vault-option"} onClick={() => void activateSample()}><span className="vault-mini-avatar">S</span><span>Sample workspace</span>{isSample && <CheckCircle2 size={14} />}</button>
              {vaults.map((path) => <div className="vault-option-row" key={path}><button type="button" className={path === vaultPath ? "vault-option selected" : "vault-option"} onClick={() => void activateVault(path, true)} title={path}><span className="vault-mini-avatar">{vaultLabel(path).slice(0, 1).toUpperCase()}</span><span>{vaultLabel(path)}</span>{path === vaultPath && <CheckCircle2 size={14} />}</button><button type="button" className="icon-button vault-remove" title="Remove from list (files stay on disk)" aria-label={`Remove ${vaultLabel(path)} from workspace list`} onClick={() => { const next = vaults.filter((item) => item !== path); setVaults(next); saveVaultList(next); }}><X size={14} /></button></div>)}
              <div className="context-divider" /><button type="button" className="vault-add" onClick={() => void openVault()}><Plus size={16} /> Add workspace</button>
            </div>}
          </div>

          <button className="sidebar-search" type="button" onClick={focusSearch} aria-label="Search files and tags"><Search size={16} /><span>Search anything</span><kbd>{modifier} K</kbd></button>
          <nav className="primary-nav" aria-label="Library">
            <button className={workspaceView === "all" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "all" ? "page" : undefined} onClick={() => void showOverview("all")}><BookOpen size={17} /><span>All files</span><small>{noteCount}</small></button>
            <button className={workspaceView === "pinned" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "pinned" ? "page" : undefined} onClick={() => void showOverview("pinned")}><Pin size={17} /><span>Pinned</span><small>{entries.filter((entry) => itemMeta(metadata, entry.path).pinned).length}</small></button>
            <button className={workspaceView === "favorites" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "favorites" ? "page" : undefined} onClick={() => void showOverview("favorites")}><Star size={17} /><span>Favorites</span><small>{entries.filter((entry) => itemMeta(metadata, entry.path).favorite).length}</small></button>
            <button className="nav-item" type="button" onClick={() => openTags()}><Tag size={17} /><span>Manage tags</span><ChevronRight size={14} className="settings-nav-arrow" /></button>
          </nav>
          <div className="sidebar-section-heading">
            <span>YOUR FILES</span>
            <div className="section-actions"><button type="button" className="icon-button section-add" onClick={() => openCreate("folder", vaultPath)} aria-label="New folder" title="New folder"><FolderPlus size={16} /></button><button type="button" className="icon-button section-add" onClick={(event) => openNewMenu(event, vaultPath)} aria-label="Add file or upload" title="New file, folder, or upload"><Plus size={18} /></button></div>
          </div>
          <div className="tree-scroll" data-drop-folder={vaultPath} onContextMenu={(event) => { if (event.target === event.currentTarget || (event.target as Element).classList.contains("tree-list")) openNewMenu(event, vaultPath); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropToFolder(event, vaultPath)}>
            {tree.length === 0 && <div className="tree-message">Nothing here yet.<br /><span>Create a file to get started.</span></div>}
            <div className="tree-list">{tree.map((node) => <TreeNodeView key={node.path} node={node} depth={0} selectedPath={workspaceView === "note" || workspaceView === "file" ? selectedPath : workspaceView === "folder" ? folderPath : ""} expanded={expanded} metadata={metadata} onToggle={toggleFolder} onSelect={handleTreeSelect} onOpenFolder={handleTreeFolder} onContext={handleTreeContext} onDragStart={dragStart} onDrop={dropOnTree} />)}</div>
          </div>
          <div className="sidebar-bottom">
            <button className={workspaceView === "settings" ? "nav-item settings-nav active" : "nav-item settings-nav"} type="button" aria-current={workspaceView === "settings" ? "page" : undefined} onClick={() => void showSettings()}><Settings2 size={17} /><span>Settings</span><ChevronRight size={14} className="settings-nav-arrow" /></button>
            <div className="sidebar-footer"><span>{isSample ? (sampleVault.isPersisted() ? "Sample · saved here" : "Sample · temporary") : "Local workspace"}</span><span>v{APP_VERSION}</span></div>
          </div>
        </aside>}

        <main className="main-area">
          <header className="app-topbar">
            <div className="topbar-left">
              <button className="icon-button sidebar-toggle" type="button" onClick={() => { setExplorerOpen((value) => !value); if (focusMode) setFocusMode(false); }} aria-label={explorerOpen ? "Hide sidebar" : "Show sidebar"} aria-expanded={explorerOpen} title={`Toggle sidebar (${modifier}+\\)`}>{explorerOpen ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}</button>
            </div>
              <form className="pathbar" onSubmit={submitPath} onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPathEditing(false); }}>
                <div className="pathbar-field">
                  <FolderOpen size={16} aria-hidden="true" />
                  <input ref={pathInputRef} aria-label="Workspace path" aria-describedby={pathEditing ? "path-hint" : undefined} autoComplete="off" spellCheck={false} value={pathEditing ? pathDraft : displayedPath} placeholder={"Comet\\Folder\\note.md"} onFocus={(event) => { setPathDraft(event.currentTarget.value); setPathEditing(true); }} onChange={(event) => setPathDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setPathEditing(false); event.currentTarget.blur(); } }} />
                  <kbd className="path-shortcut">{modifier} L</kbd>
                  <button type="submit" className="path-go" aria-label="Go to path" title="Open or create this path"><ArrowRight size={15} /></button>
                </div>
                {pathEditing && <div className="path-popover" id="path-hint" aria-live="polite">
                  <div className="path-popover-heading"><span>GO TO A PATH</span><span>IN THIS WORKSPACE</span></div>
                  <p>Type a folder or file path, then press Enter.</p>
                  {pathPlan.kind === "error" ? <div className="path-feedback error"><AlertCircle size={16} /><span>{pathPlan.message}</span></div> : <button className="path-feedback" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => goToPath(pathPlan)}>
                    <span className="path-feedback-icon">{pathPlan.kind === "folder" || pathPlan.kind === "root" ? <FolderOpen size={16} /> : pathPlan.kind === "create" ? <FilePlus2 size={16} /> : <FileText size={16} />}</span>
                    <span><strong>{pathPlan.kind === "root" ? "Open all files" : pathPlan.kind === "folder" ? "Open folder" : pathPlan.kind === "note" ? "Open file" : "Create a new file"}</strong><small>{pathPlan.kind === "root" ? "Comet" : displayWorkspacePath(pathPlan.path, vaultPath)}</small></span>
                    <kbd>↵</kbd>
                  </button>}
                  <div className="path-popover-foot">Use / or {"\\"} · New folders are created with your file.</div>
                </div>}
              </form>
            <div className="topbar-actions">
              {isSample && <span className="sample-badge" aria-label={desktopAvailable ? "Sample workspace" : "Interactive browser sample"} title={desktopAvailable ? "Sample workspace" : "Interactive browser sample, not local files"}><span /> Sample</span>}
              <button className="icon-button top-search-button" type="button" onClick={focusSearch} aria-label="Search notes" title={`Search (${modifier}+K)`}><Search size={18} /></button>
              <button className="capture-icon" type="button" onClick={openCapture} aria-label="Quick capture" title={`Quick capture (${modifier}+Shift+K)`}><Plus size={18} /></button>
            </div>
          </header>

          <div ref={workspaceScrollRef} className="workspace-scroll without-cover" data-drop-folder={workspaceDestination} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropToFolder(event, workspaceDestination)} onContextMenu={(event) => { if (event.target === event.currentTarget) openNewMenu(event, workspaceDestination); }}>
            {workspaceView === "settings" ? <SettingsPage settings={settings} persisted={settingsPersisted} isSample={isSample} modifier={modifier} onChange={updateSettings} onBack={() => setWorkspaceView(previousWorkspaceView.current)} onOpenVault={() => void openVault()} /> : workspaceView === "note" && selectedPath ? <section className="note-card" aria-label={`File: ${selectedName}`}>
              <div className="document-header">
                <div className="document-heading">
                  <div className="document-icon"><FileText size={20} /></div>
                  <div className="document-heading-copy"><span>{isMarkdown(selectedPath) ? "YOUR NOTE" : "YOUR FILE"}</span><h2 title={selectedName}>{isMarkdown(selectedPath) ? noteTitle(selectedName) : selectedName}</h2></div>
                </div>
                <div className="document-actions">
                  <div className={`save-indicator ${saveState}`} role="status">{saveState === "error" ? <AlertCircle size={15} /> : saveState === "saving" ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}<span>{saveLabel}</span>{saveState === "error" && <button type="button" onClick={() => void flushAll().catch(() => setNotice("Still couldn't save. Please check the folder and try again."))}>Retry</button>}</div>
                  {isMarkdown(selectedPath) && <div className="view-tabs" role="tablist" aria-label="Note view">
                    {(["write", "source", "read"] as const).map((mode) => <button key={mode} role="tab" type="button" aria-selected={viewMode === mode} disabled={loading} className={viewMode === mode ? "active" : ""} onClick={() => changeMode(mode)}>{mode === "source" ? "Markdown" : mode === "write" ? "Write" : "Read"}</button>)}
                  </div>}
                  <button className={`icon-button doc-action ${itemMeta(metadata, selectedPath).pinned ? "active" : ""}`} type="button" aria-label={itemMeta(metadata, selectedPath).pinned ? "Unpin file" : "Pin file"} aria-pressed={itemMeta(metadata, selectedPath).pinned} title="Pin file" onClick={() => toggleProperty(selectedPath, "pinned")}><Pin size={17} /></button>
                  <button className={`icon-button doc-action ${itemMeta(metadata, selectedPath).favorite ? "active" : ""}`} type="button" aria-label={itemMeta(metadata, selectedPath).favorite ? "Remove from favorites" : "Add to favorites"} aria-pressed={itemMeta(metadata, selectedPath).favorite} title="Favorite" onClick={() => toggleProperty(selectedPath, "favorite")}><Star size={17} /></button>
                  <button className="icon-button doc-action" type="button" aria-label="Edit file tags" title="Tags" onClick={() => openTags(selectedPath)}><Tag size={17} /></button>
                  <button className="icon-button focus-button" type="button" onClick={toggleFocus} aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"} title={focusMode ? "Exit focus mode" : "Focus mode"}>{focusMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
                  <button className="icon-button document-more" type="button" aria-label={`More options for ${selectedName}`} title="Note options" onClick={(event) => handleTreeContext(event, { name: selectedName, path: selectedPath, kind: "file", children: [] })}><MoreHorizontal size={19} /></button>
                </div>
              </div>
              <div className="format-toolbar" aria-label="Formatting toolbar">
                {viewMode === "write" && isMarkdown(selectedPath) ? <>
                  <label className="toolbar-select" title="Paragraph style"><span className="sr-only">Paragraph style</span><select aria-label="Paragraph style" value={formatting?.headingLevel ?? 0} onChange={(event) => { const level = Number(event.target.value); if (!level) editor?.chain().focus().setParagraph().run(); else editor?.chain().focus().setHeading({ level: level as 1 | 2 | 3 }).run(); }}><option value="0">Text</option><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option></select></label>
                  <label className="toolbar-select size-select" title="Text size"><span className="sr-only">Text size</span><select aria-label="Text size" value={formatting?.fontSize ?? ""} onChange={(event) => event.target.value ? editor?.chain().focus().setFontSize(event.target.value).run() : editor?.chain().focus().unsetFontSize().run()}><option value="">Size</option>{[12, 14, 16, 18, 20, 24, 32, 40, 48].map((size) => <option key={size} value={`${size}px`}>{size}px</option>)}</select></label>
                  <span className="format-divider" />
                  <ToolButton label="Bold" icon={Bold} active={formatting?.bold} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleBold().run()} />
                  <ToolButton label="Italic" icon={Italic} active={formatting?.italic} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleItalic().run()} />
                  <ToolButton label="Underline" icon={Underline} active={formatting?.underline} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleUnderline().run()} />
                  <ToolButton label="Strikethrough" icon={Strikethrough} active={formatting?.strike} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleStrike().run()} />
                  <ToolButton label="Highlight" icon={Highlighter} active={formatting?.highlight} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleHighlight().run()} />
                  <label className="toolbar-color" title="Text color"><span>A</span><input type="color" aria-label="Text color" value={/^#[0-9a-f]{6}$/i.test(formatting?.textColor || "") ? formatting!.textColor : "#e6a17f"} onChange={(event) => editor?.chain().focus().setColor(event.target.value).run()} /></label>
                  <ToolButton label="Add link" icon={Link2} active={formatting?.link} disabled={!editor || loading} onClick={openLink} />
                  <span className="format-divider" />
                  <ToolButton label="Bullet list" icon={List} active={formatting?.bulletList} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleBulletList().run()} />
                  <ToolButton label="Numbered list" icon={ListOrdered} active={formatting?.orderedList} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleOrderedList().run()} />
                  <ToolButton label="Task list" icon={ListChecks} active={formatting?.taskList} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleTaskList().run()} />
                  <ToolButton label="Quote" icon={Quote} active={formatting?.quote} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleBlockquote().run()} />
                  <ToolButton label="Inline code" icon={Code2} disabled={!editor || loading} onClick={() => editor?.chain().focus().toggleCode().run()} />
                  <span className="format-divider" />
                  <ToolButton label="Undo" icon={Undo2} disabled={!formatting?.undo || loading} onClick={() => editor?.chain().focus().undo().run()} />
                  <ToolButton label="Redo" icon={Redo2} disabled={!formatting?.redo || loading} onClick={() => editor?.chain().focus().redo().run()} />
                </> : <span className="mode-hint">{viewMode === "source" ? <><FileCode2 size={15} /> Editing the {isMarkdown(selectedPath) ? "plain Markdown" : "UTF-8 text"} file</> : <><BookOpen size={15} /> Reading view · select Write to make changes</>}</span>}
              </div>
              <div className="document-body">
                {loading ? <div className="document-loading"><LoaderCircle size={18} className="spin" /> Opening your note…</div> : viewMode === "source" ? <textarea ref={sourceRef} className="source-editor" aria-label={isMarkdown(selectedPath) ? "Markdown source" : "Text editor"} spellCheck={settings.spellcheck} value={content} placeholder={isMarkdown(selectedPath) ? "Start writing in Markdown…" : "Start writing…"} onChange={(event) => {
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
              {isMarkdown(selectedPath) && <YouTubeEmbeds key={selectedPath} markdown={content} />}
              <div className="document-footer"><div><span>{words} {words === 1 ? "word" : "words"}</span><span className="footer-dot" /> <span>{isMarkdown(selectedPath) ? "Markdown" : "Plain text"}</span></div><span>{isSample ? (sampleVault.isPersisted() ? (desktopAvailable ? "Sample saved in this app" : "Sample saved in this browser") : "Temporary sample") : "Saved locally"}</span></div>
            </section> : workspaceView === "file" && selectedPath ? <div className="media-workspace">
              <div className="media-top-actions"><button className={`icon-button ${itemMeta(metadata, selectedPath).pinned ? "active" : ""}`} type="button" aria-label={itemMeta(metadata, selectedPath).pinned ? "Unpin file" : "Pin file"} onClick={() => toggleProperty(selectedPath, "pinned")}><Pin size={17} /></button><button className={`icon-button ${itemMeta(metadata, selectedPath).favorite ? "active" : ""}`} type="button" aria-label={itemMeta(metadata, selectedPath).favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => toggleProperty(selectedPath, "favorite")}><Star size={17} /></button><button className="icon-button" type="button" aria-label="Edit file tags" onClick={() => openTags(selectedPath)}><Tag size={17} /></button><button className="icon-button" type="button" aria-label={`More options for ${selectedName}`} onClick={(event) => handleTreeContext(event, { name: selectedName, path: selectedPath, kind: "file", children: [] })}><MoreHorizontal size={19} /></button></div>
              <MediaView key={selectedPath} path={selectedPath} url={mediaUrl} sample={isSample} onOpenExternal={() => void openExternal()} onEditAsText={() => void openUnknownAsText()} />
            </div> : <>
              {workspaceView === "folder" && <button className="folder-parent workspace-parent" type="button" onClick={() => folderParentIsRoot ? void showOverview("all") : void showFolder(folderParent)}><ArrowRight size={14} /> {folderParentIsRoot ? "All files" : fileName(folderParent)}</button>}
              <WorkspacePanel title={workspaceView === "folder" ? fileName(folderPath) : workspaceView === "pinned" ? "Pinned" : workspaceView === "favorites" ? "Favorites" : "All files"} description={workspaceView === "folder" ? "Everything in this folder, together." : workspaceView === "pinned" ? "The things you want close at hand." : workspaceView === "favorites" ? "A little collection of your favorites." : "All your files and folders, in one place."} entries={workspaceEntries} vault={vaultPath} destination={workspaceDestination} metadata={metadata} layout={layout} iconSize={iconSize} onLayout={setLayout} onIconSize={setIconSize} onOpen={openEntry} onMenu={entryContext} onBackgroundMenu={openNewMenu} onCreate={openNewMenu} onDragStart={dragStart} onDrop={dropToFolder} />
            </>}
          </div>
        </main>
      </div>

      {notice && <div className="toast" role="status"><AlertCircle size={17} /> <span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={16} /></button></div>}

      {contextMenu && <div className="context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
        <div className="context-heading" title={contextMenu.node?.name ?? contextMenu.folder}>{contextMenu.node?.name ?? `Add to ${contextMenu.folder === vaultPath ? "workspace" : fileName(contextMenu.folder)}`}</div>
        <button role="menuitem" type="button" onClick={() => openCreate("note", contextMenu.folder)}><FilePlus2 size={16} /> New file</button>
        <button role="menuitem" type="button" onClick={() => openCreate("folder", contextMenu.folder)}><FolderPlus size={16} /> New folder</button>
        <button role="menuitem" type="button" onClick={() => void upload(contextMenu.folder)}><Upload size={16} /> Upload files</button>
        {contextMenu.node && <>
          <div className="context-divider" />
          <button role="menuitem" type="button" onClick={() => toggleProperty(contextMenu.node!.path, "pinned")}><Pin size={16} /> {itemMeta(metadata, contextMenu.node.path).pinned ? "Unpin" : "Pin"}</button>
          <button role="menuitem" type="button" onClick={() => toggleProperty(contextMenu.node!.path, "favorite")}><Star size={16} /> {itemMeta(metadata, contextMenu.node.path).favorite ? "Remove favorite" : "Add favorite"}</button>
          <button role="menuitem" type="button" onClick={() => openTags(contextMenu.node!.path)}><Tag size={16} /> Edit tags</button>
          <button role="menuitem" type="button" onClick={() => { setMoveDialog(contextMenu.node!); setMoveFolder(vaultPath); setContextMenu(null); }}><FolderOpen size={16} /> Move to…</button>
          <button role="menuitem" type="button" onClick={() => openRename(contextMenu.node!)}><Pencil size={16} /> Rename</button>
          <button role="menuitem" type="button" className="danger" onClick={() => openDelete(contextMenu.node!)}><Trash2 size={16} /> Delete</button>
        </>}
      </div>}

      {searchOpen && <SearchDialog query={searchQuery} results={searchResults} searching={searching} entries={entries} tags={metadata.tags} onQuery={setSearchQuery} onOpen={(entry) => { setSearchOpen(false); openEntry(entry); }} onClose={() => setSearchOpen(false)} />}
      {tagDialogOpen && <TagDialog metadata={metadata} target={tagTarget} onClose={() => setTagDialogOpen(false)} onCreate={createTag} onToggle={toggleTag} onDelete={deleteTag} onSearch={(name) => { setTagDialogOpen(false); setSearchQuery(`#${name}`); setSearchOpen(true); }} />}
      {moveDialog && <div className="modal-backdrop" onMouseDown={() => setMoveDialog(null)}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="move-title" onSubmit={(event) => { event.preventDefault(); void moveItem(moveDialog.path, moveFolder); }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><FolderOpen size={20} /></div><button className="modal-close icon-button" type="button" aria-label="Close move dialog" onClick={() => setMoveDialog(null)}><X size={18} /></button>
        <h2 id="move-title">Move {moveDialog.name}</h2><p>Choose a destination. Existing files won't be overwritten; links in other notes won't be updated.</p>
        <label className="modal-label" htmlFor="move-folder">Destination</label><select id="move-folder" value={moveFolder} onChange={(event) => setMoveFolder(event.target.value)}><option value={vaultPath}>Comet (workspace)</option>{entries.filter((entry) => entry.kind === "folder" && !isPathInside(entry.path, moveDialog.path)).map((folder) => <option key={folder.path} value={folder.path}>{displayWorkspacePath(folder.path, vaultPath)}</option>)}</select>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setMoveDialog(null)}>Cancel</button><button className="primary-button" type="submit">Move</button></div>
      </form></div>}
      <input ref={uploadInputRef} type="file" multiple hidden onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void importBrowserFiles(files, uploadFolder); }} />

      {pathCreateDialog && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setPathCreateDialog(null)}>
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="path-create-title" onSubmit={(event) => void confirmPathCreate(event)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon"><FilePlus2 size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setPathCreateDialog(null)} aria-label="Close dialog" disabled={dialogBusy}><X size={18} /></button>
          <h2 id="path-create-title">Create this file?</h2><p>We'll create a file at this path. Names without an extension use .md; existing files are never overwritten.</p>
          <div className="path-create-location"><FileText size={16} /><span>{displayWorkspacePath(pathCreateDialog.path, pathCreateDialog.vault)}</span></div>
          {pathCreateDialog.missingFolders.length > 0 && <p className="path-create-folders"><FolderPlus size={15} /> {pathCreateDialog.missingFolders.length === 1 ? "1 new folder will be created" : `${pathCreateDialog.missingFolders.length} new folders will be created`} along the way.</p>}
          {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" autoFocus onClick={() => setPathCreateDialog(null)} disabled={dialogBusy}>Cancel</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "Creating…" : "Create file"}</button></div>
        </form>
      </div>}

      {createDialog && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setCreateDialog(null)}>
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onSubmit={(event) => void submitCreate(event)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon"><FilePlus2 size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setCreateDialog(null)} aria-label="Close dialog" disabled={dialogBusy}><X size={18} /></button>
          <h2 id="create-title">New {createDialog.kind === "note" ? "file" : "folder"}</h2>
          <p>Give your {createDialog.kind === "note" ? "file" : "folder"} a name. It will be saved in <strong>{createDialog.folder === vaultPath ? vaultName : relativePath(createDialog.folder, vaultPath)}</strong>.</p>
          <label className="modal-label" htmlFor="entry-name">{createDialog.kind === "note" ? "File name" : "Folder name"}</label>
          <input id="entry-name" autoFocus value={entryName} onChange={(event) => { setEntryName(event.target.value); setDialogError(""); }} placeholder={createDialog.kind === "note" ? "e.g. ideas.md or list.txt" : "Give your folder a name"} autoComplete="off" />
          {createDialog.kind === "note" && <span className="input-hint">Use any extension. Names without one are saved as .md.</span>}
          {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCreateDialog(null)} disabled={dialogBusy}>Cancel</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "Creating…" : `Create ${createDialog.kind === "note" ? "file" : "folder"}`}</button></div>
        </form>
      </div>}

      {renameNode && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setRenameNode(null)}>
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="rename-title" onSubmit={(event) => void submitRename(event)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon"><Pencil size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setRenameNode(null)} aria-label="Close dialog" disabled={dialogBusy}><X size={18} /></button>
          <h2 id="rename-title">Rename {renameNode.kind === "folder" ? "folder" : "file"}</h2><p>Choose a new name for <strong>{renameNode.name}</strong>. Links in other notes won't be updated automatically.</p>
          <label className="modal-label" htmlFor="rename-name">Name</label><input id="rename-name" autoFocus value={entryName} onChange={(event) => { setEntryName(event.target.value); setDialogError(""); }} autoComplete="off" />
          {renameNode.kind === "file" && <span className="input-hint">Include the extension you want to keep.</span>}
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
          <label className="modal-label" htmlFor="capture-destination">Save to path</label><select id="capture-destination" value={captureFolder} onChange={(event) => setCaptureFolder(event.target.value)}><option value={vaultPath}>Comet (workspace)</option>{entries.filter((entry) => entry.kind === "folder").map((folder) => <option key={folder.path} value={folder.path}>{displayWorkspacePath(folder.path, vaultPath)}</option>)}</select>
          <span className="input-hint">Saved as a new Markdown file in the selected folder{captureType === "image" && isSample ? ". Image capture requires a local folder." : "."}</span>
          {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCaptureOpen(false)} disabled={dialogBusy}>Cancel</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "Saving…" : "Save capture"}</button></div>
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
  metadata: WorkspaceMeta;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onContext: (event: MouseEvent, node: TreeNode) => void;
  onDragStart: (event: DragEvent, entry: Entry) => void;
  onDrop: (event: DragEvent, node: TreeNode) => void;
}

const TreeNodeView = memo(function TreeBranch({ node, depth, selectedPath, expanded, metadata, onToggle, onSelect, onOpenFolder, onContext, onDragStart, onDrop }: TreeNodeViewProps) {
  const folder = node.kind === "folder";
  const openFolder = expanded.has(node.path);
  const selected = node.path === selectedPath;
  const meta = itemMeta(metadata, node.path);
  return <div className="tree-branch">
    <div className={selected ? "tree-row selected" : "tree-row"} style={{ paddingLeft: `${8 + depth * 14}px` }} draggable data-drop-folder={folder ? node.path : undefined} onDragStart={(event) => { event.stopPropagation(); onDragStart(event, node); }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => onDrop(event, node)} onContextMenu={(event) => onContext(event, node)}>
      {folder ? <button type="button" className="tree-disclosure" aria-label={`${openFolder ? "Collapse" : "Expand"} ${node.name}`} aria-expanded={openFolder} onClick={() => onToggle(node.path)}>{openFolder ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="tree-disclosure" aria-hidden="true" />}
      <button type="button" className="tree-item" onClick={() => folder ? onOpenFolder(node.path) : onSelect(node.path)} aria-current={selected ? "page" : undefined} title={node.name}>
        {folder ? (openFolder ? <FolderOpen className="tree-icon folder" size={16} /> : <Folder className="tree-icon folder" size={16} />) : <FileText className="tree-icon" size={16} />}
        <span className="tree-name">{!folder && isMarkdown(node.name) ? noteTitle(node.name) : node.name}</span>{meta.pinned && <Pin size={11} className="tree-badge" />}{meta.favorite && <Star size={11} className="tree-badge" />}
      </button>
      <button type="button" className="tree-action" aria-label={`More options for ${node.name}`} title={`More options for ${node.name}`} onClick={(event) => onContext(event, node)}><MoreHorizontal size={16} /></button>
    </div>
    {folder && openFolder && node.children.map((child) => <TreeNodeView key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} expanded={expanded} metadata={metadata} onToggle={onToggle} onSelect={onSelect} onOpenFolder={onOpenFolder} onContext={onContext} onDragStart={onDragStart} onDrop={onDrop} />)}
  </div>;
});

export default App;
