import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type MouseEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  AlertCircle, ArrowLeft, ArrowRight, Bold, BookOpen, CalendarDays, CheckCircle2,
  ChevronDown, ChevronRight, Code2, FileCode2, FilePlus2, FileText,
  FolderOpen, FolderPlus, GitBranch, GripVertical, Network, Image as ImageIcon, Italic, KeyRound, Link2, List,
  ListChecks, LoaderCircle, Maximize2, Minimize2,
  MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Quote, Redo2,
  Search, Settings2, Sparkles, Square, Star, Pin, Tag, Upload, Underline, Strikethrough, Highlighter, ListOrdered, Trash2, Undo2, X, type LucideIcon,
} from "lucide-react";
import type { EditorProps } from "@tiptap/pm/view";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { APP_VERSION } from "virtual:comet-version";
import { checkUpdates, type UpdateInfo } from "./utils/updates";
import { TodoBoard } from "./TodoBoard";
import { Whiteboard } from "./Whiteboard";
import { newWhiteboard, parseWhiteboard, serializeWhiteboard, type WhiteboardDocument } from "./utils/whiteboard";
import { CalendarView } from "./CalendarView";
import { PasswordsView } from "./PasswordsView";
import { parseTodo, newTodoDocument, serializeTodo, type TodoDocument } from "./utils/todo";
import { editableTextError } from "./utils/textSafety";
import { BrainExplore, TreeExplore } from "./ExploreViews";
import { ColorMenu } from "./ColorMenu";
import { SettingsPage } from "./SettingsPage";
import { WorkspacePanel, type WorkspaceLayout } from "./WorkspacePanel";
import { FileIcon } from "./FileIcon";
import { MovePicker } from "./MovePicker";
import { MediaView } from "./MediaView";
import { VideoEmbeds } from "./utils/videoEmbeds";
import { SearchDialog } from "./SearchDialog";
import { TagDialog } from "./TagDialog";
import { fileKind, isTextFile } from "./utils/fileTypes";
import { firstDroppedUrl, serializeShortcut } from "./utils/links";
import { richTextExtensions } from "./utils/richText";
import { itemMeta, readWorkspaceMeta, saveWorkspaceMeta, updateItem, renameMeta, removeMeta, reorderChildren, type WorkspaceMeta } from "./utils/workspaceMeta";
import { identityFor, readWorkspaceIdentities, saveWorkspaceIdentities } from "./utils/workspaceIdentity";
import { readVaultList, reorderVaults, saveVaultList, vaultLabel } from "./utils/vaultList";
import { countWords } from "./utils/markdown";
import { displayWorkspacePath, planWorkspacePath, type PathPlan } from "./utils/pathNavigation";
import { selectRange, selectionRoots } from "./utils/selection";
import { keyboardShortcut, shortcutLabel } from "./utils/shortcuts";
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
type WorkspaceView = "note" | "file" | "todo" | "whiteboard" | "all" | "folder" | "pinned" | "favorites" | "tree" | "brain" | "calendar" | "passwords" | "settings";
type NavigationPoint = { vault: string; view: WorkspaceView; path: string };
type NavigationHistory = { items: NavigationPoint[]; index: number };
type CaptureType = "text" | "link" | "image";
type CreateDialog = { kind: "note" | "folder" | "todo" | "whiteboard"; folder: string };
type PathCreateDialog = Extract<PathPlan, { kind: "create" }> & { vault: string };
type DropIndicator = { path: string; position: "before" | "after" | "into"; surface: "sidebar" | "workspace" | "map"; source?: string };
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
  const specialText = path && ["link", "todo", "whiteboard"].includes(fileKind(path)) && !isSampleDataUrl(raw) && !raw.includes("\0");
  const view: WorkspaceView = path ? (fileKind(path) === "todo" && specialText && parseTodo(raw) ? "todo" : fileKind(path) === "whiteboard" && specialText && parseWhiteboard(raw) ? "whiteboard" : editable ? "note" : "file") : "all";
  return { entries, path, editable, view, content: editable || specialText ? raw : "", mediaUrl: isSampleDataUrl(raw) ? raw : "" };
}

function isSampleDataUrl(value: string): boolean { return /^data:[^,\s]*;base64,/i.test(value); }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [settings, setSettings] = useState(readSettings);
  const [settingsPersisted, setSettingsPersisted] = useState(true);
  const [settingsSection, setSettingsSection] = useState<"general" | "updates" | "cloud">("general");
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null);
  const [updateNotice, setUpdateNotice] = useState(false), [updateStatus, setUpdateStatus] = useState("");
  const [trayAvailable, setTrayAvailable] = useState(false);
  const [sampleStart] = useState(initialSample);
  const [lastSession] = useState(() => desktopAvailable && settings.reopenWorkspace ? readSession() : null);
  const [restoring, setRestoring] = useState(Boolean(lastSession));
  const [vaultPath, setVaultPath] = useState(SAMPLE_ROOT);
  const [entries, setEntries] = useState<Entry[]>(sampleStart.entries);
  const [selectedPath, setSelectedPath] = useState(sampleStart.path);
  const [content, setContent] = useState(sampleStart.content);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(sampleStart.view);
  const [folderPath, setFolderPath] = useState("");
  const [history, setHistory] = useState<NavigationHistory>(() => ({ items: [{ vault: SAMPLE_ROOT, view: sampleStart.view, path: sampleStart.path }], index: 0 }));
  const historyRef = useRef(history); historyRef.current = history;
  const navigatingHistory = useRef(false);
  const [mediaUrl, setMediaUrl] = useState(sampleStart.mediaUrl);
  const [layout, setLayout] = useState<WorkspaceLayout>(() => { try { return localStorage.getItem("comet:workspace-layout") === "gallery" ? "gallery" : "list"; } catch { return "list"; } });
  const [iconSize, setIconSize] = useState(() => { try { const size = Number(localStorage.getItem("comet:workspace-icon-size")); return size >= 24 && size <= 72 ? size : 32; } catch { return 32; } });
  const [metadata, setMetadata] = useState<WorkspaceMeta>(() => readWorkspaceMeta(SAMPLE_ROOT));
  const [vaults, setVaults] = useState(readVaultList);
  const [identities, setIdentities] = useState(readWorkspaceIdentities);
  const [workspaceCustomize, setWorkspaceCustomize] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [workspaceIconDraft, setWorkspaceIconDraft] = useState("");
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);
  const [vaultDrop, setVaultDrop] = useState<{ path: string; after: boolean } | null>(null);
  const vaultDropRef = useRef<{ path: string; after: boolean } | null>(null);
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
  const [bulkDelete, setBulkDelete] = useState<Entry[] | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const selectionAnchor = useRef("");
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
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const dropIndicatorRef = useRef<DropIndicator | null>(null);
  const dragSourceRef = useRef("");
  const showDropIndicator = (value: DropIndicator | null) => { dropIndicatorRef.current = value; setDropIndicator(value); };
  const dropGroup = dropIndicator?.position === "into" ? dropIndicator.path
    : dropIndicator?.source && normalizePath(parentPath(dropIndicator.source)) !== normalizePath(parentPath(dropIndicator.path)) ? parentPath(dropIndicator.path) : "";

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
    saveQueue.current = new SaveQueue((path, value) => writeNote(vaultRef.current, path, value), setSaveState, (error) => setNotice(`Couldn't save (${errorMessage(error)}). Your changes are still here; use Retry to try again.`));
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
  const vaultFallback = isSample ? "Sample workspace" : fileName(vaultPath);
  const workspaceIdentity = identityFor(identities, vaultPath, vaultFallback);
  const vaultName = workspaceIdentity.name;
  const selectedName = selectedPath ? fileName(selectedPath) : "";
  const modifier = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘" : "Ctrl";
  const currentLocation = workspaceView === "note" || workspaceView === "file" || workspaceView === "todo" || workspaceView === "whiteboard" ? selectedPath : workspaceView === "folder" ? folderPath : vaultPath;
  const displayedPath = displayWorkspacePath(currentLocation, vaultPath);
  const pathPlan = useMemo(() => planWorkspacePath(pathDraft, vaultPath, entries), [pathDraft, vaultPath, entries]);
  const folderEntries = useMemo(() => orderItems(entries.filter((entry) => parentPath(entry.path) === folderPath), folderPath), [entries, folderPath, orderItems]);
  const folderParent = parentPath(folderPath);
  const folderParentIsRoot = normalizePath(folderParent) === normalizePath(vaultPath);
  const workspaceDestination = workspaceView === "folder" ? folderPath : (workspaceView === "note" || workspaceView === "file" || workspaceView === "todo" || workspaceView === "whiteboard") && selectedPath ? parentPath(selectedPath) || vaultPath : vaultPath;
  const workspaceEntries = workspaceView === "folder" ? folderEntries : workspaceView === "pinned" ? entries.filter((entry) => itemMeta(metadata, entry.path).pinned) : workspaceView === "favorites" ? entries.filter((entry) => itemMeta(metadata, entry.path).favorite) : orderItems(entries, vaultPath);

  useEffect(() => {
    if (!desktopAvailable) return;
    const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 12_000);
    void checkUpdates(APP_VERSION, controller.signal).then((result) => { if (result && !controller.signal.aborted) { setAvailableUpdate(result); setUpdateNotice(true); } }).catch(() => undefined).finally(() => window.clearTimeout(timer));
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, []);

  useEffect(() => { const next = new Set<string>(); selectionRef.current = next; setSelection(next); selectionAnchor.current = ""; }, [vaultPath]);
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
  const resetNavigation = useCallback((point: NavigationPoint) => {
    const next = { items: [point], index: 0 }; historyRef.current = next; setHistory(next);
  }, []);
  const recordNavigation = useCallback((view: WorkspaceView, path = "") => {
    const point = { vault: vaultRef.current, view, path };
    const current = historyRef.current;
    const at = current.items[current.index];
    if (at && at.vault === point.vault && at.view === point.view && at.path === point.path) return;
    const items = [...current.items.slice(0, current.index + 1), point].slice(-100);
    const next = { items, index: items.length - 1 }; historyRef.current = next; setHistory(next);
  }, []);
  const remapNavigation = useCallback((from: string, to: string) => {
    const current = historyRef.current;
    const next = { ...current, items: current.items.map((point) => point.vault === vaultRef.current && point.path ? { ...point, path: remapPath(point.path, from, to) } : point) };
    historyRef.current = next; setHistory(next);
  }, []);
  const rememberVault = useCallback((path: string) => {
    setVaults((previous) => {
      if (previous.includes(path)) return previous;
      // Keep the new workspace visible even when the remembered list is full.
      const next = [...previous.slice(0, 20), path];
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
    document.documentElement.style.setProperty("--interface-text-scale", String(settings.textScale * 1.2 / 100));
    document.documentElement.style.zoom = String(settings.interfaceScale / 100);
    return () => { document.documentElement.style.removeProperty("--interface-text-scale"); document.documentElement.style.removeProperty("zoom"); };
  }, [settings.textScale, settings.interfaceScale]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = settings.theme === "system" ? (!media || media.matches ? "dark" : "light") : settings.theme === "light" ? "light" : "dark";
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.palette = ["emerald", "rubellite", "navy"].includes(settings.theme) ? settings.theme : "";
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
    VideoEmbeds,
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

  const selectNote = useCallback(async (path: string, record = true): Promise<boolean> => {
    if (!isPathInside(path, vaultRef.current) || normalizePath(path) === normalizePath(vaultRef.current)) {
      setNotice("Choose a file inside the current workspace.");
      return false;
    }
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return false;
      loadingRef.current = true;
      setLoading(true);
      const text = isTextFile(path);
      const specialText = ["link", "todo", "whiteboard"].includes(fileKind(path));
      const next = text || specialText ? await readNote(vaultRef.current, path) : "";
      if ((text || specialText) && ((isSamplePath(vaultRef.current) && isSampleDataUrl(next)) || next.includes("\0"))) throw new Error("This file contains binary data, not editable text.");
      const asset = text || specialText ? "" : isSamplePath(vaultRef.current) ? sampleVault.read(path) : convertFileSrc(path);
      if (request !== loadRequest.current) return false;
      const previousWasMarkdown = isMarkdown(selectedRef.current);
      selectedRef.current = path;
      contentRef.current = next;
      setSelectedPath(path);
      setContent(next);
      setMediaUrl(asset);
      const nextView: WorkspaceView = fileKind(path) === "todo" && parseTodo(next) ? "todo" : fileKind(path) === "whiteboard" && parseWhiteboard(next) ? "whiteboard" : text ? "note" : "file";
      setWorkspaceView(nextView);
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
      if (record) recordNavigation(nextView, path);
      if (window.innerWidth <= 760) setExplorerOpen(false);
      return true;
    } catch (error) {
      if (request === loadRequest.current) setNotice(`Couldn't open file: ${errorMessage(error)}`);
      return false;
    } finally {
      if (request === loadRequest.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [expandParents, flushAll, persistSession, recordNavigation]);
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
        if (nextPath && (isTextFile(nextPath) || ["link", "todo", "whiteboard"].includes(fileKind(nextPath)))) {
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
        setMediaUrl(nextPath && !isTextFile(nextPath) && !["link", "todo", "whiteboard"].includes(fileKind(nextPath)) ? convertFileSrc(nextPath) : "");
        const restoredView: WorkspaceView = nextPath ? (fileKind(nextPath) === "todo" && parseTodo(nextContent) ? "todo" : fileKind(nextPath) === "whiteboard" && parseWhiteboard(nextContent) ? "whiteboard" : isTextFile(nextPath) ? "note" : "file") : "all";
        setWorkspaceView(restoredView);
        modeRef.current = nextPath && !isMarkdown(nextPath) ? "source" : "write";
        setViewMode(modeRef.current);
        setExpanded(new Set());
        if (nextPath) expandParents(nextPath, lastSession.vault);
        loadMarkdownNote(editorRef.current, isMarkdown(nextPath) ? nextContent : "");
        persistSession(lastSession.vault, nextPath);
        // Reopening the active session should not undo a deliberate removal
        // of that workspace from the switcher.
        resetNavigation({ vault: lastSession.vault, view: restoredView, path: nextPath });
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
  }, [lastSession, expandParents, persistSession, resetNavigation]);

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
      resetNavigation({ vault: path, view: "all", path: "" });
      setNotice("Workspace opened.");
    } catch (error) {
      if (request === loadRequest.current) setNotice(`Couldn't open workspace: ${errorMessage(error)}`);
    } finally {
      if (request === loadRequest.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [flushAll, persistSession, rememberVault, resetNavigation]);

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
      setWorkspaceView(sample.view);
      loadMarkdownNote(editorRef.current, isMarkdown(sample.path) ? sample.content : "");
      resetNavigation({ vault: SAMPLE_ROOT, view: sample.view, path: sample.path });
      rememberVault(SAMPLE_ROOT);
    } catch (error) { setNotice(`Couldn't switch workspace: ${errorMessage(error)}`); }
  }, [flushAll, rememberVault, resetNavigation]);

  const openCreate = useCallback((kind: "note" | "folder" | "todo" | "whiteboard", folder: string) => {
    setEntryName("");
    setDialogError("");
    setDialogBusy(false);
    setCreateDialog({ kind, folder });
    setContextMenu(null);
  }, []);

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!createDialog || dialogBusy) return;
    const extension = createDialog.kind === "todo" ? ".comet-todo" : createDialog.kind === "whiteboard" ? ".comet-whiteboard" : "";
    const proposed = extension && entryName.trim() && !entryName.trim().toLowerCase().endsWith(extension) ? `${entryName.trim()}${extension}` : entryName;
    const { name, error } = validEntryName(proposed, createDialog.kind === "todo" || createDialog.kind === "whiteboard" ? "file" : createDialog.kind);
    if (error) {
      setDialogError(error);
      return;
    }
    const path = joinPath(createDialog.folder, name);
    setDialogBusy(true);
    setDialogError("");
    try {
      if (createDialog.kind === "note") await createNote(vaultRef.current, path, fileKind(path) === "todo" ? serializeTodo(newTodoDocument()) : fileKind(path) === "whiteboard" ? serializeWhiteboard(newWhiteboard()) : "");
      else if (createDialog.kind === "todo") await createNote(vaultRef.current, path, serializeTodo(newTodoDocument()));
      else if (createDialog.kind === "whiteboard") await createNote(vaultRef.current, path, serializeWhiteboard(newWhiteboard()));
      else await createFolder(vaultRef.current, path);
      await refresh(vaultRef.current);
      setExpanded((previous) => new Set([...previous, createDialog.folder, ...(createDialog.kind === "folder" ? [path] : [])]));
      setCreateDialog(null);
      if (createDialog.kind !== "folder") {
        if (createDialog.kind === "note") changeMode("write");
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

  const showOverview = useCallback(async (view: "all" | "pinned" | "favorites" | "tree" | "brain" | "calendar" | "passwords", record = true): Promise<boolean> => {
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return false;
      loadingRef.current = false;
      setLoading(false);
      setWorkspaceView(view);
      if (record) recordNavigation(view);
      setSearchQuery("");
      if (window.innerWidth <= 760) setExplorerOpen(false);
      return true;
    } catch {
      if (request === loadRequest.current) {
        loadingRef.current = false;
        setLoading(false);
        setNotice("Couldn't save this note. Retry the save before leaving it.");
      }
      return false;
    }
  }, [flushAll, recordNavigation]);

  const showFolder = useCallback(async (path: string, record = true): Promise<boolean> => {
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return false;
      loadingRef.current = false;
      setLoading(false);
      setFolderPath(path);
      setWorkspaceView("folder");
      if (record) recordNavigation("folder", path);
      setExpanded((previous) => new Set([...previous, path]));
      expandParents(path, vaultRef.current);
      setSearchQuery("");
      if (window.innerWidth <= 760) setExplorerOpen(false);
      return true;
    } catch {
      if (request === loadRequest.current) {
        loadingRef.current = false;
        setLoading(false);
        setNotice("Couldn't save this note. Retry the save before leaving it.");
      }
      return false;
    }
  }, [expandParents, flushAll, recordNavigation]);

  const showSettings = useCallback(async (record = true): Promise<boolean> => {
    if (workspaceView === "settings") return true;
    const request = ++loadRequest.current;
    try {
      await flushAll();
      if (request !== loadRequest.current) return false;
      loadingRef.current = false;
      setLoading(false);
      previousWorkspaceView.current = workspaceView;
      setWorkspaceView("settings");
      if (record) recordNavigation("settings");
      setContextMenu(null);
      if (window.innerWidth <= 760) setExplorerOpen(false);
      return true;
    } catch {
      if (request === loadRequest.current) {
        loadingRef.current = false;
        setLoading(false);
        setNotice("Couldn't save this note. Retry the save before opening settings.");
      }
      return false;
    }
  }, [flushAll, workspaceView, recordNavigation]);

  const navigateHistory = useCallback(async (direction: -1 | 1) => {
    if (navigatingHistory.current) return;
    const current = historyRef.current;
    let index = current.index + direction;
    while (index >= 0 && index < current.items.length) {
      const point = current.items[index];
      const exists = !["note", "file", "todo", "whiteboard", "folder"].includes(point.view) || entries.some((item) => item.path === point.path && (point.view === "folder" ? item.kind === "folder" : item.kind === "file"));
      if (point.vault === vaultRef.current && exists) break;
      index += direction;
    }
    if (index < 0 || index >= current.items.length) return;
    navigatingHistory.current = true;
    const point = current.items[index];
    try {
      const success = point.view === "note" || point.view === "file" || point.view === "todo" || point.view === "whiteboard" ? await selectNote(point.path, false)
        : point.view === "folder" ? await showFolder(point.path, false)
        : point.view === "settings" ? await showSettings(false)
        : await showOverview(point.view, false);
      if (success && historyRef.current === current) {
        const next = { ...current, index }; historyRef.current = next; setHistory(next);
      }
    } finally { navigatingHistory.current = false; }
  }, [entries, selectNote, showFolder, showOverview, showSettings]);

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
      // Every directory is created exclusively, one at a time, after the
      // previous component was containment-checked by the bridge.
      if (pathCreateDialog.target === "folder") {
        for (const folder of pathCreateDialog.missingFolders) await createFolder(pathCreateDialog.vault, folder);
      } else await createNote(pathCreateDialog.vault, pathCreateDialog.path, fileKind(pathCreateDialog.path) === "todo" ? serializeTodo(newTodoDocument()) : fileKind(pathCreateDialog.path) === "whiteboard" ? serializeWhiteboard(newWhiteboard()) : "");
      try {
        await refresh(pathCreateDialog.vault);
      } catch {
        setNotice("The note was created, but the folder list couldn't refresh.");
      }
      expandParents(pathCreateDialog.path, pathCreateDialog.vault);
      setPathCreateDialog(null);
      if (pathCreateDialog.target === "folder") await showFolder(pathCreateDialog.path);
      else {
        changeMode("write");
        await selectNote(pathCreateDialog.path);
        window.setTimeout(() => editorRef.current?.commands.focus(), 0);
      }
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
        if (workspaceView === "note" || workspaceView === "file" || workspaceView === "todo" || workspaceView === "whiteboard") {
          selectedToReload = nextPath;
          loadingRef.current = true;
          setLoading(true);
        }
        if (isSamplePath(vaultRef.current)) saveSampleSelection(nextPath);
        else persistSession(vaultRef.current, nextPath);
      }
      setFolderPath((previous) => previous ? remapPath(previous, renameNode.path, destination) : previous);
      setSelection((previous) => new Set([...previous].map((path) => remapPath(path, renameNode.path, destination))));
      selectionAnchor.current = remapPath(selectionAnchor.current, renameNode.path, destination);
      remapNavigation(renameNode.path, destination);
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
        recordNavigation("all");
        loadMarkdownNote(editorRef.current, "");
        if (isSamplePath(vaultRef.current)) saveSampleSelection("");
        else persistSession(vaultRef.current, "");
      }
      if (folderPath && isPathInside(folderPath, deleteNode.path)) {
        setFolderPath("");
        if (workspaceView === "folder") { setWorkspaceView("all"); recordNavigation("all"); }
        else if (workspaceView === "settings" && previousWorkspaceView.current === "folder") previousWorkspaceView.current = "all";
      }
      commitMeta((current) => removeMeta(current, deleteNode.path));
      setSelection((previous) => new Set([...previous].filter((path) => !isPathInside(path, deleteNode.path))));
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

  const openBulkDelete = () => {
    const roots = selectionRoots([...selectionRef.current]);
    const selected = roots.map((path) => entries.find((entry) => entry.path === path)).filter((entry): entry is Entry => Boolean(entry));
    if (!selected.length) { setNotice("Select one or more items first."); return; }
    setDialogBusy(false); setDialogError(""); setBulkDelete(selected);
  };
  const confirmBulkDelete = async () => {
    if (!bulkDelete || dialogBusy) return;
    setDialogBusy(true); setDialogError("");
    const vault = vaultRef.current; const removed: Entry[] = []; const failed: { entry: Entry; error: string }[] = [];
    try {
      await flushAll();
      if (vaultRef.current !== vault) throw new Error("The workspace changed. Please select the items again.");
      for (const entry of bulkDelete) {
        try { await deleteEntry(vault, entry.path); removed.push(entry); }
        catch (error) { failed.push({ entry, error: errorMessage(error) }); }
      }
      if (removed.length) {
        const isRemoved = (path: string) => removed.some((entry) => isPathInside(path, entry.path));
        commitMeta((current) => removed.reduce((meta, entry) => removeMeta(meta, entry.path), current));
        const remaining = new Set([...selectionRef.current].filter((path) => !isRemoved(path)));
        selectionRef.current = remaining; setSelection(remaining);
        setExpanded((previous) => new Set([...previous].filter((path) => !isRemoved(path))));
        if (selectedRef.current && isRemoved(selectedRef.current)) {
          selectedRef.current = ""; contentRef.current = ""; setSelectedPath(""); setContent(""); setMediaUrl("");
          setWorkspaceView("all"); loadMarkdownNote(editorRef.current, "");
          if (isSamplePath(vault)) saveSampleSelection(""); else persistSession(vault, "");
          recordNavigation("all");
        }
        if (folderPath && isRemoved(folderPath)) { setFolderPath(""); if (workspaceView === "folder") { setWorkspaceView("all"); recordNavigation("all"); } }
      }
      try { await refresh(vault); } catch { setNotice("Some items were deleted, but the workspace couldn't refresh."); }
      if (failed.length) {
        setBulkDelete(failed.map(({ entry }) => entry));
        setDialogError(`${removed.length} deleted. ${failed.map(({ entry, error }) => `${entry.name}: ${error}`).join(" ")} A folder that failed may have been partially deleted.`);
      } else { setBulkDelete(null); setNotice(`${removed.length} ${removed.length === 1 ? "item" : "items"} permanently deleted.`); }
    } catch (error) { setDialogError(errorMessage(error)); }
    finally { setDialogBusy(false); }
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
        body = serializeShortcut(url.href);
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
      const path = joinPath(captureFolder, `${title} - ${stamp}.${captureType === "link" ? "url" : "md"}`);
      await createNote(vaultRef.current, path, body);
      await refresh(vaultRef.current);
      setExpanded((previous) => new Set([...previous, captureFolder]));
      setCaptureOpen(false);
      if (captureType !== "link") changeMode("write");
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
    const unlisten: Array<() => void> = [];
    const windowHandle = getCurrentWindow();
    // The initially hidden native window is shown only after its handlers are
    // ready. A failed tray or listener setup always falls back to a visible app.
    void (async () => {
      let available = false, handlersReady = false;
      try {
        available = await invoke<boolean>("tray_available").catch(() => false);
        const stopClose = await windowHandle.onCloseRequested(async (event) => {
          const hideToTray = settingsRef.current.closeToTray && available && handlersReady;
          if (hideToTray) event.preventDefault();
          try {
            await flushAll();
            if (hideToTray) await windowHandle.hide();
          } catch {
            event.preventDefault();
            setNotice("Couldn't save your changes or hide the window, so Comet stayed open. Retry before closing.");
          }
        });
        if (!active) { stopClose(); return; }
        unlisten.push(stopClose);
        const stopQuit = await listen("comet-request-quit", async () => {
          try { await flushAll(); await invoke("quit_app"); }
          catch { await windowHandle.show().catch(() => undefined); setNotice("Couldn't save your changes, so Comet stayed open. Retry before quitting."); }
        });
        if (!active) { stopQuit(); return; }
        unlisten.push(stopQuit);
        handlersReady = true;
        setTrayAvailable(available);
      } catch {
        available = false;
        if (active) setTrayAvailable(false);
      } finally {
        if (active && (!available || !handlersReady || !settingsRef.current.startInTray)) await windowHandle.show().catch(() => undefined);
      }
    })();
    return () => { active = false; unlisten.forEach((stop) => stop()); };
  }, [flushAll]);

  const modalOpen = Boolean(bulkDelete || workspaceCustomize || createDialog || pathCreateDialog || renameNode || deleteNode || linkOpen || captureOpen || desktopInfoOpen || searchOpen || tagDialogOpen || moveDialog);
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
    const sideButton = (event: globalThis.MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type === "mousedown" && !modalOpen && !restoring) void navigateHistory(event.button === 3 ? -1 : 1);
    };
    window.addEventListener("mousedown", sideButton, true);
    window.addEventListener("auxclick", sideButton, true);
    return () => { window.removeEventListener("mousedown", sideButton, true); window.removeEventListener("auxclick", sideButton, true); };
  }, [modalOpen, navigateHistory, restoring]);

  const focusSearch = () => { setSearchOpen(true); };

  const toggleFolder = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const visibleTreePaths = useMemo(() => {
    const paths: string[] = [];
    const walk = (nodes: TreeNode[]) => { for (const node of nodes) { paths.push(node.path); if (node.kind === "folder" && expanded.has(node.path)) walk(node.children); } };
    walk(tree); return paths;
  }, [tree, expanded]);
  const clearSelection = () => { const empty = new Set<string>(); selectionRef.current = empty; selectionAnchor.current = ""; setSelection(empty); };
  const activateSelection = (event: MouseEvent, entry: Entry, ordered: string[]) => {
    const next = selectRange(selectionRef.current, selectionAnchor.current, ordered, entry.path, event.ctrlKey || event.metaKey, event.shiftKey);
    selectionRef.current = next.selected; selectionAnchor.current = next.anchor; setSelection(next.selected);
    if (next.open) { if (entry.kind === "folder") void showFolder(entry.path); else void selectNote(entry.path); }
  };
  const handleTreeContext = useCallback((event: MouseEvent, item: TreeNode) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || bounds.right;
    const y = event.clientY || bounds.bottom;
    const scale = Number(document.documentElement.style.zoom) || 1;
    setContextMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 240 * scale)) / scale, y: Math.max(8, Math.min(y, window.innerHeight - 450 * scale)) / scale, node: item, folder: item.kind === "folder" ? item.path : parentPath(item.path) || vaultRef.current });
  }, []);

  const startVaultDrag = (event: React.PointerEvent, source: string) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const pointer = event.pointerId, sx = event.clientX, sy = event.clientY;
    let moving = false;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      if (!moving && Math.hypot(next.clientX - sx, next.clientY - sy) < 4) return;
      moving = true; const row = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>("[data-vault-path]");
      const value = row?.dataset.vaultPath && row.dataset.vaultPath !== source ? { path: row.dataset.vaultPath, after: next.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 } : null;
      vaultDropRef.current = value; setVaultDrop(value);
    };
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel); vaultDropRef.current = null; setVaultDrop(null); };
    const finish = (next: PointerEvent) => { if (next.pointerId !== pointer) return; const target = vaultDropRef.current; cleanup(); if (moving && target) setVaults((previous) => { const reordered = reorderVaults(previous, source, target.path, target.after); saveVaultList(reordered); return reordered; }); };
    const cancel = (next: PointerEvent) => { if (next.pointerId === pointer) cleanup(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", cancel);
  };

  const openNewMenu = (event: MouseEvent, folder: string) => {
    event.preventDefault(); event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || bounds.left, y = event.clientY || bounds.bottom;
    const scale = Number(document.documentElement.style.zoom) || 1;
    setContextMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 240 * scale)) / scale, y: Math.max(8, Math.min(y, window.innerHeight - 225 * scale)) / scale, folder });
  };
  const entryContext = (event: MouseEvent, entry: Entry) => handleTreeContext(event, { ...entry, children: [] });
  const openEntry = (entry: Entry) => { if (entry.kind === "folder") void showFolder(entry.path); else void selectNote(entry.path); };
  const revealPath = async (path: string) => {
    setContextMenu(null);
    const vault = vaultRef.current;
    if (isSamplePath(vault) || !isPathInside(path, vault)) return;
    try {
      if (normalizePath(path) === normalizePath(vault)) await invoke("open_workspace_directory", { path: vault });
      else await invoke("reveal_vault_entry", { vault, path });
    } catch (error) { setNotice(`Couldn't show the path in your file explorer: ${errorMessage(error)}`); }
  };
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
    if (!isPathInside(source, vaultRef.current) || !isPathInside(folder, vaultRef.current)) return null;
    const request = ++loadRequest.current;
    const vault = vaultRef.current;
    try {
      await flushAll();
      if (request !== loadRequest.current || vaultRef.current !== vault) return null;
      const next = await moveEntry(vault, source, folder);
      if (vaultRef.current !== vault) {
        const updated = renameMeta(metaCache.current[vault] ?? readWorkspaceMeta(vault), source, next);
        metaCache.current[vault] = updated;
        saveWorkspaceMeta(vault, updated);
        return null;
      }
      commitMeta((current) => renameMeta(current, source, next));
      setExpanded((previous) => new Set([...previous].map((path) => remapPath(path, source, next))));
      setFolderPath((previous) => remapPath(previous, source, next));
      setSelection((previous) => new Set([...previous].map((path) => remapPath(path, source, next))));
      selectionAnchor.current = remapPath(selectionAnchor.current, source, next);
      remapNavigation(source, next);
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
      return next;
    } catch (error) { setNotice(`Couldn't move: ${errorMessage(error)}`); return null; }
  }, [commitMeta, flushAll, persistSession, refresh, remapNavigation]);

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
    const vault = vaultRef.current;
    if (!isPathInside(folder, vault)) return;
    try { await flushAll(); } catch { setNotice("Couldn't save before importing. Retry the save first."); return; }
    if (vaultRef.current !== vault) return;
    let imported = 0;
    const errors: string[] = [];
    for (const file of files) {
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("Dropped files are limited to 20 MB; use Upload files for larger files.");
        const checked = validEntryName(file.name, "file");
        if (checked.error) throw new Error(checked.error);
        if (isSamplePath(vault)) {
          let value: string;
          if (isTextFile(file.name) || ["link", "todo", "whiteboard"].includes(fileKind(file.name))) {
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
        } else {
          const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
          await invoke("import_dropped_bytes", { vault, path: joinPath(folder, checked.name), bytes });
        }
        imported++;
      } catch (error) { errors.push(`${file.name}: ${errorMessage(error)}`); }
    }
    await refresh(vault);
    if (vaultRef.current === vault) setExpanded((previous) => new Set([...previous, folder]));
    const temporary = isSamplePath(vault) && !sampleVault.isPersisted() ? " Browser storage is full or unavailable; sample changes last only for this session." : "";
    setNotice((errors.length ? `${imported} imported. ${errors.join(" ")}` : `${imported} ${imported === 1 ? "file" : "files"} added.`) + temporary);
  };

  const importLink = async (url: string, folder: string) => {
    const vault = vaultRef.current;
    if (!isPathInside(folder, vault)) return;
    try {
      const body = serializeShortcut(url);
      await flushAll();
      if (vaultRef.current !== vault) return;
      const host = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 55) || "Web link";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
      await createNote(vault, joinPath(folder, `${host} - ${stamp}-${suffix}.url`), body);
      await refresh(vault);
      if (vaultRef.current === vault) setExpanded((previous) => new Set([...previous, folder]));
      setNotice("Web link added as a shortcut. The video itself was not downloaded.");
    } catch (error) { setNotice(`Couldn't add link: ${errorMessage(error)}`); }
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
    dragSourceRef.current = entry.path;
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
    showDropIndicator(null);
    const path = draggedPath(event); dragSourceRef.current = "";
    if (path) { if (parentPath(path) !== folder) void moveItem(path, folder); }
    else if (event.dataTransfer.files.length) void importBrowserFiles([...event.dataTransfer.files], folder);
    else { const url = firstDroppedUrl(event.dataTransfer.getData("text/uri-list"), event.dataTransfer.getData("text/plain")); if (url) void importLink(url, folder); }
  };
  const treePlacement = (source: string, item: Entry, bounds: DOMRect, y: number, surface: "sidebar" | "map" = "sidebar"): DropIndicator | null => {
    if (!source) return { path: item.kind === "folder" ? item.path : parentPath(item.path), position: "into", surface };
    if (source === item.path || isPathInside(parentPath(item.path), source)) return null;
    const before = y < bounds.top + bounds.height / 2;
    const nearEdge = y < bounds.top + bounds.height * .28 || y > bounds.bottom - bounds.height * .28;
    // Edges of a file or folder mean ordering among its siblings. This also
    // works across folders: the item is moved into that parent before ordering.
    if (item.kind !== "folder" || nearEdge) return { path: item.path, position: before ? "before" : "after", surface, source };
    if (item.kind === "folder" && !isPathInside(item.path, source)) return { path: item.path, position: "into", surface, source };
    return null;
  };
  const applyTreeDrop = (source: string, item: Entry, indicator: DropIndicator | null) => {
    if (!indicator || !source || source === item.path) return;
    if (indicator.position === "into") { void moveItem(source, item.path); return; }
    const targetParent = parentPath(item.path);
    const siblings = orderItems(entries.filter((entry) => parentPath(entry.path) === targetParent), targetParent).map((entry) => entry.path);
    if (normalizePath(parentPath(source)) === normalizePath(targetParent)) {
      commitMeta((current) => reorderChildren(current, targetParent, siblings, source, item.path, indicator.position === "after"));
    } else {
      const vault = vaultRef.current;
      void moveItem(source, targetParent).then((destination) => {
        if (!destination || vaultRef.current !== vault) return;
        commitMeta((current) => reorderChildren(current, targetParent, [...siblings, destination], destination, item.path, indicator.position === "after"));
      });
    }
  };
  const dragOverTree = (event: DragEvent, item: TreeNode, surface: "sidebar" | "map" = "sidebar") => {
    event.preventDefault(); event.stopPropagation();
    const indicator = treePlacement(dragSourceRef.current, item, event.currentTarget.getBoundingClientRect(), event.clientY, surface);
    event.dataTransfer.dropEffect = indicator ? (dragSourceRef.current ? "move" : "copy") : "none";
    showDropIndicator(indicator);
  };
  const dropOnTree = (event: DragEvent, item: TreeNode, surface: "sidebar" | "map" = "sidebar") => {
    event.preventDefault(); event.stopPropagation();
    const source = draggedPath(event); const indicator = treePlacement(source, item, event.currentTarget.getBoundingClientRect(), event.clientY, surface);
    showDropIndicator(null); dragSourceRef.current = "";
    if (!source) {
      const folder = item.kind === "folder" ? item.path : parentPath(item.path);
      if (event.dataTransfer.files.length) void importBrowserFiles([...event.dataTransfer.files], folder);
      else { const url = firstDroppedUrl(event.dataTransfer.getData("text/uri-list"), event.dataTransfer.getData("text/plain")); if (url) void importLink(url, folder); }
      return;
    }
    if (!indicator && source !== item.path) setNotice("Drop on a folder to move an item, or on a sibling to reorder it.");
    applyTreeDrop(source, item, indicator);
  };
  const startPointerDrag = (event: React.PointerEvent, source: TreeNode) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const startX = event.clientX, startY = event.clientY, pointer = event.pointerId;
    let moving = false;
    const handle = event.currentTarget as HTMLElement;
    try { handle.setPointerCapture(pointer); } catch { /* Pointer capture is optional. */ }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      if (!moving && Math.hypot(next.clientX - startX, next.clientY - startY) < 5) return;
      moving = true; next.preventDefault();
      const hit = document.elementFromPoint(next.clientX, next.clientY);
      const row = hit?.closest<HTMLElement>("[data-tree-path]");
      const item = row && entries.find((entry) => entry.path === row.dataset.treePath);
      const mapRoot = hit?.closest<HTMLElement>("[data-map-root]");
      showDropIndicator(row && item ? treePlacement(source.path, item, row.getBoundingClientRect(), next.clientY, mapRoot ? "map" : "sidebar") : mapRoot && hit?.closest<HTMLElement>("[data-map-path]")?.dataset.mapPath === vaultRef.current && normalizePath(parentPath(source.path)) !== normalizePath(vaultRef.current) ? { path: vaultRef.current, position: "into", surface: "map", source: source.path } : null);
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel);
      const indicator = dropIndicatorRef.current;
      const item = indicator && entries.find((entry) => entry.path === indicator.path);
      showDropIndicator(null);
      if (moving && indicator?.path === vaultRef.current && indicator.position === "into") { if (parentPath(source.path) !== vaultRef.current) void moveItem(source.path, vaultRef.current); }
      else if (moving && item && indicator) applyTreeDrop(source.path, item, indicator);
    };
    const cancel = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel); showDropIndicator(null); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", cancel);
  };

  useEffect(() => {
    const clear = (event: Event) => {
      if (event.type === "dragleave" && (event as globalThis.DragEvent).relatedTarget) return;
      showDropIndicator(null); dragSourceRef.current = "";
    };
    window.addEventListener("dragleave", clear); window.addEventListener("drop", clear); window.addEventListener("dragend", clear);
    return () => { window.removeEventListener("dragleave", clear); window.removeEventListener("drop", clear); window.removeEventListener("dragend", clear); };
  }, []);

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!modalOpen && selectionRef.current.size) { const empty = new Set<string>(); selectionRef.current = empty; selectionAnchor.current = ""; setSelection(empty); }
        setContextMenu(null);
        if (!dialogBusy) {
          setCreateDialog(null); setPathCreateDialog(null); setRenameNode(null); setDeleteNode(null); setBulkDelete(null);
          setLinkOpen(false); setCaptureOpen(false); setDesktopInfoOpen(false); setSearchOpen(false);
          setTagDialogOpen(false); setMoveDialog(null); setVaultMenuOpen(false); setWorkspaceCustomize(false);
        }
        return;
      }
      if (modalOpen || restoring || event.repeat || (event.target as Element | null)?.closest?.(".shortcut-edit.recording")) return;
      const pressed = keyboardShortcut(event, modifier === "⌘");
      const action = (Object.entries(settings.shortcuts) as [keyof Settings["shortcuts"], string][]).find(([, value]) => value === pressed)?.[0];
      if (!action) return;
      event.preventDefault();
      if (action === "search") setSearchOpen(true);
      else if (action === "capture") openCapture();
      else if (action === "path") { pathInputRef.current?.focus(); pathInputRef.current?.select(); }
      else if (action === "newFile") openCreate("note", workspaceDestination);
      else if (action === "newFolder") openCreate("folder", workspaceDestination);
      else if (action === "sidebar") setExplorerOpen((previous) => !previous);
      else if (action === "save") void flushAll().catch(() => setNotice("Couldn't save this note. Your changes are still here; use Retry to try again."));
      else if (action === "back") void navigateHistory(-1);
      else if (action === "forward") void navigateHistory(1);
      else if (action === "tags") openTags(currentLocation !== vaultRef.current ? currentLocation : null);
      else if ((action === "pin" || action === "favorite") && currentLocation && currentLocation !== vaultRef.current) toggleProperty(currentLocation, action === "pin" ? "pinned" : "favorite");
    };
    const onPageHide = () => { void flushPending().catch(() => undefined); };
    window.addEventListener("keydown", onKey); window.addEventListener("pagehide", onPageHide);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pagehide", onPageHide); };
  });

  const runUpdateCheck = async (notify = false) => {
    setUpdateStatus("Checking GitHub…");
    try { const result = await checkUpdates(APP_VERSION, AbortSignal.timeout(12_000)); setAvailableUpdate(result); setUpdateStatus(result ? "" : "You're up to date."); if (result && notify) setUpdateNotice(true); }
    catch { setUpdateStatus("Couldn't check for updates. Check your connection and try again."); }
  };
  const installUpdate = async () => {
    if (!availableUpdate?.installer || !desktopAvailable) return;
    setUpdateStatus("Saving your work…");
    try { await flushAll(); setUpdateStatus("Downloading and verifying the Windows installer…"); await invoke("install_update", { version: availableUpdate.version, digest: availableUpdate.installer.digest }); setUpdateStatus("The installer has opened. Follow its instructions to finish updating."); }
    catch (reason) { setUpdateStatus(`Couldn't start the update: ${errorMessage(reason)}. You can open the release page instead.`); }
  };
  const openUpdatePage = () => { if (!availableUpdate) return; if (desktopAvailable) void openUrl(availableUpdate.page); else window.open(availableUpdate.page, "_blank", "noopener,noreferrer"); };

  const updateTodo = (board: TodoDocument) => {
    if (workspaceView !== "todo" || selectedRef.current !== selectedPath || fileKind(selectedPath) !== "todo") return false;
    const next = serializeTodo(board);
    const textError = editableTextError(next);
    if (textError || !parseTodo(next)) { setNotice(textError || "This change exceeds the to-do board limits and wasn't saved."); return false; }
    contentRef.current = next; setContent(next); queueSave(selectedPath, next);
    return true;
  };

  const updateWhiteboard = (board: WhiteboardDocument) => {
    if (workspaceView !== "whiteboard" || selectedRef.current !== selectedPath || fileKind(selectedPath) !== "whiteboard") return false;
    const next = serializeWhiteboard(board), textError = editableTextError(next);
    if (textError || !parseWhiteboard(next)) { setNotice(textError || "This change exceeds whiteboard limits and wasn't saved."); return false; }
    contentRef.current = next; setContent(next); queueSave(selectedPath, next); return true;
  };

  const saveLabel = saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved changes" : "Saved";

  return (
    <div className={`comet-root mountain-visible${focusMode ? " focus-mode" : ""}${selection.size ? " has-selection" : ""}`} style={{ "--editor-font-size": `${settings.editorFontSize}px` } as CSSProperties} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); showDropIndicator(null); dragSourceRef.current = ""; }} onDragEnd={() => { showDropIndicator(null); dragSourceRef.current = ""; }} onClick={(event) => { if (contextMenu) setContextMenu(null); if (vaultMenuOpen && !(event.target as Element).closest(".workspace-switcher")) setVaultMenuOpen(false); }}>
      <div className="app-shell">
        <button className={`sidebar-scrim${explorerOpen ? " is-open" : ""}`} type="button" aria-label="Close sidebar" aria-hidden={!explorerOpen} tabIndex={explorerOpen ? 0 : -1} onClick={() => setExplorerOpen(false)} />
        <aside className={`sidebar${explorerOpen ? "" : " is-closed"}`} aria-label="Workspace navigation" aria-hidden={!explorerOpen} inert={!explorerOpen}>
          <div className="sidebar-brand">
            <div className="brand-mark" aria-hidden="true"><img src="/comet.svg" alt="" /></div>
            <div className="brand-name">comet<span>.</span></div>
            <button className="sidebar-close-mobile icon-button" type="button" aria-label="Close sidebar" onClick={() => setExplorerOpen(false)}><X size={18} /></button>
          </div>

          <div className="workspace-switcher">
            <button className="workspace-picker" type="button" onClick={() => setVaultMenuOpen((value) => !value)} aria-label="Switch workspace" aria-expanded={vaultMenuOpen}>
              <span className="workspace-avatar">{workspaceIdentity.icon}</span>
              <span className="workspace-picker-copy"><strong>{vaultName}</strong><small>{isSample ? (desktopAvailable ? "Sample data" : "Interactive browser sample") : "Local workspace"}</small></span>
              <ChevronDown size={16} className="workspace-chevron" aria-hidden="true" />
            </button>
            {vaultMenuOpen && <div className="vault-dropdown">
              <span className="dropdown-label">WORKSPACES</span>
              {vaults.map((path) => { const sample = path === SAMPLE_ROOT; const identity = identityFor(identities, path, sample ? "Sample workspace" : vaultLabel(path)); return <div className={`vault-option-row${path === vaultPath ? " selected" : ""}${vaultDrop?.path === path ? vaultDrop.after ? " drop-after" : " drop-before" : ""}`} data-vault-path={path} key={path}>
                <button type="button" className="vault-drag" aria-label={`Reorder ${identity.name}`} title="Drag to reorder workspaces" onPointerDown={(event) => startVaultDrag(event, path)}><GripVertical size={14} /></button>
                <button type="button" className="vault-option" onClick={() => sample ? void activateSample() : void activateVault(path, true)} title={sample ? "Sample workspace" : path}><span className="vault-mini-avatar">{identity.icon}</span><span>{identity.name}</span>{path === vaultPath && <CheckCircle2 size={14} />}</button>
                {!sample && <button type="button" className="icon-button vault-explore" title="Open in system file explorer" aria-label={`Open ${identity.name} in file explorer`} onClick={() => void invoke("open_workspace_directory", { path }).catch((error) => setNotice(`Couldn't open the folder: ${errorMessage(error)}`))}><FolderOpen size={15} /></button>}
                <button type="button" className="icon-button vault-remove" title={sample ? "Remove from list (sample data is kept)" : "Remove from list (files stay on disk)"} aria-label={`Remove ${identity.name} from workspace list`} onClick={() => { const next = vaults.filter((item) => item !== path); setVaults(next); saveVaultList(next); }}><X size={14} /></button>
              </div>; })}
              {!vaults.includes(SAMPLE_ROOT) && <button type="button" className="vault-add" onClick={() => void activateSample()}><Plus size={15} /> Add sample workspace</button>}
              <div className="context-divider" /><button type="button" className="vault-add" onClick={() => { setWorkspaceNameDraft(vaultName); setWorkspaceIconDraft(workspaceIdentity.icon); setDialogError(""); setWorkspaceCustomize(true); setVaultMenuOpen(false); }}><Pencil size={15} /> Customize current workspace</button><button type="button" className="vault-add" onClick={() => void openVault()}><Plus size={16} /> Add workspace</button>
            </div>}
          </div>

          <button className="sidebar-search" type="button" onClick={focusSearch} aria-label="Search files and tags"><Search size={16} /><span>Search anything</span><kbd>{shortcutLabel(settings.shortcuts.search, modifier === "⌘")}</kbd></button>
          <nav className="primary-nav" aria-label="Library">
            <button className={workspaceView === "all" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "all" ? "page" : undefined} onClick={() => void showOverview("all")}><BookOpen size={17} /><span>All files</span><small>{noteCount}</small></button>
            <button className={workspaceView === "pinned" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "pinned" ? "page" : undefined} onClick={() => void showOverview("pinned")}><Pin size={17} /><span>Pinned</span><small>{entries.filter((entry) => itemMeta(metadata, entry.path).pinned).length}</small></button>
            <button className={workspaceView === "favorites" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "favorites" ? "page" : undefined} onClick={() => void showOverview("favorites")}><Star size={17} /><span>Favorites</span><small>{entries.filter((entry) => itemMeta(metadata, entry.path).favorite).length}</small></button>
            <button className={workspaceView === "tree" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "tree" ? "page" : undefined} onClick={() => void showOverview("tree")}><GitBranch size={17} /><span>Tree view</span><ChevronRight size={14} className="settings-nav-arrow" /></button>
            <button className={workspaceView === "brain" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "brain" ? "page" : undefined} onClick={() => void showOverview("brain")}><Network size={17} /><span>Brain view</span><ChevronRight size={14} className="settings-nav-arrow" /></button>
            <button className={workspaceView === "calendar" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "calendar" ? "page" : undefined} onClick={() => void showOverview("calendar")}><CalendarDays size={17} /><span>Calendar</span><ChevronRight size={14} className="settings-nav-arrow" /></button>
            <button className={workspaceView === "passwords" ? "nav-item active" : "nav-item"} type="button" aria-current={workspaceView === "passwords" ? "page" : undefined} onClick={() => void showOverview("passwords")}><KeyRound size={17} /><span>Passwords</span><ChevronRight size={14} className="settings-nav-arrow" /></button>
            <button className="nav-item" type="button" onClick={() => openTags()}><Tag size={17} /><span>Manage tags</span><ChevronRight size={14} className="settings-nav-arrow" /></button>
          </nav>
          <div className="sidebar-section-heading">
            <span>YOUR FILES</span>
            <div className="section-actions"><button type="button" className="icon-button section-add" onClick={() => openCreate("folder", vaultPath)} aria-label="New folder" title="New folder"><FolderPlus size={16} /></button><button type="button" className="icon-button section-add" onClick={(event) => openNewMenu(event, vaultPath)} aria-label="Add file or upload" title="New file, folder, or upload"><Plus size={18} /></button></div>
          </div>
          <div className={`tree-scroll${dropIndicator?.surface === "sidebar" && dropGroup === vaultPath ? " drop-target" : ""}`} data-drop-folder={vaultPath} onClick={(event) => { if (event.target === event.currentTarget || (event.target as Element).classList.contains("tree-list") || (event.target as Element).classList.contains("tree-message")) clearSelection(); }} onContextMenu={(event) => { if (event.target === event.currentTarget || (event.target as Element).classList.contains("tree-list")) openNewMenu(event, vaultPath); }} onDragOver={(event) => { event.preventDefault(); showDropIndicator({ path: vaultPath, position: "into", surface: "sidebar" }); }} onDrop={(event) => dropToFolder(event, vaultPath)}>
            {tree.length === 0 && <div className="tree-message">Nothing here yet.<br /><span>Create a file to get started.</span></div>}
            <div className="tree-list">{tree.map((node) => <TreeNodeView key={node.path} node={node} depth={0} selectedPath={workspaceView === "note" || workspaceView === "file" || workspaceView === "todo" || workspaceView === "whiteboard" ? selectedPath : workspaceView === "folder" ? folderPath : ""} expanded={expanded} metadata={metadata} onToggle={toggleFolder} onActivate={(event, item) => activateSelection(event, item, visibleTreePaths)} selectedPaths={selection} onContext={handleTreeContext} onDragStart={dragStart} onDragOver={dragOverTree} onDrop={dropOnTree} onPointerDrag={startPointerDrag} dropIndicator={dropIndicator} dropGroup={dropIndicator?.surface === "sidebar" ? dropGroup : ""} />)}</div>
          </div>
          <div className="sidebar-bottom">
            <button className={workspaceView === "settings" ? "nav-item settings-nav active" : "nav-item settings-nav"} type="button" aria-current={workspaceView === "settings" ? "page" : undefined} onClick={() => { setSettingsSection("general"); void showSettings(); }}><Settings2 size={17} /><span>Settings</span><ChevronRight size={14} className="settings-nav-arrow" /></button>
            <div className="sidebar-footer"><span>{isSample ? (sampleVault.isPersisted() ? "Sample · saved here" : "Sample · temporary") : "Local workspace"}</span><span>v{APP_VERSION}</span></div>
          </div>
        </aside>

        <main className="main-area">
          <header className="app-topbar">
            <div className="topbar-left">
              <button className="icon-button sidebar-toggle" type="button" onClick={() => { setExplorerOpen((value) => !value); if (focusMode) setFocusMode(false); }} aria-label={explorerOpen ? "Hide sidebar" : "Show sidebar"} aria-expanded={explorerOpen} title={`Toggle sidebar (${shortcutLabel(settings.shortcuts.sidebar, modifier === "⌘")})`}>{explorerOpen ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}</button>
              <button className="icon-button history-button" type="button" aria-label="Go back" title="Go back" disabled={history.index <= 0} onClick={() => void navigateHistory(-1)}><ArrowLeft size={17} /></button>
              <button className="icon-button history-button" type="button" aria-label="Go forward" title="Go forward" disabled={history.index >= history.items.length - 1} onClick={() => void navigateHistory(1)}><ArrowRight size={17} /></button>
            </div>
              <form className="pathbar" onSubmit={submitPath} onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPathEditing(false); }}>
                <div className="pathbar-field">
                  <FolderOpen size={16} aria-hidden="true" />
                  <input ref={pathInputRef} aria-label="Workspace path" aria-describedby={pathEditing ? "path-hint" : undefined} autoComplete="off" spellCheck={false} value={pathEditing ? pathDraft : displayedPath} placeholder={"Comet\\Folder\\note.md"} onFocus={(event) => { setPathDraft(event.currentTarget.value); setPathEditing(true); }} onChange={(event) => setPathDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setPathEditing(false); event.currentTarget.blur(); } }} />
                  <kbd className="path-shortcut">{shortcutLabel(settings.shortcuts.path, modifier === "⌘")}</kbd>
                  <button type="submit" className="path-go" aria-label="Go to path" title="Open or create this path"><ArrowRight size={15} /></button>
                </div>
                {pathEditing && <div className="path-popover" id="path-hint" aria-live="polite">
                  <div className="path-popover-heading"><span>GO TO A PATH</span><span>IN THIS WORKSPACE</span></div>
                  <p>Type a folder or file path, then press Enter.</p>
                  {pathPlan.kind === "error" ? <div className="path-feedback error"><AlertCircle size={16} /><span>{pathPlan.message}</span></div> : <button className="path-feedback" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => goToPath(pathPlan)}>
                    <span className="path-feedback-icon">{pathPlan.kind === "folder" || pathPlan.kind === "root" ? <FolderOpen size={16} /> : pathPlan.kind === "create" ? (pathPlan.target === "folder" ? <FolderPlus size={16} /> : <FilePlus2 size={16} />) : <FileIcon entry={{ path: pathPlan.path, name: fileName(pathPlan.path), kind: "file" }} size={16} />}</span>
                    <span><strong>{pathPlan.kind === "root" ? "Open all files" : pathPlan.kind === "folder" ? "Open folder" : pathPlan.kind === "note" ? "Open file" : pathPlan.kind === "create" && pathPlan.target === "folder" ? "Create a new folder" : "Create a new file"}</strong><small>{pathPlan.kind === "root" ? "Comet" : displayWorkspacePath(pathPlan.path, vaultPath)}</small></span>
                    <kbd>↵</kbd>
                  </button>}
                  <div className="path-popover-foot">Use / or {"\\"} · End with a slash to create a folder.</div>
                </div>}
              </form>
            <div className="topbar-actions">
              {!isSample && <button className="icon-button" type="button" aria-label="Show current path in file explorer" title="Show current path in file explorer" onClick={() => void revealPath(currentLocation)}><FolderOpen size={17} /></button>}
              {selection.size > 0 && <button className="selection-clear icon-button" type="button" aria-label="Clear selection" title="Clear selection (Escape)" onClick={() => { const empty = new Set<string>(); selectionRef.current = empty; selectionAnchor.current = ""; setSelection(empty); }}><X size={15} /></button>}
              {selection.size > 0 && <button className="selection-trash icon-button" type="button" aria-label={`Delete ${selection.size} selected items`} title={`Delete ${selection.size} selected items`} onClick={openBulkDelete}><Trash2 size={17} /><span>{selection.size}</span></button>}
              {isSample && <span className="sample-badge" aria-label={desktopAvailable ? "Sample workspace" : "Interactive browser sample"} title={desktopAvailable ? "Sample workspace" : "Interactive browser sample, not local files"}><span /> Sample</span>}
              <button className="icon-button top-search-button" type="button" onClick={focusSearch} aria-label="Search notes" title={`Search (${shortcutLabel(settings.shortcuts.search, modifier === "⌘")})`}><Search size={18} /></button>
              <button className="capture-icon" type="button" onClick={openCapture} aria-label="Quick capture" title={`Quick capture (${shortcutLabel(settings.shortcuts.capture, modifier === "⌘")})`}><Plus size={18} /></button>
            </div>
          </header>

          <div ref={workspaceScrollRef} className={`workspace-scroll without-cover${dropIndicator?.surface === "workspace" && dropIndicator.path === workspaceDestination && dropIndicator.position === "into" ? " drop-target" : ""}`} data-drop-folder={workspaceDestination} onClick={(event) => { const target = event.target as Element; if (!target.closest("button, a, input, select, textarea, [contenteditable=true], .workspace-entry, .brain-node, .todo-card, .todo-link-hit, .note-card, .media-card")) clearSelection(); }} onDragOver={(event) => { event.preventDefault(); showDropIndicator({ path: workspaceDestination, position: "into", surface: "workspace" }); }} onDrop={(event) => dropToFolder(event, workspaceDestination)} onContextMenu={(event) => { if (event.target === event.currentTarget) openNewMenu(event, workspaceDestination); }}>
            {workspaceView === "tree" ? <TreeExplore key={vaultPath} vault={vaultPath} name={vaultName} tree={tree} onOpen={openEntry} onContext={entryContext} selectedPaths={selection} onActivate={activateSelection} onClearSelection={clearSelection} dropIndicator={dropIndicator?.surface === "map" ? dropIndicator : null} dropGroup={dropIndicator?.surface === "map" ? dropGroup : ""} onDragStart={dragStart} onDragOverNode={(event, item) => dragOverTree(event, item, "map")} onDropNode={(event, item) => dropOnTree(event, item, "map")} onDragOverRoot={(event) => { event.preventDefault(); event.stopPropagation(); const root = (event.target as Element).closest<HTMLElement>("[data-map-path]"); if (root?.dataset.mapPath === vaultPath && (!dragSourceRef.current || normalizePath(parentPath(dragSourceRef.current)) !== normalizePath(vaultPath))) showDropIndicator({ path: vaultPath, position: "into", surface: "map", source: dragSourceRef.current }); else showDropIndicator(null); }} onDropRoot={(event) => { const root = (event.target as Element).closest<HTMLElement>("[data-map-path]"); if (root?.dataset.mapPath === vaultPath) dropToFolder(event, vaultPath); else { event.preventDefault(); event.stopPropagation(); showDropIndicator(null); } }} /> : workspaceView === "brain" ? <BrainExplore key={vaultPath} vault={vaultPath} name={vaultName} entries={entries} onOpen={openEntry} onContext={entryContext} selectedPaths={selection} onActivate={activateSelection} onClearSelection={clearSelection} /> : workspaceView === "calendar" ? <CalendarView key={vaultPath} vault={vaultPath} name={vaultName} desktop={desktopAvailable} onConnect={() => { setSettingsSection("cloud"); void showSettings(); }} /> : workspaceView === "passwords" ? <PasswordsView /> : workspaceView === "settings" ? <SettingsPage settings={settings} persisted={settingsPersisted} isSample={isSample} modifier={modifier} desktop={desktopAvailable} trayAvailable={trayAvailable} section={settingsSection} onSection={setSettingsSection} version={APP_VERSION} update={availableUpdate} updateStatus={updateStatus} onCheckUpdate={() => void runUpdateCheck()} onInstallUpdate={() => void installUpdate()} onUpdatePage={openUpdatePage} onChange={updateSettings} onBack={() => history.index > 0 ? void navigateHistory(-1) : void showOverview("all")} onOpenVault={() => void openVault()} /> : workspaceView === "whiteboard" && selectedPath && parseWhiteboard(content) ? <div className="todo-workspace"><div className="media-top-actions"><button className="icon-button" type="button" aria-label={`More options for ${selectedName}`} onClick={(event) => handleTreeContext(event, { name: selectedName, path: selectedPath, kind: "file", children: [] })}><MoreHorizontal size={19} /></button></div><Whiteboard key={selectedPath} board={parseWhiteboard(content)!} name={selectedName.replace(/\.comet-whiteboard$/i, "")} saveState={saveState} onChange={updateWhiteboard} onRename={() => openRename({ name: selectedName, path: selectedPath, kind: "file", children: [] })} onRetry={() => void flushAll().catch(() => setNotice("Still couldn't save. Please check the folder and try again."))} /></div> : workspaceView === "todo" && selectedPath && parseTodo(content) ? <div className="todo-workspace"><div className="media-top-actions"><button className={`icon-button ${itemMeta(metadata, selectedPath).pinned ? "active" : ""}`} type="button" aria-label={itemMeta(metadata, selectedPath).pinned ? "Unpin board" : "Pin board"} onClick={() => toggleProperty(selectedPath, "pinned")}><Pin size={17} /></button><button className={`icon-button ${itemMeta(metadata, selectedPath).favorite ? "active" : ""}`} type="button" aria-label={itemMeta(metadata, selectedPath).favorite ? "Remove board from favorites" : "Add board to favorites"} onClick={() => toggleProperty(selectedPath, "favorite")}><Star size={17} /></button><button className="icon-button" type="button" aria-label="Edit board tags" onClick={() => openTags(selectedPath)}><Tag size={17} /></button><button className="icon-button" type="button" aria-label={`More options for ${selectedName}`} onClick={(event) => handleTreeContext(event, { name: selectedName, path: selectedPath, kind: "file", children: [] })}><MoreHorizontal size={19} /></button></div><TodoBoard key={selectedPath} board={parseTodo(content)!} arrowheads={settings.todoArrowheads} name={selectedName.replace(/\.comet-todo$/i, "")} onRename={() => openRename({ name: selectedName, path: selectedPath, kind: "file", children: [] })} saveState={saveState} onChange={updateTodo} onRetry={() => void flushAll().catch(() => setNotice("Still couldn't save. Please check the folder and try again."))} /></div> : workspaceView === "note" && selectedPath ? <section className="note-card" aria-label={`File: ${selectedName}`}>
              <div className="document-header">
                <div className="document-heading">
                  <div className="document-icon"><FileText size={20} /></div>
                  <div className="document-heading-copy"><span>{isMarkdown(selectedPath) ? "YOUR NOTE" : "YOUR FILE"}</span><h2><button className="rename-title" type="button" aria-label={`Rename ${selectedName}`} title="Click to rename" onClick={() => openRename({ name: selectedName, path: selectedPath, kind: "file", children: [] })}>{isMarkdown(selectedPath) ? noteTitle(selectedName) : selectedName}<Pencil size={13} /></button></h2></div>
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
                  <ColorMenu label="Text color" color={/^#[0-9a-f]{6}$/i.test(formatting?.textColor || "") ? formatting!.textColor : "#e6a17f"} preserveSelection trigger={<span className="toolbar-color-letter" style={{ "--current-color": formatting?.textColor || "#e6a17f" } as CSSProperties}>A</span>} onChange={(color) => editor?.chain().setColor(color).run()} onReset={() => editor?.chain().unsetColor().run()} />
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
              <div className="document-footer"><div><span>{words} {words === 1 ? "word" : "words"}</span><span className="footer-dot" /> <span>{isMarkdown(selectedPath) ? "Markdown" : "Plain text"}</span></div><span>{isSample ? (sampleVault.isPersisted() ? (desktopAvailable ? "Sample saved in this app" : "Sample saved in this browser") : "Temporary sample") : "Saved locally"}</span></div>
            </section> : workspaceView === "file" && selectedPath ? <div className="media-workspace">
              <div className="media-top-actions"><button className={`icon-button ${itemMeta(metadata, selectedPath).pinned ? "active" : ""}`} type="button" aria-label={itemMeta(metadata, selectedPath).pinned ? "Unpin file" : "Pin file"} onClick={() => toggleProperty(selectedPath, "pinned")}><Pin size={17} /></button><button className={`icon-button ${itemMeta(metadata, selectedPath).favorite ? "active" : ""}`} type="button" aria-label={itemMeta(metadata, selectedPath).favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => toggleProperty(selectedPath, "favorite")}><Star size={17} /></button><button className="icon-button" type="button" aria-label="Edit file tags" onClick={() => openTags(selectedPath)}><Tag size={17} /></button><button className="icon-button" type="button" aria-label={`More options for ${selectedName}`} onClick={(event) => handleTreeContext(event, { name: selectedName, path: selectedPath, kind: "file", children: [] })}><MoreHorizontal size={19} /></button></div>
              <MediaView key={selectedPath} path={selectedPath} url={mediaUrl} content={content} sample={isSample} autoCoverArt={settings.autoCoverArt} onRename={() => openRename({ name: selectedName, path: selectedPath, kind: "file", children: [] })} onOpenExternal={() => void openExternal()} onEditAsText={() => void openUnknownAsText()} onOpenWeb={(url) => { if (desktopAvailable) void openUrl(url).catch(() => setNotice("Couldn't open that link.")); else window.open(url, "_blank", "noopener,noreferrer"); }} />
            </div> : <>
              {workspaceView === "folder" && <button className="folder-parent workspace-parent" type="button" onClick={() => folderParentIsRoot ? void showOverview("all") : void showFolder(folderParent)}><ArrowRight size={14} /> {folderParentIsRoot ? "All files" : fileName(folderParent)}</button>}
              <WorkspacePanel title={workspaceView === "folder" ? fileName(folderPath) : workspaceView === "pinned" ? "Pinned" : workspaceView === "favorites" ? "Favorites" : "All files"} description={workspaceView === "folder" ? "Everything in this folder, together." : workspaceView === "pinned" ? "The things you want close at hand." : workspaceView === "favorites" ? "A little collection of your favorites." : "All your files and folders, in one place."} entries={workspaceEntries} vault={vaultPath} destination={workspaceDestination} metadata={metadata} layout={layout} iconSize={iconSize} onLayout={setLayout} onIconSize={setIconSize} onOpen={(event, entry) => activateSelection(event, entry, workspaceEntries.map((item) => item.path))} selectedPaths={selection} onMenu={entryContext} onBackgroundMenu={openNewMenu} onCreate={openNewMenu} onDragStart={dragStart} onDragOver={(event, folder) => { event.preventDefault(); event.stopPropagation(); showDropIndicator({ path: folder, position: "into", surface: "workspace" }); }} dropFolder={dropIndicator?.surface === "workspace" && dropIndicator.position === "into" ? dropIndicator.path : ""} onDrop={dropToFolder} />
            </>}
          </div>
        </main>
      </div>

      {updateNotice && availableUpdate && <div className="update-notice" role="status"><div><strong>Comet {availableUpdate.version} is available</strong><span>A new version is ready to review.</span></div><button type="button" className="secondary-button" onClick={() => setUpdateNotice(false)}>Later</button><button type="button" className="primary-button" onClick={() => { setUpdateNotice(false); setSettingsSection("updates"); void showSettings(); }}>Update</button></div>}

      {notice && <div className="toast" role="status"><AlertCircle size={17} /> <span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={16} /></button></div>}

      {contextMenu && <div className="context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
        <div className="context-heading" title={contextMenu.node?.name ?? contextMenu.folder}>{contextMenu.node?.name ?? `Add to ${contextMenu.folder === vaultPath ? "workspace" : fileName(contextMenu.folder)}`}</div>
        {contextMenu.node && <button role="menuitem" type="button" onClick={() => { const node = contextMenu.node!; setContextMenu(null); openEntry(node); }}><FolderOpen size={16} /> Open</button>}
        {!isSample && <button role="menuitem" type="button" onClick={() => void revealPath(contextMenu.node?.path ?? contextMenu.folder)}><FolderOpen size={16} /> Open in Explorer</button>}
        {(!contextMenu.node || contextMenu.node.kind === "folder") && <>
        {contextMenu.node && <div className="context-divider" />}
        <button role="menuitem" type="button" onClick={() => openCreate("note", contextMenu.folder)}><FilePlus2 size={16} /> New file</button>
        <button role="menuitem" type="button" onClick={() => openCreate("folder", contextMenu.folder)}><FolderPlus size={16} /> New folder</button>
        <button role="menuitem" type="button" onClick={() => openCreate("todo", contextMenu.folder)}><ListChecks size={16} /> New to-do board</button>
        <button role="menuitem" type="button" onClick={() => openCreate("whiteboard", contextMenu.folder)}><Square size={16} /> New whiteboard</button>
        <button role="menuitem" type="button" onClick={() => void upload(contextMenu.folder)}><Upload size={16} /> Upload files</button>
        </>}
        {contextMenu.node && <>
          {contextMenu.node.kind === "folder" && <div className="context-divider" />}
          <button role="menuitem" type="button" onClick={() => toggleProperty(contextMenu.node!.path, "pinned")}><Pin size={16} /> {itemMeta(metadata, contextMenu.node.path).pinned ? "Unpin" : "Pin"}</button>
          <button role="menuitem" type="button" onClick={() => toggleProperty(contextMenu.node!.path, "favorite")}><Star size={16} /> {itemMeta(metadata, contextMenu.node.path).favorite ? "Remove favorite" : "Add favorite"}</button>
          <button role="menuitem" type="button" onClick={() => openTags(contextMenu.node!.path)}><Tag size={16} /> Edit tags</button>
          <button role="menuitem" type="button" onClick={() => { setMoveDialog(contextMenu.node!); setMoveFolder(parentPath(contextMenu.node!.path) || vaultPath); setContextMenu(null); }}><FolderOpen size={16} /> Move to…</button>
          <button role="menuitem" type="button" onClick={() => openRename(contextMenu.node!)}><Pencil size={16} /> Rename</button>
          <button role="menuitem" type="button" className="danger" onClick={() => openDelete(contextMenu.node!)}><Trash2 size={16} /> Delete</button>
        </>}
      </div>}

      {searchOpen && <SearchDialog query={searchQuery} results={searchResults} searching={searching} entries={entries} tags={metadata.tags} onQuery={setSearchQuery} onOpen={(entry) => { setSearchOpen(false); openEntry(entry); }} onClose={() => setSearchOpen(false)} />}
      {tagDialogOpen && <TagDialog metadata={metadata} target={tagTarget} onClose={() => setTagDialogOpen(false)} onCreate={createTag} onToggle={toggleTag} onDelete={deleteTag} onSearch={(name) => { setTagDialogOpen(false); setSearchQuery(`#${name}`); setSearchOpen(true); }} />}
      {moveDialog && <MovePicker item={moveDialog} tree={tree} vault={vaultPath} name={vaultName} destination={moveFolder} onDestination={setMoveFolder} onClose={() => setMoveDialog(null)} onMove={() => void moveItem(moveDialog.path, moveFolder)} />}
      <input ref={uploadInputRef} type="file" multiple hidden onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void importBrowserFiles(files, uploadFolder); }} />

      {workspaceCustomize && <div className="modal-backdrop" onMouseDown={() => setWorkspaceCustomize(false)}>
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="workspace-custom-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => {
          event.preventDefault();
          const name = workspaceNameDraft.trim(); const icon = workspaceIconDraft.trim();
          if (!name || name.length > 60 || [...icon].length > 8) { setDialogError("Enter a name and an icon of up to eight characters."); return; }
          const next = { ...identities, [normalizePath(vaultPath)]: { name, icon } };
          setIdentities(next); if (!saveWorkspaceIdentities(next)) setNotice("Workspace customization will last for this session only.");
          setDialogError(""); setWorkspaceCustomize(false);
        }}>
          <div className="modal-icon"><Pencil size={20} /></div><button className="modal-close icon-button" type="button" aria-label="Close workspace customization" onClick={() => setWorkspaceCustomize(false)}><X size={18} /></button>
          <h2 id="workspace-custom-title">Make this workspace yours</h2><p>Choose a name and a small icon. These are saved on this device and don't rename your folder.</p>
          <label className="modal-label" htmlFor="workspace-name">Workspace name</label><input id="workspace-name" autoFocus maxLength={60} value={workspaceNameDraft} onChange={(event) => { setWorkspaceNameDraft(event.target.value); setDialogError(""); }} />
          <label className="modal-label" htmlFor="workspace-icon">Icon or emoji</label><input id="workspace-icon" maxLength={16} value={workspaceIconDraft} onChange={(event) => setWorkspaceIconDraft(event.target.value)} placeholder="e.g. 🏔️" />
          <div className="workspace-icon-options">{["🏔️", "✦", "📚", "🌿", "💎", "🚀", "🎨", "☁️"].map((icon) => <button key={icon} type="button" aria-label={`Use ${icon} icon`} aria-pressed={workspaceIconDraft === icon} onClick={() => setWorkspaceIconDraft(icon)}>{icon}</button>)}</div>
          {dialogError && <div className="dialog-error" role="alert">{dialogError}</div>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setWorkspaceCustomize(false)}>Cancel</button><button className="primary-button" type="submit">Save workspace</button></div>
        </form>
      </div>}

      {pathCreateDialog && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setPathCreateDialog(null)}>
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="path-create-title" onSubmit={(event) => void confirmPathCreate(event)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon"><FilePlus2 size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setPathCreateDialog(null)} aria-label="Close dialog" disabled={dialogBusy}><X size={18} /></button>
          <h2 id="path-create-title">Create this {pathCreateDialog.target}?</h2><p>{pathCreateDialog.target === "folder" ? "We'll create this folder and any missing parent folders. No file will be created." : "We'll create a file at this path. Names without an extension use .md; existing files are never overwritten."}</p>
          <div className="path-create-location"><FileText size={16} /><span>{displayWorkspacePath(pathCreateDialog.path, pathCreateDialog.vault)}</span></div>
          {pathCreateDialog.target === "file" && pathCreateDialog.missingFolders.length > 0 && <p className="path-create-folders"><FolderPlus size={15} /> {pathCreateDialog.missingFolders.length === 1 ? "1 new folder will be created" : `${pathCreateDialog.missingFolders.length} new folders will be created`} along the way.</p>}
          {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" autoFocus onClick={() => setPathCreateDialog(null)} disabled={dialogBusy}>Cancel</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "Creating…" : `Create ${pathCreateDialog.target}`}</button></div>
        </form>
      </div>}

      {createDialog && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setCreateDialog(null)}>
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onSubmit={(event) => void submitCreate(event)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-icon"><FilePlus2 size={20} /></div><button className="modal-close icon-button" type="button" onClick={() => setCreateDialog(null)} aria-label="Close dialog" disabled={dialogBusy}><X size={18} /></button>
          <h2 id="create-title">New {createDialog.kind === "note" ? "file" : createDialog.kind === "todo" ? "to-do board" : createDialog.kind === "whiteboard" ? "whiteboard" : "folder"}</h2>
          <p>Give your {createDialog.kind === "note" ? "file" : createDialog.kind === "todo" ? "to-do board" : createDialog.kind === "whiteboard" ? "whiteboard" : "folder"} a name. It will be saved in <strong>{createDialog.folder === vaultPath ? vaultName : relativePath(createDialog.folder, vaultPath)}</strong>.</p>
          <label className="modal-label" htmlFor="entry-name">{createDialog.kind === "note" ? "File name" : createDialog.kind === "todo" || createDialog.kind === "whiteboard" ? "Board name" : "Folder name"}</label>
          <input id="entry-name" autoFocus value={entryName} onChange={(event) => { setEntryName(event.target.value); setDialogError(""); }} placeholder={createDialog.kind === "note" ? "e.g. ideas.md or list.txt" : createDialog.kind === "todo" || createDialog.kind === "whiteboard" ? "e.g. My ideas" : "Give your folder a name"} autoComplete="off" />
          {createDialog.kind === "note" && <span className="input-hint">Use any extension. Names without one are saved as .md.</span>}{createDialog.kind === "todo" && <span className="input-hint">Saved as a dedicated .comet-todo file.</span>}{createDialog.kind === "whiteboard" && <span className="input-hint">Saved as a dedicated .comet-whiteboard file.</span>}
          {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCreateDialog(null)} disabled={dialogBusy}>Cancel</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "Creating…" : `Create ${createDialog.kind === "note" ? "file" : createDialog.kind === "todo" || createDialog.kind === "whiteboard" ? "board" : "folder"}`}</button></div>
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

      {bulkDelete && <div className="modal-backdrop" onMouseDown={() => !dialogBusy && setBulkDelete(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon danger-icon"><Trash2 size={20} /></div><button className="modal-close icon-button" type="button" aria-label="Close delete selection" disabled={dialogBusy} onClick={() => setBulkDelete(null)}><X size={18} /></button>
        <h2 id="bulk-delete-title">Permanently delete {bulkDelete.length} {bulkDelete.length === 1 ? "item" : "items"}?</h2><p>Folders and everything inside them will be deleted {isSample ? "from the sample" : "from your computer, not moved to the trash"}. This cannot be undone.</p>
        <ul className="delete-selection-list">{bulkDelete.map((entry) => <li key={entry.path}>{displayWorkspacePath(entry.path, vaultPath)}</li>)}</ul>
        {dialogError && <div className="dialog-error" role="alert"><AlertCircle size={15} /> {dialogError}</div>}
        <div className="modal-actions"><button className="secondary-button" type="button" autoFocus disabled={dialogBusy} onClick={() => setBulkDelete(null)}>Cancel</button><button className="danger-button" type="button" disabled={dialogBusy} onClick={() => void confirmBulkDelete()}>{dialogBusy ? "Deleting…" : "Delete permanently"}</button></div>
      </div></div>}

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
          <span className="input-hint">Saved as a new {captureType === "link" ? "web shortcut (.url)" : "Markdown file"} in the selected folder{captureType === "image" && isSample ? ". Image capture requires a local folder." : "."}</span>
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
  onActivate: (event: MouseEvent, node: TreeNode) => void;
  selectedPaths: Set<string>;
  onContext: (event: MouseEvent, node: TreeNode) => void;
  onDragStart: (event: DragEvent, entry: Entry) => void;
  onDrop: (event: DragEvent, node: TreeNode) => void;
  onDragOver: (event: DragEvent, node: TreeNode) => void;
  onPointerDrag: (event: React.PointerEvent, node: TreeNode) => void;
  dropIndicator: DropIndicator | null;
  dropGroup: string;
}

const TreeNodeView = memo(function TreeBranch({ node, depth, selectedPath, expanded, metadata, onToggle, onActivate, selectedPaths, onContext, onDragStart, onDragOver, onDrop, onPointerDrag, dropIndicator, dropGroup }: TreeNodeViewProps) {
  const folder = node.kind === "folder";
  const openFolder = expanded.has(node.path);
  const selected = node.path === selectedPath;
  const meta = itemMeta(metadata, node.path);
  return <div className={`tree-branch${folder && dropGroup === node.path ? " drop-group" : ""}`}>
    <div className={`tree-row${selected ? " selected" : ""}${selectedPaths.has(node.path) ? " multi-selected" : ""}${dropIndicator?.surface === "sidebar" && dropIndicator.path === node.path && dropIndicator.position !== "into" ? ` drop-${dropIndicator.position}` : ""}`} data-tree-path={node.path} data-drop-position={dropIndicator?.surface === "sidebar" && dropIndicator.path === node.path ? dropIndicator.position : undefined} style={{ paddingLeft: `${8 + depth * 14}px` }} draggable data-drop-folder={folder ? node.path : undefined} onDragStart={(event) => { event.stopPropagation(); onDragStart(event, node); }} onDragOver={(event) => onDragOver(event, node)} onDrop={(event) => onDrop(event, node)} onContextMenu={(event) => onContext(event, node)}>
      {folder ? <button type="button" className="tree-disclosure" aria-label={`${openFolder ? "Collapse" : "Expand"} ${node.name}`} aria-expanded={openFolder} onClick={() => onToggle(node.path)}>{openFolder ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="tree-disclosure" aria-hidden="true" />}
      <button type="button" className="tree-item" onClick={(event) => onActivate(event, node)} aria-pressed={selectedPaths.has(node.path)} aria-current={selected ? "page" : undefined} title={node.name}>
        <span className={`tree-icon ${folder ? "folder" : fileKind(node.path)}`}><FileIcon entry={node} size={16} expanded={openFolder} /></span>
        <span className="tree-name">{!folder && isMarkdown(node.name) ? noteTitle(node.name) : node.name}</span>{meta.pinned && <Pin size={11} className="tree-badge" />}{meta.favorite && <Star size={11} className="tree-badge" />}
      </button>
      <button type="button" className="tree-drag-handle" aria-label={`Drag to arrange ${node.name}`} title="Drag to arrange or move" onPointerDown={(event) => onPointerDrag(event, node)} onClick={(event) => event.stopPropagation()}><GripVertical size={14} /></button>
      <button type="button" className="tree-action" aria-label={`More options for ${node.name}`} title={`More options for ${node.name}`} onClick={(event) => onContext(event, node)}><MoreHorizontal size={16} /></button>
    </div>
    {folder && openFolder && node.children.map((child) => <TreeNodeView key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} expanded={expanded} metadata={metadata} onToggle={onToggle} onActivate={onActivate} selectedPaths={selectedPaths} onContext={onContext} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onPointerDrag={onPointerDrag} dropIndicator={dropIndicator} dropGroup={dropGroup} />)}
  </div>;
});

export default App;
