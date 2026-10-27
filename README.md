# Comet

Comet is a local-first desktop workspace for notes and other files. Choose a
folder on your computer; Comet works with the files there without an account or
a built-in sync service.

## Workspace

- **Organize your files.** Browse all files, folders, pins and favorites. Use the
  list or gallery layout and the size slider to adjust type-specific file icons.
  Create files, folders and to-do boards, or upload files from a `+`, folder or
  background menu. File menus contain actions for that file only.
- **Move and arrange.** Drag an item onto a folder to move it. In the sidebar,
  drop above or below another item to place it there—even when that moves it into
  a different folder; a destination label makes cross-folder drops clear. The
  **Move to** menu provides a searchable folder picker that also shows files
  beneath expanded folders (only folders can be selected as destinations).
  Drop files or web links on a folder or workspace to add them. Dropped files are
  limited to 20 MB; use **Upload files** for larger files in the desktop app.
  Renames, moves and imports reject collisions; moving or renaming does not
  rewrite links in other notes.
- **Select and delete.** Ctrl/Cmd-click toggles items, and Shift-click selects a
  range, in either the sidebar or the file list. Use the trash button to review
  and permanently delete the selection. Click blank space, press Escape, or use
  the X to clear it. A selected folder includes its descendants; failures are
  reported individually.
- **Explore.** Expand the root and folder nodes in the left-to-right Tree view
  to reveal files. Brain view shows up to 150 items as a network: click a folder
  node to reveal or hide its children, drag the background to pan or a node to
  arrange it, and click a file to open it. Right-click a node for actions such
  as Open, Move, Rename and Delete. Node positions are saved on this device.
  Solid lines represent folder membership; dotted lines represent
  links between Markdown notes. Only the first 256K characters of the first 120
  Markdown notes are read for connections, with bounded concurrency; binary files
  are never scanned as text.
- **Tags and search.** Manage tags from the sidebar and attach them to files or
  folders through an item's menu. Search filenames, supported text contents,
  and tags in the central search window; prefix a tag name with `#` to narrow
  the results.
- **Multiple workspaces.** Use the workspace dropdown to add or switch folders,
  drag rows to reorder them, customize the current workspace's display name and
  icon, or open a remembered folder in your system file explorer. Any workspace,
  including the sample, can be removed from the list. Removal keeps its files
  or sample data; the sample can be added back from the dropdown.
- **Navigation and appearance.** Use the back/forward arrows, mouse side
  buttons, or keyboard shortcuts to revisit places. Comet follows your system
  theme by default; Settings also offers dark, light, emerald, rubellite and navy
  themes, app and interface-text scaling, editor size, spell check, to-do
  arrowheads, and reopening the last workspace. The Matterhorn photo is
  always subtly visible behind the workspace.

Tags, pins, favorites, sidebar ordering, brain-node positions, workspace names
and icons, remembered workspaces, keyboard shortcuts, and preferences are stored
in Comet's local webview storage on this device, **not in the files**.
They survive moves and renames performed in Comet, but do not travel with the
vault to a different device or follow an externally moved vault folder. Back up
your workspace files independently. If local storage is unavailable, these
preferences last only for the current session.

## Files and editing

Names without an extension default to `.md`; names with an extension keep it.
Markdown opens in the visual editor, source editor, or read-only view. Known
UTF-8 text files such as `.txt`, `.json`, and `.csv` open in a plain-text editor.
Text editing is limited to 16 MB. Images, PDFs, audio and video open in a preview
or player; playback depends on the codecs available on the system. Unknown
formats are not automatically decoded as text: open them with the system app or
explicitly try UTF-8 text editing. Invalid UTF-8 and files containing NUL bytes
are rejected for text editing.

PDFs use locally bundled PDF.js resources. Choose single- or two-page layout,
fit pages to the available width, drag to pan, and use the zoom buttons or
Ctrl/Cmd + scroll; zoom follows the page position under the cursor. The custom
video controls include seeking, volume, playback speed and fullscreen. The audio
player shows embedded title, artist and cover art when available, a sound-driven
visualizer, a fullscreen player, and a volume slider that responds to the mouse
wheel.

When a track has no embedded cover, Comet **automatically sends its title and
artist, or its filename if tags are unavailable, to Apple's music catalog** to
look for one. Artwork is loaded from Apple's image host and cached on this device
(not in the workspace); cached image bytes are kept when the host permits it, with
an image URL as a fallback. You can turn off automatic lookup in Settings; the
**Find cover online** button remains available for an explicit lookup. Network
access is not required for playback, and unavailable artwork never blocks it.

The visual Markdown toolbar includes headings, sizes, preset and custom text
colors, highlighting, links, lists, and other formatting. Markdown has no
standard text-size or color syntax, so Comet stores these as inline HTML spans. Highlighting uses HTML
`<mark>` tags and underlining uses extension syntax. Other Markdown applications
may display them differently.
For documents containing unsupported Markdown/HTML constructs, use **Markdown**
source mode to avoid visual-editor normalization.

The centered path bar accepts workspace-relative paths such as
`Comet\Folder\text.md` or `Comet/Folder/text.txt`. Press Enter to open an
existing file or folder, or confirm creation of a new file and any missing
folders. End the path with a slash, for example `Comet\Folder\Nested\`, to
create only the missing folders. `Comet` is an alias for the current workspace;
absolute paths and `..` traversal are rejected.

Quick capture (`+` at the top) saves text as a new Markdown file, or a web link
as a standard `.url` shortcut in the destination folder. An image capture copies
the image into that same folder and links it relatively; image capture requires
a desktop workspace. Dropped links also become shortcuts; they do **not**
download videos. YouTube and direct video links in Markdown automatically show
players immediately below their links in Write and Read views (up to 50 per
note). Opening such a note or shortcut connects to YouTube or the video host;
YouTube uses the `youtube-nocookie.com` embed domain. Only validated HTTP(S)
links are used. Markdown source view remains plain text.

Create a **to-do board** from the New menu. A new `.comet-todo` file is a blank,
autosaving canvas: add tasks, use **Add item** for independently checkable
entries within a task, drag card grips to arrange them, and assign colored
categories from expanded details. Right-click a card or use its options button
for more actions. Hover a task to reveal its connection dot (always visible on
touch devices), then drag it onto another task. Click a connection to change its
color or remove it. Connections have no arrowheads by default; enable them in
Settings if wanted. Drag the canvas to look around, or use its zoom controls and
Ctrl/Cmd + scroll.

Existing version 1 and version 2 boards open without being changed on disk. On the
first edit they migrate to version 3, preserving tasks, notes, categories and
connections. Version 1 lists become categories; old list-to-list connections are
preserved in the file but not drawn as task connections. Comet refuses to edit
an invalid, unrecognized or newer board format rather than discarding unfamiliar
data. Older versions of Comet may not understand boards after they are edited in
this version; keep a backup if you need to use both versions.

Edits save automatically. If a save fails, the edit remains in the app and can
be retried. Comet waits for pending saves before switching notes or workspaces,
moving, renaming, deleting, or closing the desktop window. Deletion requires
confirmation and is permanent; it does not use the system trash.

The browser development preview is an interactive **sample**, not a view of
local files. Sample data is saved in browser storage when possible; large media
can exceed the storage quota, in which case changes are temporary. The sample
file picker accepts files up to 20 MB. The desktop file picker copies larger
files directly; HTML file drops are limited to 20 MB.
Clearing browser storage removes sample data.

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + K | Search files, contents, and tags |
| Ctrl/Cmd + L | Focus the workspace path bar |
| Ctrl/Cmd + Shift + K | Quick capture |
| Ctrl/Cmd + N | New file |
| Ctrl/Cmd + Shift + N | New folder |
| Ctrl/Cmd + Shift + P / F / T | Pin, favorite, or manage tags |
| Ctrl/Cmd + \\ | Toggle sidebar |
| Ctrl/Cmd + S | Save immediately |
| Alt + Left / Right | Back / forward |

Shortcuts can be changed in **Settings → Keyboard shortcuts**. The defaults above
use Ctrl on Windows/Linux and Command on macOS.

## Development and releases

The app uses Tauri 2, React, TypeScript, and Vite. Install Node.js 22.13 or newer
and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then:

```sh
cd web
npm ci
npm run tauri dev
```

Use `npm run dev` for the browser sample, `npm test` for the utility and editor
checks, and `npm run build` for the production web bundle. The icon source is
in [`assets/icon`](assets/icon); Windows installer artwork is in
[`packaging/windows`](packaging/windows). See [releasing](docs/RELEASING.md)
for the Windows setup, MSI, standalone, and portable builds.
