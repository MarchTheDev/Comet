import { readFileSync, statSync } from 'node:fs';
let failures = 0;
function check(name, ok) { if (ok) console.log(`  ok   ${name}`); else { failures++; console.log(`  FAIL ${name}`); } }
console.log('\nLinux packaging');
const read = (path) => readFileSync(path, 'utf8');
const appRun = read('../packaging/linux/appimage/AppRun');
const x11 = read('../packaging/linux/comet-x11');
const desktop = read('../packaging/linux/comet.desktop');
const x11Desktop = read('../packaging/linux/comet-x11.desktop');
const appIdDesktop = read('../packaging/linux/com.marco.comet.desktop');
const portable = read('../packaging/linux/portable-readme.txt');
const pkgbuild = read('../packaging/arch/PKGBUILD');
const workflow = read('../.github/workflows/release.yml');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));

check('the AppImage entry point resolves the binary beside itself, not from PATH', appRun.startsWith('#!/bin/sh\n') && !appRun.includes('\n#!/bin/sh\n') && /"\$HERE\/usr\/bin\/comet"/.test(appRun) && /\$\{1-\}.*--x11/s.test(appRun));
check('the AppImage asks the host for WebKitGTK but keeps a working renderer by default', /WEBKIT_DISABLE_DMABUF_RENDERER:=1/.test(appRun) && !/cp .*webkit/i.test(appRun));
check('the X11 wrapper sets GDK_BACKEND before the binary starts', /exec env GDK_BACKEND=x11 comet "\$@"/.test(x11));
check('menu entries name one registered main category, as appimagetool requires', [desktop, x11Desktop, appIdDesktop].every((entry) => /^Categories=Utility;$/m.test(entry)));
check('menu entries use the same application id and icon as the bundle', [desktop, x11Desktop, appIdDesktop].every((entry) => /^Icon=/m.test(entry) && /^StartupWMClass=com\.marco\.comet$/m.test(entry)) && /^Exec=comet$/m.test(desktop) && /^Exec=env GDK_BACKEND=x11 comet$/m.test(x11Desktop));
check('the portable readme describes Linux files and the GStreamer requirement', /Linux/.test(portable) && /gstreamer1\.0-plugins-good/.test(portable) && /~\/\.local\/share\/com\.marco\.comet/.test(portable));

check('the release workflow builds every Linux channel and publishes them together', ['linux', 'debian', 'fedora', 'arch'].every((job) => new RegExp(`\\n  ${job}:\\n`).test(workflow)) && /needs: \[version, windows, linux, debian, fedora, arch\]/.test(workflow) && /name: linux/.test(workflow) && /Comet-\$\{version\}-x86_64\.AppImage/.test(workflow) && /comet_\$\{version\}_amd64\.deb/.test(workflow) && /comet-\$\{version\}-1-x86_64\.pkg\.tar\.zst/.test(workflow));
check('every Linux channel uploads its artifact for the draft', ['linux', 'debian', 'fedora', 'arch'].every((channel) => new RegExp(`name: ${channel}\\n          path: artifacts/\\*`).test(workflow)));
check('the AppImage tool is pinned and digest-checked', /appimagetool\/releases\/download\/1\.9\.1\/appimagetool-x86_64\.AppImage/.test(workflow) && /ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0/.test(workflow));
check('the draft notes are written explicitly and checked for the Linux section', /gh release edit "\$tag" --notes-file notes\.md/.test(workflow) && /grep -qF "\*\*Linux\*\*"/.test(workflow));
check('the release job tolerates best-effort native packages but requires Windows and Linux', /if: \$\{\{ always\(\) \}\}/.test(workflow) && /name: windows\n          path: files\/windows\n      - uses: actions\/download-artifact@v4\n        with:\n          name: linux/.test(workflow) && /continue-on-error: true\n        with:\n          name: debian/.test(workflow));

const linux = config.bundle.linux;
check('the deb and rpm carry the X11 entry point and application-id icon', ['deb', 'rpm'].every((kind) => linux[kind].files['/usr/bin/comet-x11'] === '../../packaging/linux/comet-x11' && linux[kind].files['/usr/share/applications/com.marco.comet.desktop'] && linux[kind].files['/usr/share/icons/hicolor/128x128/apps/com.marco.comet.png'] === 'icons/128x128.png') && ['deb', 'rpm'].every((kind) => !('/usr/share/icons/hicolor/128x128/apps/comet.png' in linux[kind].files)));
check('the package checks accept the bundler capitalising the desktop entry', read('../packaging/linux/check-x11.sh').includes('applications/[Cc]omet\\.desktop$'));
check('the packages ask for the tray and GStreamer libraries they use', ['libayatana-appindicator3-1', 'gstreamer1.0-plugins-base', 'gstreamer1.0-plugins-good', 'gstreamer1.0-pipewire'].every((name) => linux.deb.depends.includes(name)) && ['libappindicator-gtk3', 'gstreamer1-plugins-base', 'gstreamer1-plugins-good', 'pipewire-gstreamer'].every((name) => linux.rpm.depends.includes(name)));
check('Wayland receives the application id', config.app.enableGTKAppId === true && config.identifier === 'com.marco.comet');

check('the Arch package installs both entry points and only runs on x86_64', /arch=\('x86_64'\)/.test(pkgbuild) && /comet-x11/.test(pkgbuild) && /com\.marco\.comet\.desktop/.test(pkgbuild) && /gst-plugins-good/.test(pkgbuild));
check('the packaging scripts and wrappers are executable in the checkout', ['../packaging/linux/comet-x11', '../packaging/linux/appimage/AppRun', '../packaging/linux/check-appimage.sh', '../packaging/linux/check-x11.sh', '../packaging/linux/check-deps.sh'].every((path) => (statSync(path).mode & 0o111) !== 0));

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
