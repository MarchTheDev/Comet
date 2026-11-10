# Releasing Comet

The current [release workflow](../.github/workflows/release.yml) builds Windows
and Linux artifacts from one version and attaches them to a **draft** GitHub
release. Nothing is published automatically. Review the workflow run and every
artifact before publishing. The release job waits for successful Windows and
Linux builds; native Debian, Fedora and Arch packages are best-effort and do not
block a draft. A pre-existing draft can still be older than the latest commit,
so verify its target and assets before publishing.

## Windows artifacts

| Artifact | Purpose |
| --- | --- |
| `Comet-<version>-windows-setup.exe` | NSIS setup installer |
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

## Linux artifacts

| Artifact | Purpose |
| --- | --- |
| `Comet-<version>-x86_64.AppImage` | One file for any distribution with WebKitGTK 4.1; thin, and asks the host for its libraries |
| `comet_<version>_amd64.deb` | Debian/Ubuntu package, built on Ubuntu 22.04 so it installs on anything newer |
| `comet-<version>-1.x86_64.rpm` | RPM package |
| `Comet-<version>-linux-portable.tar.gz` | The binary, both desktop entries, the X11 wrapper, the icon and a readme |
| `comet_<version>_debian_amd64.deb` | Best-effort native Debian 13 build |
| `comet-<version>-1.fc.x86_64.rpm` | Best-effort native Fedora build |
| `comet-<version>-1-x86_64.pkg.tar.zst` | Best-effort Arch package, installed with `pacman -U` |

The Linux job builds the deb and rpm with Tauri's bundler, then assembles the
AppImage itself instead of using linuxdeploy: bundling WebKitGTK and GStreamer
into the image makes it enormous and breaks on distributions those library
versions were not taken from. `packaging/linux/appimage/AppRun` resolves the
binary relative to the mounted image, defaults
`WEBKIT_DISABLE_DMABUF_RENDERER=1` (a blank window is a worse first impression
than a slower one), and passes `--x11` through for the **Comet (X11)** entry.

Finished packages are inspected rather than trusted:

- `check-appimage.sh` unpacks the image and confirms `AppRun`, the binary, the
  X11 wrapper, both menu entries and the icon, with `Exec` pointing at `AppRun`.
- `check-x11.sh` looks inside the deb, rpm, tarball and pacman package for the
  X11 wrapper and desktop entries and confirms the wrapper is executable.
- `check-deps.sh` confirms the GStreamer and tray dependencies are declared and
  that each distribution's repositories can actually provide them.

The workflow pins `appimagetool` to 1.9.1 and verifies its published SHA-256
before running it. The Arch PKGBUILD packages the binary CI already built, so
`makepkg` takes seconds rather than a full Rust build. Keep its `depends` in
step with the packages the Arch job installs; `makepkg` exits 8 when they differ.

Both the AppImage and the tarball need WebKitGTK 4.1 and a Secret Service
provider (GNOME Keyring or KWallet) for the password vault. Media playback needs
the GStreamer plugins the deb and rpm declare and the readmes describe.

## Building and publishing

1. Update [`VERSION`](../VERSION) to the desired release label. The workflow also
   runs on changes to the application, packaging configuration, icon and artwork,
   and can be started manually from Actions when available on the default branch.
2. Push the changes and wait for the **Release** workflow. Confirm the Windows
   and Linux jobs succeeded and the expected Windows files plus the AppImage,
   deb, rpm and portable tarball are attached to the draft. Native Debian,
   Fedora and Arch packages may be missing if those best-effort jobs failed.
3. On Windows, run the setup and MSI, check their icon and branding, launch the
   standalone and portable versions, and exercise file editing, calendar, media,
   Explorer reveal, launch-at-login, tray restore, close-to-tray, tray quit,
   whiteboards, local calendar, password recovery/locking/backup, site logos
   (including failed/offline lookups), EPUB page turning, and the update handoff
   after an edit. Also verify that a failed save prevents closing or quitting.
4. On Linux, install the deb (and, where available, the rpm and pacman package),
   run the AppImage and the tarball, and check the window, tray, workspace
   editing, media playback with the GStreamer plugins, the password vault with a
   Secret Service provider, the X11 entry, and that **Check for updates** offers
   the release page rather than an installer. A physical Linux desktop is the
   definitive check; CI only builds and inspects the packages.
5. Review the release notes, then publish the draft when ready. The workflow
   leaves an already-published release untouched.

### Optional Brandfetch logos

Brandfetch's [Logo API](https://docs.brandfetch.com/logo-api/overview) requires a
public client ID registered to the project owner and an origin-bearing Referer.
To enable it in a release, set the GitHub Actions repository variable
`COMET_BRANDFETCH_CLIENT_ID` to that public ID; local builds can use
`VITE_BRANDFETCH_CLIENT_ID`. Never put passwords or private API keys in these
variables. No client ID is included by default. Without one, Comet uses bundled
Simple Icons and DuckDuckGo/Google favicons, with a globe as the final fallback.
Brandfetch is hotlinked, never downloaded or cached by Comet. Test the configured
build in the installed Windows WebView: its `http://tauri.localhost` origin may
need to be permitted by Brandfetch; on other platforms the app origin differs.
If the service refuses the request, Comet falls back to the other sources.

### Cloud is paused in 1.0

The release does not register cloud or Google Calendar commands, bundle rclone,
or start workspace sync at launch, during editing, periodically, or at quit.
Earlier connections, workspace data, and remote histories are not deleted or
revoked. The old source and regression tests are retained for possible future
work; historical instructions in `rclone-sync.md` and `google-drive-sync.md`
do not describe the current app.

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
workflow makes the portable zip from that same executable.

On Linux, install the Tauri prerequisites for your distribution
(`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
`patchelf`, and `rpm` if you want the RPM), then:

```sh
cd web
npm ci
bash ../packaging/tauri-build.sh --bundles deb,rpm
```

`packaging/tauri-build.sh` keeps a build log, turns failures into GitHub
annotations when running in Actions, and makes sure the X11 wrapper and AppRun
retain their executable bit. The AppImage and tarball are assembled by
`release.yml` because they need the finished binary and fixed file names.

Published releases are checked at startup. The Windows updater expects a public
`v<version>` release containing `Comet-<version>-windows-setup.exe` with GitHub's
SHA-256 asset digest. Linux has no in-app installer; the Updates page links to
the release, where the AppImage, deb, rpm or pacman package can be chosen. It downloads only from GitHub's release hosts, verifies the
digest and launches the installer after user confirmation. This does not provide
independent code-signature verification; signing releases is recommended. Test
the update from an older installed version before relying on this flow. Version
1.0 understands both two- and three-part release labels. Earlier 0.1.0 builds
only recognize three-part labels, so they will not offer the `v1.0` release;
install 1.0 manually. `VERSION` and release filenames stay `1.0` while npm, Cargo
and Tauri use the required internal `1.0.0` metadata.
