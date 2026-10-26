import { clearSession, readSampleSelection, readSession, saveSampleSelection, saveSession } from '../src/utils/session.ts';

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}`); }
}

console.log('\nworkspace session');
const memory = new Map();
const store = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
check('has no session initially', readSession(store) === null);
saveSession({ vault: '/notes', note: '/notes/Ideas/hello.md' }, store);
check('remembers the selected local workspace and note', readSession(store)?.note === '/notes/Ideas/hello.md');
saveSession({ vault: '/notes', note: '/notes-other/outside.md' }, store);
check('does not restore a note outside the workspace', readSession(store)?.note === '');
saveSession({ vault: '/notes', note: '/notes/../outside.md' }, store);
check('rejects a remembered path containing parent traversal', readSession(store)?.note === '');
saveSession({ vault: 'comet-sample://vault', note: 'comet-sample://vault/a.md' }, store);
check('does not restore a browser sample as a real workspace', readSession(store) === null);
clearSession(store);
check('can forget the previous workspace', readSession(store) === null);
saveSampleSelection('comet-sample://vault/Notes/Idea.md', store);
check('remembers the last selected sample note separately', readSampleSelection(store) === 'comet-sample://vault/Notes/Idea.md');
saveSampleSelection('/not-a-sample.md', store);
check('clears a sample selection when its note is removed', readSampleSelection(store) === '');
const unavailable = { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); }, removeItem() { throw new Error('unavailable'); } };
saveSession({ vault: '/notes', note: '' }, unavailable);
clearSession(unavailable);
check('storage failures do not block the app', readSession(unavailable) === null);

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
