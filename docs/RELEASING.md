# Releasing Comet

The current [release workflow](../.github/workflows/release.yml) builds Windows
artifacts and attaches them to a **draft** GitHub release. Nothing is published
automatically. Review the workflow run and every artifact before publishing.
The release job can run even if the Windows build fails, so a draft's existence
alone does not prove that the installers were produced successfully.

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
   standalone and portable versions, and exercise file editing and media.
4. Review the release notes, then publish the draft when ready. The workflow
   leaves an already-published release untouched.

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
