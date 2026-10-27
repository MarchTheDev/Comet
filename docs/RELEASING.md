# Releasing Comet

The current [release workflow](../.github/workflows/release.yml) builds Windows
artifacts and attaches them to a **draft** GitHub release. Nothing is published
automatically. Review the workflow run and every artifact before publishing.
The release job waits for a successful Windows build and artifact upload. A
pre-existing draft can still be older than the latest commit, so verify its
target and assets before publishing.

## Windows artifacts

| Artifact | Purpose |
| --- | --- |
| `Comet-<version>-windows_setup.exe` | NSIS setup installer |
| `Comet-<version>-windows.msi` | WiX/MSI installer |
| `Comet.exe` | Standalone executable |
| `Comet-<version>-windows-portable.zip` | The same executable and a short readme, no installer required |

The workflow extracts an icon from the built executable and checks that the
portable copy matches the standalone executable by hash. The app icon is
configured for the Tauri binary and bundles; NSIS and WiX use the matching
installer artwork in [`packaging/windows`](../packaging/windows). The editable
icon source and regeneration instructions are in [`assets/icon`](../assets/icon).
A Windows build is still the definitive check of the executable icon, shortcuts,
installer visuals, and WebView2 playback on the target system.

The portable package does not make user data portable: files remain in the
workspace folder selected by the user, while settings and organization metadata
are kept in the app's local webview profile. Removing the executable does not
remove either.

## Building and publishing

1. Update [`VERSION`](../VERSION) to the desired release label. The workflow also
   runs on changes to the application, packaging configuration, icon and artwork,
   and can be started manually from Actions when available on the default branch.
2. Push the changes and wait for the **Release** workflow. Confirm the Windows
   job succeeded and the four expected files are attached to the draft.
3. On Windows, run the setup and MSI, check their icon and branding, launch the
   standalone and portable versions, and exercise file editing, calendar, media,
   Explorer reveal, launch-at-login, tray restore, close-to-tray, tray quit,
   whiteboards, password recovery/locking/backup, EPUB page turning, Google
   OAuth/calendar, Drive sync between two devices (including simultaneous edits,
   deletions, retries and conflict copies), snapshot upload/import, and the update
   handoff after an edit. Also verify that a failed save prevents closing or quitting.
4. Review the release notes, then publish the draft when ready. The workflow
   leaves an already-published release untouched.

### Google sign-in configuration

Google requires a registered Desktop OAuth client. Create one for the Comet
project, enable the Google Calendar and Drive APIs, and configure the consent
screen, test users and any required verification with Google. Set GitHub Actions
repository variables `COMET_GOOGLE_CLIENT_ID` and, if required,
`COMET_GOOGLE_CLIENT_SECRET` before building. The workflow passes them into the
frontend as `VITE_GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_SECRET`; local builds
can set those environment variables directly. A desktop client ID and secret are
publicly extractable from an installed app, not a protected secret. Do not put
refresh tokens or user passwords in either variable. If no client is configured,
the app clearly offers advanced manual setup instead of pretending one-click
sign-in is ready. Verify the final installer against a real Google account and
OS credential store; mocked tests cannot prove OAuth or Drive integration.

To build locally on Windows, install Rust with the MSVC toolchain, Visual Studio
Build Tools with **Desktop development with C++**, Node.js 22.13 or newer, and
WebView2. Then run:

```powershell
cd web
npm ci
npx tauri build --bundles nsis,msi
```

The resulting installers are under `web/src-tauri/target/release/bundle/`, and
`web/src-tauri/target/release/comet.exe` is the standalone binary. The GitHub
workflow makes the portable zip from that same executable. Other Tauri targets
can be built manually with their platform prerequisites, but the current
workflow does not produce Linux or macOS release artifacts.

Published releases are checked at startup. The Windows updater expects a public
`v<version>` release containing `Comet-<version>-windows_setup.exe` with GitHub's
SHA-256 asset digest. It downloads only from GitHub's release hosts, verifies the
digest and launches the installer after user confirmation. This does not provide
independent code-signature verification; signing releases is recommended. Test
the update from an older installed version before relying on this flow.
