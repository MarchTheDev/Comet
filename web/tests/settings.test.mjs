import { DEFAULT_SETTINGS, readSettings, saveSettings, SETTINGS_KEY } from '../src/utils/settings.ts';

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}`); }
}

console.log('\nsettings');
const memory = new Map();
const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
check('defaults to dark with the Matterhorn and reopening enabled', readSettings(storage).theme === 'dark' && readSettings(storage).showCover && readSettings(storage).reopenWorkspace);
const preferences = { theme: 'light', showCover: false, editorFontSize: 18, spellcheck: false, reopenWorkspace: false };
check('saves and restores all preferences, including false values', saveSettings(preferences, storage) && JSON.stringify(readSettings(storage)) === JSON.stringify(preferences));
memory.set(SETTINGS_KEY, JSON.stringify({ theme: 'system', showCover: false, editorFontSize: 32, spellcheck: 'no', reopenWorkspace: false }));
const partial = readSettings(storage);
check('validates each saved field and fills missing or invalid values', partial.theme === 'system' && !partial.showCover && partial.editorFontSize === DEFAULT_SETTINGS.editorFontSize && partial.spellcheck && !partial.reopenWorkspace);
memory.set(SETTINGS_KEY, '{invalid');
check('falls back safely for corrupt preferences', JSON.stringify(readSettings(storage)) === JSON.stringify(DEFAULT_SETTINGS));
const unavailable = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
check('continues with temporary defaults if storage is unavailable', readSettings(unavailable).theme === 'dark' && !saveSettings(preferences, unavailable));

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
