# Comet icon

`comet.svg` is the editable mountain-and-comet icon and `comet.png` is the
ready-to-use PNG: a rounded dark tile with the mark on it, which is what
Windows and macOS icon grids expect. The same source is used for the browser
favicon, the README and all Tauri desktop icon sizes, including the icon
embedded in the standalone Windows executable. Windows setup artwork lives in `packaging/windows/`.

To regenerate the desktop icons after editing the SVG:

```sh
cd web
cp ../assets/icon/comet.svg public/comet.svg
npm run tauri icon ../assets/icon/comet.svg
cp src-tauri/icons/icon.png ../assets/icon/comet.png
```

Windows caches executable and shortcut icons aggressively; an old build can
continue to show the previous image until its Explorer icon cache refreshes.
