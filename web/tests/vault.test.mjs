import {
  buildTree,
  fileName,
  joinPath,
  parentPath,
  relativePath,
  resolveVaultAsset,
  validEntryName,
} from '../src/utils/vault.ts';
import { createSampleVault, SAMPLE_ROOT, SAMPLE_WELCOME } from '../src/utils/sampleVault.ts';

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}`); }
}

console.log('\nvault paths and explorer');
const tree = buildTree([
  { name: 'child.md', path: 'C:\\Notes\\Ideas\\child.md', kind: 'file' },
  { name: 'z.md', path: 'C:\\Notes\\z.md', kind: 'file' },
  { name: 'Ideas', path: 'C:\\Notes\\Ideas', kind: 'folder' },
  { name: 'outside.md', path: 'C:\\Other\\outside.md', kind: 'file' },
], 'C:\\Notes');
check('builds folders before children even when entries arrive out of order', tree[0]?.name === 'Ideas' && tree[0]?.children[0]?.name === 'child.md');
check('sorts folders before notes and ignores paths outside the vault', tree.length === 2 && tree[1]?.name === 'z.md');
check('handles Windows paths', relativePath('C:\\Notes\\Ideas\\child.md', 'C:\\Notes') === 'Ideas/child.md' && joinPath('C:\\Notes', 'new.md') === 'C:\\Notes\\new.md' && parentPath('C:\\Notes\\new.md') === 'C:\\Notes');
check('handles Unix paths', fileName('/notes/a.md') === 'a.md' && joinPath('/notes/', 'b.md') === '/notes/b.md');
check('adds a Markdown extension without duplicating existing ones', validEntryName('thought', 'note').name === 'thought.md' && validEntryName('thought.MD', 'note').name === 'thought.MD');
check('rejects empty and unsafe names', Boolean(validEntryName('  ', 'note').error) && Boolean(validEntryName('../escape', 'folder').error) && Boolean(validEntryName('a\\b', 'note').error));

console.log('\nlocal image paths');
check('resolves an image relative to the note', resolveVaultAsset('/vault', '/vault/Inbox/note.md', '../assets/my%20image.png') === '/vault/assets/my image.png');
check('resolves Windows image paths', resolveVaultAsset('C:\\Vault', 'C:\\Vault\\Inbox\\note.md', '../assets/a.png') === 'C:\\Vault\\assets\\a.png');
check('supports a vault at the filesystem root', resolveVaultAsset('/', '/Inbox/note.md', '../assets/a.png') === '/assets/a.png');
check('rejects traversal outside the vault, including encoded traversal', resolveVaultAsset('/vault', '/vault/note.md', '../secret.png') === null && resolveVaultAsset('/vault', '/vault/note.md', '%2e%2e/secret.png') === null);
check('rejects absolute paths and remote URLs', resolveVaultAsset('/vault', '/vault/note.md', '/etc/passwd') === null && resolveVaultAsset('/vault', '/vault/note.md', 'https://example.com/a.png') === null);

console.log('\nsample workspace');
const memory = new Map();
const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
const sample = createSampleVault(storage);
const folder = joinPath(SAMPLE_ROOT, 'Test');
const note = joinPath(folder, 'New.md');
sample.createFolder(folder);
sample.createNote(note, 'A thought worth finding');
sample.write(note, 'An updated thought');
check('creates and edits sample notes', sample.read(note) === 'An updated thought' && sample.list().some((entry) => entry.path === note));
check('searches both filenames and content', sample.search('new').some((hit) => hit.path === note) && sample.search('updated').some((hit) => hit.path === note));
check('persists sample changes locally', createSampleVault(storage).read(note) === 'An updated thought');
let duplicateRejected = false;
try { sample.createNote(note, 'overwrite'); } catch { duplicateRejected = true; }
check('does not overwrite an existing note when creating', duplicateRejected && sample.read(note) === 'An updated thought');
check('starts with a welcome note', sample.read(SAMPLE_WELCOME).includes('A little space'));
const unavailable = createSampleVault({ getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); } });
unavailable.write(SAMPLE_WELCOME, 'temporary');
check('still works temporarily when browser storage is unavailable', unavailable.read(SAMPLE_WELCOME) === 'temporary' && !unavailable.isPersisted());
const corrupt = createSampleVault({ getItem: () => '{"folders":[],"files":{}}', setItem() {} });
check('recovers gracefully from invalid saved sample data', corrupt.read(SAMPLE_WELCOME).includes('A little space'));

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
