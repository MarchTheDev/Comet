# Comet icon

The blue spark icon matches the Comet interface. `comet.svg` is the editable
vector source, and `web/public/comet.svg` is its browser favicon copy. Generated
desktop icon sizes live in `web/src-tauri/icons/`.

To regenerate the Tauri icon set after editing the SVG:

```sh
cd web
npm run tauri icon ../assets/icon/comet.svg
```
