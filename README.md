<div align="center">

<img src="assets/icon/comet.svg" alt="Comet" width="128" height="128" />

# Comet

**A local-first workspace for notes and files.**

Point Comet at a folder on your computer. Your notes, boards and files stay
there as ordinary files — no account, no database, nothing to export.

[Download the latest release](https://github.com/MarchTheDev/Comet/releases/latest)

  <img width="1980" height="1080" alt="Comet_W1ymGj5cOo" src="https://github.com/user-attachments/assets/96b6ccd8-3150-4987-b792-1563de9092ab" />


</div>

## What it does

**Write:** Markdown that saves as you type, with a rich editor and a plain
source view when you want it.

**Organise:** Files and folders on disk, with list, gallery, tree and brain
views, plus tags, pins and favorites.

**Search:** Filenames, note contents and tags from one window (`Ctrl/Cmd + K`).

**Boards:** To-do boards and whiteboards that open beside your notes and save
straight into the folder.

**Read:** Images, a keyboard-driven audio and video player, PDFs, and EPUB
books in a built-in reader.

**Calendar:** A calendar for each workspace with events, notes and `.ics`
export, kept on this device.

**RSS:** Custom RSS, Atom and JSON feeds with custom names and icons, full-post
reading with images and tables, and OPML import/export.

**Tools:** Calculator, password generator, date calculator, percent and tax
calculator, and unit converter, all offline.

**Passwords:** an AES-256-GCM vault with a master password, recovery code and
encrypted backups.

**Make it yours:** 14 palettes plus System, interface scaling, a
width-adjustable sidebar and rebindable shortcuts.

**Stay out of the way:** Tray, launch at login, close to tray, and a workspace
that reopens where you left it.

## Install

| System | File |
| --- | --- |
| Windows 10/11 | `Comet-<version>-windows-setup.exe`, or the `.msi` |
| Linux (any distribution) | `Comet-<version>-x86_64.AppImage` |
| Debian, Ubuntu, Mint | `comet_<version>_amd64.deb` |
| Fedora, RHEL, openSUSE | `comet-<version>-1.x86_64.rpm` |
| Arch | `comet-<version>-1-x86_64.pkg.tar.zst`, with `pacman -U` |
| Any Linux, no package manager | `Comet-<version>-linux-portable.tar.gz` |

Windows 10 and 11 already have the WebView2 runtime Comet draws its interface
with. On Linux, install WebKitGTK 4.1 and a Secret Service provider (GNOME
Keyring or KWallet) for the password vault; each bundle's readme lists the
GStreamer packages needed for sound.

## Where your files live

Your notes and files stay in the workspace folder you choose — Comet never
moves them into a database. Tags, pins, favorites, calendar events, RSS feeds,
layout positions and shortcuts are kept in Comet's local profile
(`%LOCALAPPDATA%\com.comet` on Windows, `~/.local/share/com.comet` on
Linux), not in the files. The password vault is encrypted in that profile, and
a backup is only as safe as the password you give it.

## Layout

```
web/
  src/
    App.tsx                the workspace shell: explorer, editor, navigation
    SettingsPage.tsx       appearance, themes, shortcuts, updates
    ExploreViews.tsx       list, gallery, tree and brain views
    TodoBoard.tsx          to-do boards
    Whiteboard.tsx         whiteboards
    CalendarView.tsx       the local calendar
    RssView.tsx            custom RSS feeds and built-in article reader
    ToolsView.tsx          calculator, converters, date tools
    PasswordsView.tsx      the encrypted password vault
    utils/                 markdown, search, RSS parsing, storage and helpers
  src-tauri/
    src/lib.rs             filesystem commands, window and tray
    src/upload.rs          streamed file imports
    src/rss.rs             RSS, full-article fetching and OPML export
    src/link_preview.rs    link metadata and public URL checks
    src/password_backup.rs encrypted vault backups
    src/update.rs          the Windows and Linux update handoff
    tauri.conf.json        window, bundle and Linux packaging
  tests/                   front-end checks run by CI
packaging/
  linux/                   desktop entries, AppImage entry point, package checks
  arch/PKGBUILD            Arch package
  windows/                 installer artwork
assets/icon/               the icon source and its exported PNG
.github/workflows/         CI, checks and the draft-release build
```

## License

GPL-3.0. See [LICENSE](LICENSE).

The password generator's word list is the
[EFF Long Wordlist](https://www.eff.org/dice), used under CC BY 3.0 US. Icons
come from [Lucide](https://lucide.dev) and [Simple Icons](https://simpleicons.org).
