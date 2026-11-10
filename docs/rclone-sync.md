# Scoped cloud workspace sync

> **Historical design only — not available in Comet 1.0.** Cloud settings and
> workspace sync are currently disabled. Comet 1.0 does not register these
> commands or bundle rclone, and no background sync runs. Existing local files,
> remote history, and stored authorization are not deleted. The instructions
> below describe an earlier preview and must not be used as current user guidance.

Comet can optionally use its bundled rclone transport for **Google Drive** and
experimental **iCloud Drive**. This is not a verified backup system: keep
independent backups and start with non-critical data. Automated tests use a
local rclone backend and simulated devices; they do not prove real Google or
Apple authorization, real multi-device behavior, installed Windows behavior,
long offline periods, quota handling or 2FA renewal.

## Connect

Open a local workspace and go to **Settings → Cloud**:

- **Google Drive** opens a browser sign-in with rclone's `drive.file` permission;
  no client ID or cloud project is entered in Comet. If there is no existing
  text-sync workspace, Comet asks in an in-app dialog before this workspace's
  files are uploaded. Saved workspaces are discovered automatically; choose
  **Open on this device** to import one into a new folder. An unrelated local
  folder is never silently joined. Sign-in can be cancelled. Google account identity and workspace history are checked before
  resuming a previously linked folder.
- **iCloud Drive** is experimental. It uses the regular Apple ID password and
  two-factor authentication, not an app-specific password. Enable Apple's
  **Access iCloud Data on the Web**; Advanced Data Protection may require a
  trusted-device approval. Sessions may expire and require another sign-in.
  Select the account and choose **Start automatic sync**, or open a cloud
  workspace on this device.
- **Disconnect** removes local provider authorization, not cloud files or their
  history. Google Calendar is not connected by this feature; Comet's calendar
  remains local-only.

**Google limitation:** [rclone says its shared Google client will stop working
in 2026](https://rclone.org/drive/#making-your-own-client-id). The exact cutoff
has not been confirmed here. The browser-only connection may stop working;
there is no guarantee of permanent authorization or uninterrupted access. A
long-term replacement needs a different OAuth arrangement. Do not place any
password, token or client credential in GitHub, support messages or chat.

## What is synced

Supported UTF-8 text, Markdown (`.md`, `.markdown`), to-do boards
(`.comet-todo`) and whiteboards (`.comet-whiteboard`) are included. The text
extensions are the same ones Comet recognizes for editing, including common
formats such as `.txt`, `.csv`, `.json` and source code, and extensionless text.
Unsupported extensions, web-link files, separate images, audio, video, PDFs and
ebooks are excluded; empty folders and `.git`, `.hg` and `.svn` directories
are not synced. Links in a synced note to excluded local files may not work on
another device. Files named like text but containing non-UTF-8 or NUL bytes stop
sync with an error instead of silently disappearing from the cloud baseline.

**Whiteboards can embed images as data in the board file.** Such images—and
any embedded data in text—are included when the containing file is synced,
even though separate media files are excluded. Check the content before opting
in. The local password vault, settings, calendar, tags, pins and other workspace
organization data are not synced.

## Readable copies

The synced revision history is stored as opaque objects with generated names so
that it cannot be edited by accident. For people browsing their provider, Comet
also mirrors synced text in a normal folder named after the workspace, directly
beside that internal history:

```
Comet-Sync/My notes/Project/plan.md
Comet-Sync/My notes/tasks.comet-todo
```

The first sync (or the first sync after upgrading) copies every eligible file.
Later revisions copy only changed files and update those paths in place, keeping
your original folder structure and filenames. There are no per-sync dated
folders.

- Edits you make to these readable files are **not** imported back; the opaque
  history remains authoritative.
- Before Comet replaces a readable file whose content no longer matches what it
  last wrote, it keeps the existing file beside the new one, for example
  `plan (Comet preserved 2026-10-26 10-00-00 UTC).md`.
- Deleting a file in the workspace does not delete its readable copy.
- The folder is claimed with a hidden `.comet-sync-workspace.json` marker. If a
  different workspace already uses that name, Comet uses
  `My notes (abc123)`; a non-empty folder without the marker is never adopted.
- Older `Comet Files` folders from earlier versions are left untouched. The
  `Comet-Sync/text-v2` folder is Comet's internal history and must not be
  edited or deleted manually.
- Copies are not end-to-end encrypted and do not include excluded media.

If the authoritative sync succeeds but updating its readable copies fails, Comet
keeps the saved baseline, shows a warning rather than claiming success, and
retries with backoff. A warning therefore does not mean the synced originals
were lost.

Comet stages and verifies files individually; it does not pack the entire
workspace into the former 128 MiB in-memory archive. There is a **16 MiB
per-text/board-file limit**, matching the editor, a 20,000-file limit and an
8 MiB manifest limit. Oversized or unreadable eligible files stop that sync
attempt with an error; local files are preserved. Unrelated large media does not
count toward those text limits.

## Safety and privacy

- Changes are saved locally first. While Comet is open, saves and tree changes
  schedule a check; periodic checks notice external changes. Offline work stays
  local and retries when connected. On full quit Comet flushes edits and makes a
  bounded final sync attempt; if it cannot finish, the user decides whether to
  quit. A fully closed application cannot continue syncing.
- rclone is only a transport: Comet does **not** use `rclone sync`, `bisync` or
  mirroring. Each changed file is an immutable, hash-verified blob. Manifests
  and commit markers form a revision DAG so simultaneous devices cannot replace
  each other's revisions. Three-way merge preserves concurrent edits as conflict
  copies. A remote change or deletion replaces/removes a local file only when
  the local content still matches the common ancestor; the original is moved to
  a safety folder beside the workspace first. Excluded local media and folders
  are never interpreted as remote deletions. Damaged or missing history stops
  sync; a failed publication does not advance the stored baseline.
- Text sync uses a **new remote namespace and local binding key**. Earlier
  full-workspace histories, bindings and credentials are not migrated, resumed
  or deleted. Old history may contain media and can still use cloud storage.
  History is not pruned automatically; interrupted uploads may leave unreferenced
  objects. Do not manually delete revision objects. Do not run other folder-sync
  engines against the same workspace.
- Comet does **not** end-to-end encrypt synced content, filenames, manifests
  or its temporary local staging cache. Providers receive the plaintext content.
  Temporary files are removed on normal completion/abort but a crash may leave
  them in the app cache. Notes or other text deliberately placed in the workspace
  can contain sensitive information; review them before connecting.
- rclone's provider configuration, including an iCloud password/session or
  Google refresh token, is encrypted from the first save. Its random encryption
  key is held in the operating-system credential store; Comet refuses cloud
  access if that store is unavailable. The rclone remote-control process is
  authenticated, loopback-only, and terminated with Comet on Windows/Linux.
  Credentials are not placed on the command line or deliberately logged.

## Recovery and provider limits

- Comet verifies every revision it downloads and caches those manifests
  locally, so a periodic check lists the history instead of re-downloading it.
  Provider throttling is retried inside the connection, and a rate-limited
  sync waits longer before the next scheduled attempt.
- If a commit marker is missing (for example, an interrupted publication or a
  provider that listed the revision late), Comet adopts the verified revision
  and repairs the marker instead of failing every later sync.
- If this device's saved baseline revision no longer exists, Comet reconnects
  to the newest cloud revision without assuming a shared ancestor: cloud files
  are imported, differences are kept as conflict copies, and the result is
  published with that revision as its parent. The detail text reports that the
  link was rebuilt.
- A damaged or cyclic history, a missing content object or a failed verification
  still stops the sync with an error rather than guessing. Local files and the
  cloud's existing objects are never deleted by repair.

## Packaging and development

The Windows release workflow downloads the official rclone v1.75.2 AMD64 ZIP,
checks a pinned SHA-256, and embeds the extracted executable in Comet. Missing
or mismatched release bundles fail the build. Its MIT license is in Settings;
no binary is committed to this repository. Runtime extraction verifies the
embedded bytes.

For development, set `COMET_RCLONE_BIN` before compiling to embed a verified
platform binary, or `COMET_RCLONE_DEV_BIN` for a debug build. A manually built
release on another platform must supply its matching verified binary.
`COMET_REQUIRE_BUNDLED_RCLONE=1` makes a missing bundle a build error. Rust CI
uses a separately verified Linux rclone with a temporary local alias and fake
authorization data; it does not sign in to a real provider account.
