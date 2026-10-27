# Comet

Comet is a local-first desktop workspace for notes and other files. Choose a
folder on your computer; Comet works with the files there without an account or
a built-in sync service.

## Workspace

- **Organize your files.** Browse all files, folders, pins and favorites. Use the
  list or gallery layout and the size slider to adjust file icons. Create files
  and folders or upload files from the `+` menus, or right-click the workspace or
  an item for more actions.
- **Move and arrange.** Drag an item onto a folder to move it, or drag between
  siblings in the sidebar to change their display order. Drop files from your
  computer onto a folder or the workspace to import copies. Existing files are
  not intentionally overwritten; renames, moves, and imports reject collisions.
  Moving or renaming does not rewrite links in other notes.
- **Tags and search.** Manage tags from the sidebar and attach them to files or
  folders through an item's menu. Search filenames, supported text contents,
  and tags in the central search window; prefix a tag name with `#` to narrow
  the results.
- **Multiple workspaces.** Use the workspace dropdown to add or switch folders.
  Removing a workspace from this list does not delete its files.
- **Appearance.** Comet starts in dark mode. Settings offers light and system
  themes, an optional ASCII Matterhorn background, editor size, spell check,
  and reopening the last workspace.

Tags, pins, favorites, sidebar ordering, remembered workspaces, and preferences
are stored in Comet's local webview storage on this device, **not in the files**.
They survive moves and renames performed in Comet, but do not travel with the
vault to a different device or follow an externally moved vault folder. Back up
your workspace files independently. If local storage is unavailable, these
preferences last only for the current session.

## Files and editing

Names without an extension default to `.md`; names with an extension keep it.
Markdown opens in the visual editor, source editor, or read-only view. Known
UTF-8 text files such as `.txt`, `.json`, and `.csv` open in a plain-text editor.
Text editing is limited to 16 MB in the desktop app. Images, audio, and video
open in a preview or player; playback depends on the codecs available on the
system. Unknown formats are not automatically decoded as text: open them with
the system app or explicitly try UTF-8 text editing. Invalid UTF-8 and files
containing NUL bytes are rejected for text editing.

The visual Markdown toolbar includes headings, sizes, color, highlighting,
links, lists, and other formatting. Markdown has no standard text-size or color
syntax, so Comet stores these as inline HTML spans. Highlighting uses HTML
`<mark>` tags and underlining uses extension syntax. Other Markdown applications
may display them differently.
For documents containing unsupported Markdown/HTML constructs, use **Markdown**
source mode to avoid visual-editor normalization.

The centered path bar accepts workspace-relative paths such as
`Comet\Folder\text.md` or `Comet/Folder/text.txt`. Press Enter to open an
existing file or folder, or confirm creation of a new file and any missing
folders. `Comet` is an alias for the current workspace; absolute paths and
`..` traversal are rejected.

Quick capture (`+` at the top) saves a new Markdown file in the destination
folder you choose. An image capture copies the image into that same folder and
links it relatively; image capture requires a desktop workspace. YouTube links
in Markdown are offered as playable embeds, but no video is loaded and no
connection to YouTube is made until you choose **Load video**.

Edits save automatically. If a save fails, the edit remains in the app and can
be retried. Comet waits for pending saves before switching notes or workspaces,
moving, renaming, deleting, or closing the desktop window. Deletion requires
confirmation and is permanent; it does not use the system trash.

The browser development preview is an interactive **sample**, not a view of
local files. Sample data is saved in browser storage when possible; large media
can exceed the storage quota, in which case changes are temporary. The sample
file picker accepts files up to 20 MB; the desktop app imports files directly.
Clearing browser storage removes sample data.

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + K | Search files, contents, and tags |
| Ctrl/Cmd + L | Focus the workspace path bar |
| Ctrl/Cmd + Shift + K | Quick capture |
| Ctrl/Cmd + N | New file |
| Ctrl/Cmd + \\ | Toggle sidebar |
| Ctrl/Cmd + S | Save immediately |

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
