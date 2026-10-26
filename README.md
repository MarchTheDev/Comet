# Comet

A local first note taking app.

Comet is a desktop app for notes that live in a folder on your own machine.
Your notes are plain Markdown files on disk, Comet reads and writes them, and
nothing ever leaves that folder.

It is built the way a note taking app should be built: the vault is the file
system, the editor is a text file, and the preview is a rendering of the same
text. There is no database, no sync engine, no account.

## Features

- **Local vault.** Pick a folder. Comet reads and writes Markdown files
  directly. Folders, notes, images, the lot.
- **Markdown notes.** Headings, lists, task lists, quotes, code blocks, rules,
  inline formatting.
- **Toggleable preview.** Edit and preview are the same text, rendered by the
  same parser.
- **Quick capture.** Save a link, a snippet, an important text, an image.
- **A quieter workspace.** An ASCII-inspired interface with an offline Matterhorn
  backdrop, collapsible folders, search, and write, source, and read views.

## Using the workspace

Open a local vault in the desktop app, then select or create a Markdown note.
Edits save automatically. The browser development preview starts in a clearly
labelled sample workspace instead; its sample notes are stored in browser
storage, not in a folder. Open a real folder from the desktop app to work with
files on disk.

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + K | Search notes |
| Ctrl/Cmd + Shift + K | Quick capture |
| Ctrl/Cmd + N | New note |
| Ctrl/Cmd + \\ | Toggle explorer |
| Ctrl/Cmd + S | Save immediately |

Use the `+` beside a folder (or its context menu) to create items inside it.
Quick captures go into `Inbox`; captured images are copied into the vault's
`assets` folder and linked with a relative Markdown path.

## Development

The app is a Tauri 2 project: a Rust backend for the file system, a React +
TypeScript front end bundled by Vite.

```sh
npm install
npm run tauri dev
```

## Releasing

See [docs/RELEASING.md](docs/RELEASING.md).
