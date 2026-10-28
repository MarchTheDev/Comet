# Google Drive sync direction

## Decision

Use automatic, file-level incremental sync while Comet is running, with an offline queue and separate conflict copies. The intent is one Google Connect flow for Calendar and Drive, not a separate app or a Google developer project per user. The project owner must register and configure the desktop OAuth client, enable the APIs, and complete any applicable Google consent/verification steps before distributing it. Drive access uses the existing `drive.file` scope; workspace files on Drive are not encrypted by Comet. The device password vault, local calendar data, settings, and local display metadata remain excluded.

**This document is the agreed direction, not a description of a completed implementation.** Current Comet sync is explicitly initiated from Settings and uses unencrypted, immutable whole-workspace revisions, with a 128 MB / 20,000-item snapshot limit. It does not run automatically. Existing manual sync, imports, and backups must remain usable until the new protocol is implemented and migration is verified.

## Proposed behavior

- With explicit consent, a workspace is linked to a Drive sync identity. A second device chooses a new local destination; nothing is imported over an existing workspace.
- While Comet is open (including its tray), watch or periodically scan local changes, debounce saves, and poll Drive for remote changes. Show sync/offline/error/conflict state and a manual retry. Do not claim to sync while Comet is fully closed.
- Keep working offline. Persist pending changes and their baseline; retry with backoff when connectivity returns. Google disconnection, missing state, quota failures, and storage errors must stop safely and be visible, not silently discard work.
- Transfer changed file contents rather than repeatedly uploading the whole workspace. Stream large files with bounded memory; verify size and content hashes. A small versioned manifest can describe a full workspace and immutable file blobs; the manifest is published only after the referenced blobs are durable. Store only app-created data accessible under `drive.file`.
- Reconcile against a known common ancestor. Concurrent edits keep both versions under portable, distinguishable names. Deletion versus modification must preserve the modified content; no silently overwriting a changed file. Before replacing or removing an unchanged local file, recheck its contents and preserve the original in a safety location. Use staged, no-replace writes and reject unsafe paths, symlinks, duplicate case-insensitive names, and malformed manifests.
- Multiple devices may publish concurrently. Treat concurrent manifests as separate heads and merge them; do not rely on last-writer-wins or a non-atomic Drive listing. Avoid unsafe garbage collection of blobs still referenced by any history or device.
- Existing version-2 snapshot workspaces need an explicit, resumable migration with an intact snapshot fallback. A failed transfer or migration must not advance the baseline or modify the old remote history. Clearly describe any limits and storage growth.

## Validation before enabling

Exercise local/remote edits and deletes, simultaneous heads, crashes between each upload/apply/baseline step, offline replay, partial and corrupted downloads, filename portability, links, large files, storage exhaustion, OAuth expiry, and migration. Verify real Drive authorization and cross-device operation with a configured project-owned client. Do not enable automatic background sync merely by running the current full-snapshot command on a timer: it is not incremental and would inherit its size and interruption limitations.

## References

- [Obsidian Sync](https://obsidian.md/sync) is Obsidian's hosted service, separate from Google Drive; it supports offline use and end-to-end encryption.
- [Obsidian's third-party sync guidance](https://obsidian.md/help/sync-notes) describes using a locally available Drive folder on desktop and cautions against mixing services on the same vault.
- [Google OAuth for native apps](https://developers.google.com/identity/protocols/oauth2/native-app) describes browser authorization and PKCE for an app-registered desktop client.
