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

### Bundled rclone

The Windows workflow downloads official rclone v1.75.2 for AMD64, verifies the
pinned SHA-256, and embeds it into the executable. It fails closed if the bundle
is unavailable. Its MIT notice is included in Cloud settings. For local release
builds, download and verify the same official ZIP, set `COMET_RCLONE_BIN` to its
extracted `rclone.exe` and set `COMET_REQUIRE_BUNDLED_RCLONE=1` before the build.
Debug builds can alternatively use `COMET_RCLONE_DEV_BIN` at runtime. Manually
building another platform requires its own matching rclone binary. See
[rclone sync](rclone-sync.md) for security, limits and real-device test steps.

### Google sign-in configuration

Rclone Drive uses rclone's built-in shared client and needs no user-entered OAuth
client configuration. **That shared client is scheduled to stop working during
2026**, so it is not a durable release strategy. See [rclone sync](rclone-sync.md)
for the warning, retained history and real-account test requirements. Do not
assume that this Drive sign-in provides Calendar.

The separate Calendar and earlier direct-Drive integration requires Comet's
publisher to register a Desktop OAuth client, enable the applicable Google APIs,
and configure the consent screen and any required verification. Set the Actions
variables `COMET_GOOGLE_CLIENT_ID` and, if required, `COMET_GOOGLE_CLIENT_SECRET`;
the workflow supplies `VITE_GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_SECRET` to
the build. These desktop values are extractable from the application, not private
secrets. Never put refresh tokens or user passwords in variables. Without this
configuration, Calendar sign-in remains unavailable; the app no longer asks end
users to configure developer credentials. Testing-mode custom refresh tokens can
expire after seven days. Verify the installer, both separate authorizations, and
the OS credential store with real accounts; mocked tests cannot prove these work.

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
