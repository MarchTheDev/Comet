/**
 * Run the checks in this folder.
 *
 * The app's own modules are TypeScript, and Node will not read those straight
 * out of the tree, so the test file is bundled first and then run. esbuild comes
 * with Vite, which is already a dependency, so this adds nothing to install.
 */
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
// Written inside the project, so that `import 'jsdom'` in the bundle finds the
// copy that is installed here rather than looking next to a temporary folder.
const dir = path.join('.test-build');
mkdirSync(dir, { recursive: true });
const checks = [
  'tests/markdown.test.mjs',
  'tests/vault.test.mjs',
  'tests/pathNavigation.test.mjs',
  'tests/settings.test.mjs',
  'tests/settingsInteractions.test.mjs',
  'tests/calendar.test.mjs',
  'tests/session.test.mjs',
  'tests/editor.test.mjs',
  'tests/organization.test.mjs',
  'tests/richText.test.mjs',
  'tests/saveQueue.test.mjs',
  'tests/newFeatures.test.mjs',
  'tests/boardInteractions.test.mjs',
  'tests/exploreInteractions.test.mjs',
  'tests/coverCache.test.mjs',
  'tests/latestFeatures.test.mjs',
];
try {
  for (const file of checks) {
    const out = path.join(dir, path.basename(file).replace('.test.mjs', '.mjs'));
    await build({
      entryPoints: [file],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: out,
      // Left to Node, so the bundle finds the copies installed here.
      external: ['jsdom', 'react', 'react-dom', 'react-dom/server', 'lucide-react'],
      jsx: 'automatic',
      logLevel: 'silent',
    });
    await import(pathToFileURL(path.resolve(out)).href);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
// Each check file adds to this rather than exiting on its own, so one failing
// file cannot stop the next one from being looked at.
const failed = globalThis.__cometFailures ?? 0;
console.log(failed === 0 ? '\nevery check passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
