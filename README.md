# Comet

Comet is a local-first desktop workspace for notes and other files. Choose a
folder on your computer; Comet works with the files there without an account or
a built-in sync service.

## Workspace

- **Organize your files.** Browse all files, folders, pins and favorites. Use the
  list or gallery layout and the size slider to adjust file icons. Create files
  and folders or upload files from the `+` menus, or right-click the workspace or
  an item for more actions.
- **Move and arrange.** Drag an item onto a folder to move it, or use the drag
  handle in the sidebar to arrange siblings. Drop indicators show where an item
  will go. Drop files or web links on a folder or workspace to add them. Dropped
  files are limited to 20 MB; use **Upload files** for larger files in the desktop
  app. Renames, moves, and imports reject collisions; moving or renaming does not
  rewrite links in other notes.
- **Select and delete.** Ctrl/Cmd-click toggles items, and Shift-click selects a
  range, in either the sidebar or the file list. Use the trash button to review
  and permanently delete the selection. Escape or the X clears it. A selected
  folder includes its descendants; failures are reported individually.
- **Explore.** Tree view displays the folder hierarchy. Brain view shows up to
  150 items as an interactive network: solid lines represent folder membership,
  and dotted lines represent links between Markdown notes. It reads only the
  first 256K characters of the first 120 Markdown notes for connections, with a bounded
  number of reads at a time; binary files are never scanned as text.
- **Tags and search.** Manage tags from the sidebar and attach them to files or
  folders through an item's menu. Search filenames, supported text contents,
  and tags in the central search window; prefix a tag name with `#` to narrow
  the results.
- **Multiple workspaces.** Use the workspace dropdown to add or switch folders,
  customize the current workspace's display name and icon, or open a remembered
  folder in your system file explorer. Removing a workspace from the list does
  not delete its files or rename its folder.
- **Navigation and appearance.** Use the back/forward arrows, mouse side
  buttons, or keyboard shortcuts to revisit places. Comet starts in dark mode;
  Settings also offers light, system, emerald, rubellite and navy themes, editor
  size, spell check, and reopening the last workspace. The Matterhorn photo is
  always subtly visible behind the workspace.

Tags, pins, favorites, sidebar ordering, workspace names and icons, remembered
workspaces, keyboard shortcuts, and preferences are stored in Comet's local
webview storage on this device, **not in the files**.
They survive moves and renames performed in Comet, but do not travel with the
vault to a different device or follow an externally moved vault folder. Back up
your workspace files independently. If local storage is unavailable, these
preferences last only for the current session.

## Files and editing

Names without an extension default to `.md`; names with an extension keep it.
Markdown opens in the visual editor, source editor, or read-only view. Known
UTF-8 text files such as `.txt`, `.json`, and `.csv` open in a plain-text editor.
Text editing is limited to 16 MB. Images, PDFs, audio, and video open in a preview or player; playback depends on the codecs available on
the system. PDF rendering uses locally bundled PDF.js resources. Unknown
formats are not automatically decoded as text: open them with the system app or explicitly try UTF-8 text editing. Invalid UTF-8 and files
containing NUL bytes are rejected for text editing.

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

Create a **to-do board** from the New menu. A `.comet-todo` file stores multiple
named, colored lists, tasks, expandable task notes, and directional workflow
connections in your workspace; it autosaves like a note. Lists and connections
can be changed, and tasks can move between lists. Comet refuses to automatically
edit an invalid or newer board format rather than discarding unfamiliar data.

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

The app uses Tauri 2, React, TypeScript, and Vite. Install the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then:

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
