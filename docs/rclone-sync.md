# Rclone cloud workspace sync (preview)

Comet can use the **bundled rclone transport** for iCloud Drive (experimental)
and an already connected Comet Google Drive account. Calendar remains a Google
feature and has its own authorization; rclone does not provide Calendar or
bypass Google OAuth. No separately installed rclone client is needed in the
Windows release. No user's cloud password or token belongs in GitHub, release
variables, support messages, or chat.

## Before using it

This is a **preview**, not a verified production backup system. The local test
suite uses rclone's local filesystem backend and simulated scenarios; real
Apple/Google accounts, real multi-device synchronization, installed Windows,
quota, long offline periods, 2FA expiration, and failure recovery still need
hands-on testing. Keep an independent backup and start with non-critical data.

In Settings → Cloud:

1. For iCloud, choose **Connect iCloud Drive**. Apple's **Access iCloud Data on
   the Web** setting must be enabled. rclone's iCloud Drive backend is
   experimental and uses the *regular Apple ID password* plus two-factor
   authentication, not an app-specific password. A trusted session typically
   lasts around 30 days; reauthentication may be needed. Advanced Data Protection
   is supported by current rclone, but approval on a trusted device can be needed.
   This is iCloud Drive, not the read-only iCloud Photos backend.
2. For Google Drive, connect the Comet Google account below, then choose **Use
   connected Google Drive**. A release must have the publisher's OAuth client
   configured for one-click Google sign-in; end users should not need to register
   their own cloud project. Rclone is not a Google authentication bypass. Google
   Testing-mode refresh tokens for these scopes can expire after seven days,
   and Google's policies/revocation still apply; switching transport does not
   remove that restriction. Calendar permissions remain separate from rclone.
3. Open a local workspace and choose **Start automatic sync**, or select an
   account and **Find cloud workspaces** → **Open on this device**. Import
   creates a new local folder rather than overwriting an existing one. To
   reconnect iCloud, use the same Apple ID; the new local session can resume the
   existing binding. Disconnect removes local authorization, not cloud history.

The previous direct Google Drive automatic and manual histories remain separate
and untouched. Starting rclone sync creates a new history; it does not migrate
old revisions. Pause the previous automatic engine before enabling rclone, and
vice versa. Do not run other folder-sync engines against the same workspace.

## Synchronization and privacy

- Local saves happen first; a successful save or tree change schedules a
  debounced check. Comet also checks periodically while running, including in
  the tray. Offline changes remain local and are compared again after recovery
  and restart. On a full quit Comet flushes local edits and makes a bounded final
  cloud attempt; if it cannot complete, the user chooses whether to quit. A
  fully closed application cannot continue syncing.
- This protocol uses rclone as a transfer engine, **not** `rclone sync`,
  `bisync`, or a mirror. Content objects and revision manifests have random
  immutable names; a zero-byte commit marker is uploaded only after the
  manifest and changed content have been verified. Separate heads form a DAG.
  Comet performs a guarded three-way merge, creates keep-both conflict copies,
  and moves replaced/deleted originals into a safety folder beside the local
  workspace. Missing or damaged history/objects stop the sync before applying
  them. Interrupted uploads can leave unreferenced objects; cloud history is
  deliberately not pruned automatically. Do not delete its objects manually.
- Incoming changes are applied only after buffered edits are flushed and the
  editor is guarded; open files are refreshed. Cloud and older direct-Drive
  sync are not allowed to be active for the same workspace. Status and errors
  are visible; a failure does not advance the saved baseline.
- The preview still uses the checked in-memory archive: **128 MiB and 20,000
  items per workspace**, with an 8 MiB manifest limit. Larger dropped files can
  be imported locally, but the workspace will not sync until within this limit.
  Streaming large workspaces is unfinished. Keep independent backups.
- Comet does **not** end-to-end encrypt workspace content, filenames,
  manifests, or its disposable local archive cache. The cloud provider receives
  the content. The device-local password vault, local calendar and settings are
  excluded; a user deliberately putting an exported vault backup or other
  sensitive file inside the workspace causes it to be included like any file.
- The provider configuration (including the iCloud password and session or
  Google refresh token) is encrypted by rclone from its first save. The randomly
  generated encryption key is held in the operating-system credential store.
  If the credential store is unavailable or the key is missing, Comet refuses
  cloud access rather than falling back to a plaintext config. Rclone's
  short-lived remote-control process is authenticated, loopback-only, given
  random credentials, and terminated on normal exit (with parent-death protection
  on Windows/Linux); no Apple password or Google
  token is put on a command line or deliberately logged. Provider metadata may
  also be stored in rclone's local cache. OS-account security still matters.
- The Google account may only see `drive.file` data created by the same
  publisher OAuth client. Different client IDs or a different account can make
  existing history unavailable; Comet stops rather than silently replacing it.

## Packaging and development

The Windows release workflow downloads the official rclone v1.75.2 AMD64 ZIP,
checks its pinned SHA-256, extracts the executable and embeds it in the Comet
binary; an absent/mismatched bundle fails the release. Rclone's MIT license is
included in Settings. At runtime the executable is extracted to Comet's local
app-data folder and checked against the embedded bytes before use. No binary is
committed to this repository.

For local development, either set `COMET_RCLONE_BIN` to a verified platform
binary before compiling (to embed it), or set `COMET_RCLONE_DEV_BIN` when
running a debug build. A non-Windows manually packaged build needs its matching
binary. `COMET_REQUIRE_BUNDLED_RCLONE=1` makes a missing compile-time binary a
build error. The Rust CI contract test uses a separately downloaded, verified
Linux rclone and a temporary local alias; it does not contact a cloud account.
