# Comet

Comet is a local-first desktop workspace for notes and other files. Choose a
folder on your computer; Comet works with the files there without an account.
Google Calendar and on-demand two-way Google Drive workspace sync are optional.

## Workspace

- **Organize your files.** Browse all files, folders, pins and favorites. Use the
  list or gallery layout and the size slider to adjust type-specific file icons.
  Create files, folders, to-do boards and whiteboards, or upload files from Quick
  Capture, a `+`, folder or background menu. File menus contain actions for that file only.
- **Move and arrange.** Drag an item onto a folder to move it. In the sidebar
  or Tree view, drop above or below another item to place it there—even when
  that moves it into a different folder. A grouped outline highlights the
  destination folder and its visible contents. The **Move to** menu provides a searchable folder picker that also shows files
  beneath expanded folders (only folders can be selected as destinations).
  Drop files or web links on a folder or workspace to add them. Desktop file
  imports have no Comet-imposed size limit; available disk space still applies.
  Renames, moves and imports reject collisions; moving or renaming does not
  rewrite links in other notes.
- **Select and delete.** Ctrl/Cmd-click toggles items, and Shift-click selects a
  range, in either the sidebar or the file list. Use the trash button to review
  and permanently delete the selection. Click blank space, press Escape, or use
  the X to clear it. A selected folder includes its descendants; failures are
  reported individually. A plain click opens an item without adding it to the
  selection. When Ctrl/Cmd-clicking another item after a plain click, the opened
  item joins the group. Drag a selection to move or reorder it together; if a collision
  interrupts a batch, remaining items stay in place.
- **Explore.** Expand the root and folder nodes in the left-to-right Tree view
  to reveal files. Brain view shows up to 150 items as a network: click a folder
  node to reveal or hide its children, drag the background to pan or a node to
  arrange it, and click a file to open it. Nearby nodes react while dragging
  and settle back without their temporary movement being saved. Newly revealed
  files appear near their folder; manually moved positions are saved on this
  device. Right-click a node for actions such as Open, Move, Rename and Delete.
  Use Ctrl/Cmd + scroll to zoom. **Reset layout** clears saved positions only
  after confirmation (useful for layouts saved by an older version).
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
  theme by default; Settings also offers dark, light, emerald, rubellite, navy,
  plus Light (coral), Blue, Sakura, Matcha, Ember, Gothic, Frog, Nightjar and
  Onyx palettes based on the live [0807 project](https://0807.st/), app and interface-text
  scaling, editor size, spell check, to-do
  arrowheads, and reopening the last workspace. Scaling applies when a dragged
  slider is released. Drag the sidebar's right edge to change its width; the
  width is remembered on this device. The Matterhorn photo is always subtly
  visible behind the workspace.
- **Calendar.** Open Calendar from the sidebar to view a month, select a day,
  and add, edit, or delete events with an optional time and notes. Click the
  month or year to browse, or jump directly to any year from 1 to 9999. Each workspace has its
  own calendar in the local app profile. Export local events as `.ics`; local
  events are not part of the workspace files. Optionally connect your primary
  Google Calendar in Settings → Cloud: its events are read on opening, changing
  month, or pressing Refresh, and Google events can be created, edited, or
  deleted online. Choose whether new events are local or Google; use the cloud
  button to explicitly move an existing local event to Google. Existing Google
  events retain fields Comet doesn't edit, and conflicting changes are rejected.
  New timed events last one hour; recurring edits affect one occurrence. There
  are no reminders or background/offline synchronization.
- **Desktop startup and tray.** In Settings, independently choose launch at
  system login, start in the system tray, and close to the tray. Open Comet from
  the tray icon or its menu; use **Quit Comet** in that menu to exit. Re-launching
  Comet restores an existing tray-resident window. If a tray can't be created,
  Comet falls back to showing its window. A Linux desktop needs a compatible
  tray host; re-launching Comet also restores the window. These controls are
  desktop-only; reset preferences does not change system-login registration.
- **File explorer.** Use an item's context menu or the folder button beside the
  path bar to show files and folders in the system file explorer. The workspace
  dropdown can also open a remembered workspace folder.

Tags, pins, favorites, sidebar ordering, brain-node positions, workspace names
and icons, remembered workspaces, keyboard shortcuts, calendars, and preferences
are stored in Comet's local webview storage on this device, **not in the files**.
They survive moves and renames performed in Comet, but do not travel with the
vault to a different device or follow an externally moved vault folder. Back up
your workspace files independently. If local storage is unavailable, these
preferences last only for the current session. Calendar saves are refused when
storage is unavailable or the stored calendar is unrecognized, rather than
silently overwriting existing events. Export calendars separately before
clearing app storage or moving to another device.

## Files and editing

Names without an extension default to `.md`; names with an extension keep it.
Markdown opens in the visual editor, source editor, or read-only view. Known
UTF-8 text files such as `.txt`, `.json`, and `.csv` open in a plain-text editor.
Text editing is limited to 16 MB. Images, PDFs, audio and video open in a preview
or player; EPUB books open in a built-in reader with page-by-page buttons and
arrow keys, a section selector when the book supplies a table of contents,
saved position, font/spacing controls and page colors. Existing bookmark data is left on the device, although bookmark controls are not shown.
EPUB scripts and remote resources are blocked; DRM-protected books are unsupported. Playback depends on the codecs available on the system. Unknown
formats are not automatically decoded as text: open them with the system app or
explicitly try UTF-8 text editing. Invalid UTF-8 and files containing NUL bytes
are rejected for text editing.

PDFs use locally bundled PDF.js resources. Choose single- or two-page layout,
fit pages to the available width, drag to pan, and use the zoom buttons or
Ctrl/Cmd + scroll, or type a percentage; zoom follows the page position under the cursor and keeps the
previous page visible while the sharper version renders. The custom
video controls include seeking, volume, playback speed and fullscreen. The audio
player shows embedded title, artist and cover art when available, a sound-driven
visualizer, a fullscreen player, and a volume slider that responds to the mouse
wheel. In the focused player, Space toggles playback, Left/Right seek by ten
seconds, Up/Down adjust volume, M mutes, and F toggles fullscreen. Keyboard shortcuts do not intercept
text fields or dialogs.

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

Quick capture (`+` at the top) saves text as a new Markdown file, a web link
as a standard `.url` shortcut, or copies selected files into a destination chosen
from a folder tree. Drop files onto the file capture box or click it to browse.
The uploader shows the current file and completed count; dropped desktop files
show measured progress, while system copies are indeterminate. Desktop uploads
stream in bounded chunks and are staged before no-overwrite publication. If the
app is interrupted, a clearly named `.comet-upload-…part` file can remain; after
confirming no import is running, remove it before syncing. The browser sample
uses localStorage and is constrained by the browser's storage and memory quota;
it warns when files cannot be persisted. An image capture copies
the image into that same folder and links it relatively; image capture requires
a desktop workspace. Dropped links also become shortcuts; they do **not**
download videos. YouTube and direct video links in Markdown automatically show
players immediately below their links in Write and Read views (up to 50 per
note). Opening such a note or shortcut connects to YouTube or the video host;
YouTube uses the `youtube-nocookie.com` embed domain. Only validated HTTP(S)
links are used. Markdown source view remains plain text.

Create a **to-do board** from the New menu. A new `.comet-todo` file is a blank,
autosaving canvas: add tasks, use **Add item** for independently checkable
entries within a task, drag card top bars to arrange them, and assign colored
categories from expanded details. Right-click a card or use its options button
for more actions. Hover a task to reveal its connection dot (always visible on
touch devices), then drag it onto another task. Click a connection to change its
color or remove it; click blank canvas to deselect it. Connections have no arrowheads by default; enable them in
Settings if wanted. Drag the canvas to look around, or use its zoom controls and
Ctrl/Cmd + scroll.

Create a **whiteboard** from the New menu for a separate `.comet-whiteboard`
canvas. Add text boxes, to-dos, shapes and images (PNG/JPEG/GIF/WebP up to 2 MB
apiece), choose a shape and drag on blank canvas to size it, or use the pen for
freehand strokes. Shapes start transparent; use the fill button in a shape's
hover menu to fill it. Cards remain selectable above shapes. Drag an item's top
bar to move it, its invisible bottom-right corner to resize it (arrow keys work
when the corner is focused), or its dot to connect it to another item. Select a connection to change its color or remove
it. Clicking blank canvas clears focus; drag blank space to pan or use the zoom
controls. Version 1 whiteboards open without being rewritten and migrate to
version 2 on the first edit. Shapes smaller than 160 × 110 use version 3; filled
shapes use version 4. Older builds safely reject formats they cannot preserve.
Older versions of Comet may not understand edited version 2–4 boards. Boards autosave
in the workspace; unknown or damaged formats are not overwritten.

Existing version 1 and version 2 to-do boards open without being changed on disk.
On the first edit they migrate to version 3, preserving tasks, notes, categories and
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
can exceed the browser storage quota, in which case imports may be rejected or
changes may be temporary. Desktop drops and file-picker imports are limited by
the filesystem and available disk space rather than a fixed Comet file-size cap.
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

## Passwords and cloud connections

The Passwords view stores an AES-256-GCM encrypted vault in this device's app
profile. Its master key is derived using PBKDF2-SHA256 with 600,000 iterations;
the master password is not stored. The vault locks when you leave the view, hide
the app, or after five minutes of inactivity. Manage recovery, the master
password, encrypted backups, site icons, and device-vault reset in **Settings →
Passwords**. To reduce lockout risk, choose **Set up recovery**, confirm the master password, and save the
random recovery code somewhere separate and safe before enabling it. The code
can reset a forgotten master password; anyone with the code and an encrypted
vault or backup can unlock its contents. **The code alone cannot restore a lost
vault**: use Backup to save an encrypted copy. New recovery settings do not
change earlier backups, which retain their original password and recovery code.
To change the master password, choose **Change master password** in Settings and
verify with either the previous master password or recovery code; entries are preserved. If recovery was enabled,
Comet presents a new recovery code to save before committing the change. Old
backups retain their previous password and recovery code. If both the password
and recovery code are lost, Settings offers an explicitly confirmed reset
that permanently erases this device vault (not exported backups); the old
passwords cannot be recovered without a usable backup and its password or code.
Site icons load automatically, sending site domains (not usernames or passwords)
to Google's favicon service; the option can be disabled in Passwords settings.
Comet's vault has not been independently security-audited and is not a replacement for an audited password manager. It
has no autofill or cloud sync and is not included in Drive revisions.

In **Settings → Cloud**, a single Google connection uses the system browser and
Desktop OAuth with PKCE for both Calendar events and Comet-created Drive files.
Tokens and any configured client secret are kept in the OS credential store
(Linux requires a working Secret Service). A build needs a **registered Google
Desktop OAuth client** before the Connect button works without setup. No such
client is included in this source tree: the project owner must enable the
Calendar and Drive APIs, configure the consent screen and any test users, and
provide the public desktop client ID and optional desktop client secret at build
time (see `docs/RELEASING.md`). End users do not need to register their own
client when the project owner has configured the build: they click Connect and
sign in on a Google browser page. In an unconfigured build, the advanced fields
also allow an existing Desktop OAuth client. Desktop client configuration is
public, not a way to keep a secret. Use the same Google account and OAuth client
on each device. Reconnect if Google revokes or expires authorization. Disconnect
removes local credentials; revoke access in your Google account to remove the
grant itself. No Google account or network is needed for local use.

**Workspace sync is on demand, not continuous background sync.** With Google
connected, choose **Start syncing this workspace** on the first device. On another
device choose **Import on this device**, which creates a separate local workspace,
then use **Sync now** on each device after changes and before switching devices.
Comet uses immutable, checksummed Drive revisions and a three-way merge: changes
on both sides are kept, conflicting remote files receive a named conflict copy,
and replaced or deleted originals are moved into a visible `Comet sync safety …`
folder next to the workspace. A failed operation reports any safety folder. The
app blocks editing while a sync is running, but other applications may still
change files; close external editors during sync. Keep independent backups and
inspect conflicts before deleting them. The older **Upload current workspace**
and **Import as new** snapshot actions remain available under Older manual
backups, and never replace an existing workspace.

Drive revisions are uncompressed and **not encrypted by Comet**. They include
workspace files, potentially sensitive notes and media; local-only calendars,
passwords, preferences, and organization metadata are excluded and must be
backed up separately. Each revision is limited to 128 MB and 20,000 items, even
though local file imports have no fixed Comet size cap; large workspaces cannot
currently be synced this way. Symbolic links and nonportable paths are refused. Comet currently lists at most
2,000 sync revisions per account/client, and does not automatically prune
history. Removing revisions can break merge ancestry, so keep independent backups
and avoid deleting them while using sync. Real Google account, operating-system
credential-store and multi-device behavior should be verified in your own setup
before relying on this feature.

On desktop, Comet checks published GitHub releases at startup and offers Later or
an Updates page in Settings. On Windows, a user-initiated action downloads the
official setup, checks the SHA-256 digest provided by GitHub and opens the
installer; it does not silently replace the app. That digest is not an
independent signature, and portable users should replace their copy manually.
Other platforms use the release page. Draft releases are never offered.

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
