import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * The version, read from the repository's own VERSION file.
 *
 * The same file feeds the release workflow, so what the app says it is, what
 * the bundles are named, and what the GitHub release is called all come from
 * one line in one place.
 *
 * A build of this folder on its own has no repository above it to read from,
 * so the number is passed in by the build job instead.
 */
const VERSION =
  process.env.COMET_VERSION?.trim() ||
  readFileSync(path.resolve(__dirname, "..", "VERSION"), "utf8").trim();
// https://vite.dev/config/
/**
 * The version as a module.
 *
 * `define` would only have substituted it in a production build, which left the
 * development server reporting 0.0.0 and off it went offering an update to
 * itself. A module resolving to the number works the same in both, and is the
 * one place the value is turned into code.
 */
const versionModule = {
  name: "comet-version",
  resolveId(id: string) {
    return id === "virtual:comet-version" ? "\0virtual:comet-version" : null;
  },
  load(id: string) {
    return id === "\0virtual:comet-version"
      ? `export const APP_VERSION = ${JSON.stringify(VERSION)};`
      : null;
  },
};
// PDF.js uses fonts, CMaps, color profiles and WASM decoders by filename.
// Serve them in development and copy the dependency's resources to dist during
// builds, without checking generated assets into the repository.
const pdfDirectories = ["cmaps", "standard_fonts", "wasm", "iccs"];
const pdfBase = path.join(__dirname, "node_modules/pdfjs-dist");
const pdfResources = {
  name: "comet-pdf-resources",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use("/pdfjs", (req, res, next) => {
      const pieces = (req.url || "").split("?")[0].split("/").filter(Boolean);
      if (pieces.length !== 2 || !pdfDirectories.includes(pieces[0]) || !/^[\w.-]+$/.test(pieces[1])) return next();
      try {
        const data = readFileSync(path.join(pdfBase, pieces[0], pieces[1]));
        res.setHeader("Content-Type", pieces[1].endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        res.end(data);
      } catch { next(); }
    });
  },
  generateBundle(this: import("rollup").PluginContext) {
    for (const directory of pdfDirectories) for (const file of readdirSync(path.join(pdfBase, directory), { withFileTypes: true })) {
      if (file.isFile()) this.emitFile({ type: "asset", fileName: `pdfjs/${directory}/${file.name}`, source: readFileSync(path.join(pdfBase, directory, file.name)) });
    }
  },
};
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), versionModule, pdfResources],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    // Reachable from outside this machine, so a preview (or a phone on the
    // same network) can open the interface. The desktop app never uses this;
    // it loads the built file.
    host: true,
    port: 1420,
    strictPort: true,
    allowedHosts: true,
  },
});
