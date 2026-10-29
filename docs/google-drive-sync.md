# Google Drive workspace sync

This page describes the earlier **direct Google** integration. For the newer browser-only rclone Drive connection and experimental iCloud Drive support, see [rclone sync](rclone-sync.md). Direct Drive histories remain unchanged and are not migrated automatically; a different `drive.file` OAuth client may not be able to see them.

## What is implemented

Comet has a **preview** of automatic, file-level Google Drive sync. After the user opts in for a local workspace, Comet checks for changes while it is open (including in the tray), normally every 30 seconds, and retries after connection errors with backoff. Local files remain usable offline; when the app and connection are available again, the current local state is compared with the last saved baseline. Nothing syncs while Comet is fully closed.

The app uploads immutable file-content blobs and a small, immutable workspace manifest. Unchanged content is reused from the previous manifest, so a routine sync does not upload the entire workspace. An app cache of verified baseline data avoids repeatedly downloading unchanged files; when it is missing, Comet reconstructs the baseline from Drive. A manifest is published only after its new blobs have uploaded. Separate concurrent revisions form multiple heads and are merged using a common ancestor. Conflicting file edits are kept as separate files. Before replacing or deleting an unchanged local file, Comet rechecks it and moves the original into a safety folder beside the workspace; new files use staged, no-replace writes. Unsafe paths, links, duplicate case-insensitive names, damaged data and incomplete revision histories stop sync without silently replacing changed local files.

Network preparation, upload and local-only captures occur without blocking the editor. Before applying incoming changes, Comet waits for active gestures or typing to settle, briefly blocks editing, flushes pending saves and refreshes any open file that changed. Sync status, recent device-only activity (including safety-folder locations) and a retry button are available in Cloud settings; the top bar also shows the workspace status. Pause affects only this device.

### Important limitations

- **Preview, not yet verified with real Google accounts.** The automated tests cover local merge safety and simulated Drive interactions; two-device authorization, network interruption, quota, installed-app behavior and Google API behavior still need real-world testing before relying on this as the only copy of important data.
- This implementation reuses the checked local archive and therefore supports **at most 128 MiB and 20,000 items per synced workspace**. It holds archive data in memory and does not yet stream large files. Importing a large file is still unrestricted, but sync stops with an error if the workspace exceeds this limit; no local files are discarded. This limit and bounded-memory streaming remain work to do.
- Workspace content, filenames and manifests on Drive are **not end-to-end encrypted by Comet**. Google receives the workspace data. The separately stored device password vault, local calendar events, settings and display metadata are not included. If the user deliberately places an exported password backup or other sensitive file *inside* the workspace, it is an ordinary workspace file and will be included.
- Drive history and uploaded blobs are not automatically garbage-collected, so usage grows over time. Interrupted transfers may leave unreferenced blobs. Do not manually remove Comet revisions or blobs that another device might still need; missing history or data stops sync safely.
- The cache holds up to three recent verified, unencrypted workspace archives per sync group in the app's local cache directory. They are disposable; missing caches can increase the next download. Normal device protections apply.
- A Google sign-in configured with one OAuth client may not see private app properties created by a different OAuth client. Use the same publisher-configured app on all devices. If the account or baseline is missing, Comet stops rather than treating the workspace as new.
- The preview uses periodic scanning, not a filesystem watcher, so changes can take a short time to appear. It can process up to five concurrent heads per pass and schedules another pass if more remain.

## Existing manual sync and moving to automatic sync

The previous version-2 manual whole-workspace revision system and older one-off backups are still available in Cloud settings. They remain independent of the new version-3 protocol. Starting automatic sync from a workspace formerly using manual sync creates a **separate** Drive workspace; it does not delete or rewrite the older history. The old manual sync button is disabled for a workspace linked to automatic sync to avoid mixing unrelated histories. Import the new automatic workspace into a new local folder on each other device; existing local folders are never overwritten. This is not an in-place migration of a version-2 history.

Keep an independent backup and test with non-critical data first. Do not run another folder-sync service on the same workspace at the same time.

## Preparing Calendar and the earlier direct-Drive release

The earlier direct Google API integration requires Comet's publisher to create an OAuth application once. End users do **not** need a Google developer project or client ID. Until the publisher completes these steps, the separate Calendar connection cannot work in an unconfigured build. The newer rclone Drive button uses rclone's shared client instead, which is [being retired](https://rclone.org/drive/#making-your-own-client-id).

1. In a project owned by Comet's publisher, enable the Google Drive API and Google Calendar API. Configure the OAuth consent screen for the intended audience; while the app is in testing, add the Google accounts that may sign in. Complete any verification Google requires for public distribution and the requested `calendar.events` and `drive.file` scopes.
2. Create a **Desktop app** OAuth client. In the GitHub repository's **Settings → Secrets and variables → Actions → Variables**, set `COMET_GOOGLE_CLIENT_ID` to the client ID and, only if Google requires it, `COMET_GOOGLE_CLIENT_SECRET` to the desktop client secret. Rebuild the installer through the Release workflow. For a local build use `VITE_GOOGLE_CLIENT_ID` and, if needed, `VITE_GOOGLE_CLIENT_SECRET`.
3. Install that build, click **Connect Calendar**, and sign in on Google's browser page. Test Calendar and the automatic Drive preview with two real devices, including simultaneous edits, offline recovery, deletions, interrupted uploads and imports, before publishing or using it for important work. Credentials belong in the system credential store; never put a user's Google password or refresh token in GitHub variables.

The desktop client identifier and any bundled desktop client secret are public application configuration, not a private credential. No client has been registered or verified by this repository change, and the release workflow cannot create a Google project on the publisher's behalf. An iPhone port requires its own mobile OAuth design and should not reuse the desktop loopback flow.

## Obsidian research and differences

[Obsidian's local and remote vault documentation](https://obsidian.md/help/sync/vault-types) describes an app-managed remote vault, file-level transfers and offline changes queued until the app reconnects. Its [sync status and activity](https://obsidian.md/help/sync/messages) make progress and errors visible. Its [conflict documentation](https://obsidian.md/help/sync/troubleshoot) describes automatic Markdown merging and last-modified behavior by default, plus an optional conflict-copy mode. Comet follows the requested **keep both** policy instead of silently choosing a last writer.

Obsidian Sync is Obsidian's separate hosted service, not Google Drive. It offers [end-to-end encryption](https://obsidian.md/help/sync/security); Comet's Drive preview does not. Obsidian's documentation describes observable behavior, not the complete details of its server protocol. This implementation is Comet's own Drive protocol, not a claim of compatibility with Obsidian Sync.

Google's [native OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app) describes the browser, PKCE and app-registered desktop client approach used here. The existing limited [`drive.file` scope](https://developers.google.com/drive/api/guides/api-specific-auth) is used for Comet-created files.
