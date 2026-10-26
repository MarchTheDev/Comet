# Comet

A local first note taking app.

Comet is a desktop app for notes that live in a folder on your own machine.
Your notes are plain Markdown files on disk, Comet reads and writes them, and
nothing ever leaves that folder.

It is built the way a note taking app should be built: the vault is the file
system, the editor is a text file, and the preview is a rendering of the same
text. There is no database, no sync engine, no account.

## Status

Early. The first milestone is a working vault: open a folder, see the notes in
it, write one, preview it.

## Features

- **Local vault.** Pick a folder. Comet reads and writes Markdown files
  directly. Folders, notes, images, the lot.
- **Markdown notes.** Headings, lists, task lists, quotes, code blocks, rules,
  inline formatting.
- **Toggleable preview.** Edit and preview are the same text, rendered by the
  same parser.
- **Quick capture.** Save a link, a snippet, an important text, an image.

## Development

The app is a Tauri 2 project: a Rust backend for the file system, a React +
TypeScript front end bundled by Vite.

```sh
npm install
npm run tauri dev
```

## Releasing

See [docs/RELEASING.md](docs/RELEASING.md).
