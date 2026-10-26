# Comet

Comet is a local-first desktop app for notes, ideas, and everything in between.
Your workspace is a folder on your computer, and your notes are ordinary Markdown
files. There is no account, database, or built-in sync service.

## Features

- **A calm workspace.** A photographic Matterhorn cover, a searchable folder
  sidebar, an all-notes view, and a distraction-free focus mode.
- **Make it yours.** Dark appearance by default, with light and system themes,
  editor text size, spell check, and other preferences in Settings.
- **Local Markdown.** Create, edit, rename, and delete notes and folders directly
  in your chosen workspace. You can choose whether your last workspace and note
  are reopened when available.
- **Flexible editing.** Write with the formatting toolbar, edit plain Markdown,
  or switch to a read-only view. Changes save automatically.
- **Quick capture.** Send a thought, link, or image to your Inbox for later.
- **Search.** Find notes by filename or contents.

## Using the workspace

In the desktop app, open a folder to use as your workspace. Select **All notes**
to browse everything, or use the sidebar to navigate folders. Create a note
with **New note**. Use a folder's or file's `…` menu (or right-click it) to
create items inside a folder, rename, or delete. Deletion is permanent and does
not move files to the system trash; Comet asks for confirmation first. Renaming
or deleting files does not rewrite links in other notes.

The top path bar is editable. Enter a workspace-relative path such as
`Comet\Folder\text.md` (or `Comet/Folder/text.md`) and press Enter to open an
existing note or folder. For a new note, Comet asks for confirmation and creates
any missing parent folders; it never overwrites an existing file. You can omit
`.md` from a new note name. `Comet` is an alias for the current workspace, not
an absolute filesystem path; paths containing `..` or pointing outside the
workspace are rejected.

Open **Settings** in the sidebar to change the theme, Matterhorn cover, editor
size, spell check, or workspace reopening. Preferences are stored on this device
when local storage is available; resetting them does not delete notes.

Edits are saved automatically. If a save fails, the edit remains in the app and
can be retried. Comet also waits for pending saves before switching notes,
renaming or deleting items, or closing the desktop window.

Quick captures become Markdown notes in `Inbox`. Captured images are copied to
`assets` and linked using a relative path. Image capture requires a real desktop
workspace.

The browser development preview is a clearly labelled **sample workspace**,
not a view of local files. It is interactive and saves sample changes in browser
storage when available; clearing that storage removes the sample changes. Open
an actual folder in the desktop app to work with files on disk.

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + K | Search notes |
| Ctrl/Cmd + L | Focus the workspace path bar |
| Ctrl/Cmd + Shift + K | Quick capture |
| Ctrl/Cmd + N | New note |
| Ctrl/Cmd + \\ | Toggle sidebar |
| Ctrl/Cmd + S | Save immediately |

## Development

The app uses Tauri 2 for the desktop backend and React, TypeScript, and Vite for
the interface. Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
then run:

```sh
cd web
npm install
npm run tauri dev
```

For the interactive browser sample, run `npm run dev` instead. Run the utility
tests with `npm test` and create the production web bundle with `npm run build`.

## Releasing

See [docs/RELEASING.md](docs/RELEASING.md).
