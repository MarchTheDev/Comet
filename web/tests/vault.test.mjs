import {
  buildTree,
  fileName,
  joinPath,
  isPathInside,
  noteTitle,
  parentPath,
  relativePath,
  remapPath,
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
check('keeps non-Markdown file extensions when renaming', validEntryName('photo.png', 'file').name === 'photo.png' && noteTitle('Welcome.MD') === 'Welcome');
check('detects descendants without matching sibling names', isPathInside('/vault/Notes/a.md', '/vault/Notes') && !isPathInside('/vault/Notes 2/a.md', '/vault/Notes'));
check('rejects parent traversal and empty paths when checking containment', !isPathInside('/vault/../outside.md', '/vault') && !isPathInside('', '/') && isPathInside('/note.md', '/'));
check('remaps renamed folders while keeping Windows separators', remapPath('C:\\Vault\\Notes\\A.md', 'C:\\Vault\\Notes', 'C:\\Vault\\Ideas') === 'C:\\Vault\\Ideas\\A.md');

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
const renamedWelcome = joinPath(parentPath(SAMPLE_WELCOME), 'Hello.md');
sample.rename(SAMPLE_WELCOME, renamedWelcome);
check('renames the welcome note without resetting the sample on reload', createSampleVault(storage).read(renamedWelcome).includes('A little space'));
const renamedFolder = joinPath(SAMPLE_ROOT, 'Renamed');
sample.rename(folder, renamedFolder);
check('renames a folder and preserves nested notes', createSampleVault(storage).read(joinPath(renamedFolder, 'New.md')) === 'An updated thought');
let renameCollision = false;
try { sample.rename(renamedWelcome, joinPath(parentPath(renamedWelcome), 'Markdown guide.md')); } catch { renameCollision = true; }
check('refuses to overwrite a destination when renaming', renameCollision && sample.read(renamedWelcome).includes('A little space'));
sample.remove(renamedFolder);
check('deletes folders and their contents persistently', !createSampleVault(storage).list().some((entry) => isPathInside(entry.path, renamedFolder)));
let rootDeleteRejected = false;
try { sample.remove(SAMPLE_ROOT); } catch { rootDeleteRejected = true; }
check('does not allow deleting the sample root', rootDeleteRejected);
const emptyMemory = new Map();
const emptyStorage = { getItem: (key) => emptyMemory.get(key) ?? null, setItem: (key, value) => emptyMemory.set(key, value) };
const emptySample = createSampleVault(emptyStorage);
for (const entry of emptySample.list().filter((item) => parentPath(item.path) === SAMPLE_ROOT)) emptySample.remove(entry.path);
check('preserves an intentionally empty sample instead of restoring defaults', createSampleVault(emptyStorage).list().length === 0);
const corrupt = createSampleVault({ getItem: () => '{"folders":"invalid","files":{}}', setItem() {} });
check('recovers gracefully from invalid saved sample data', corrupt.read(SAMPLE_WELCOME).includes('A little space'));

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
