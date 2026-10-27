import { DEFAULT_SETTINGS, readSettings, saveSettings, SETTINGS_KEY } from '../src/utils/settings.ts';

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}`); }
}

console.log('\nsettings');
const memory = new Map();
const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
check('defaults to system, arrowheads off and reopening enabled, without a background toggle', readSettings(storage).theme === 'system' && !readSettings(storage).todoArrowheads && !('showCover' in readSettings(storage)) && readSettings(storage).reopenWorkspace);
const preferences = { ...DEFAULT_SETTINGS, theme: 'light', editorFontSize: 18, interfaceScale: 125, textScale: 120, todoArrowheads: true, autoCoverArt: false, spellcheck: false, reopenWorkspace: false, shortcuts: { ...DEFAULT_SETTINGS.shortcuts, pin: 'Mod+Alt+P' } };
check('saves and restores all preferences, including false values', saveSettings(preferences, storage) && JSON.stringify(readSettings(storage)) === JSON.stringify(preferences));
memory.set(SETTINGS_KEY, JSON.stringify({ theme: 'system', showCover: false, editorFontSize: 32, interfaceScale: -50, textScale: 1000, todoArrowheads: 'yes', autoCoverArt: false, spellcheck: 'no', reopenWorkspace: false }));
const partial = readSettings(storage);
check('validates each saved field and fills missing or invalid values', partial.theme === 'system' && !('showCover' in partial) && partial.editorFontSize === DEFAULT_SETTINGS.editorFontSize && partial.interfaceScale === 100 && partial.textScale === 100 && !partial.todoArrowheads && !partial.autoCoverArt && partial.spellcheck && !partial.reopenWorkspace);
check('accepts all additional color themes', ['emerald', 'rubellite', 'navy'].every(theme => { memory.set(SETTINGS_KEY, JSON.stringify({ theme })); return readSettings(storage).theme === theme; }));
memory.set(SETTINGS_KEY, '{invalid');
check('falls back safely for corrupt preferences', JSON.stringify(readSettings(storage)) === JSON.stringify(DEFAULT_SETTINGS));
const unavailable = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
check('continues with temporary defaults if storage is unavailable', readSettings(unavailable).theme === 'system' && !saveSettings(preferences, unavailable));

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
