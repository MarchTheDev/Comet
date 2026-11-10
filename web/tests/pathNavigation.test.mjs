import { displayWorkspacePath, planWorkspacePath } from '../src/utils/pathNavigation.ts';
import { createSampleVault, SAMPLE_ROOT } from '../src/utils/sampleVault.ts';
import { joinPath } from '../src/utils/vault.ts';

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}`); }
}

console.log('\nworkspace path bar');
const entries = [
  { name: 'Notes', path: '/vault/Notes', kind: 'folder' },
  { name: 'Ideas.md', path: '/vault/Notes/Ideas.md', kind: 'file' },
  { name: 'photo.png', path: '/vault/photo.png', kind: 'file' },
  { name: 'plain-file', path: '/vault/plain-file', kind: 'file' },
];
const plan = (input) => planWorkspacePath(input, '/vault', entries);
check('formats a workspace-relative path with backslashes', displayWorkspacePath('/vault/Notes/Ideas.md', '/vault') === 'Comet\\Notes\\Ideas.md');
check('opens the root, an existing folder, and a note with either separator', plan('Comet').kind === 'root' && plan('Comet/Notes/').kind === 'folder' && plan('Comet\\Notes\\Ideas.md').path === '/vault/Notes/Ideas.md');
check('opens an existing note even when .md was omitted', plan('Notes/Ideas').kind === 'note' && plan('Notes/Ideas').path === '/vault/Notes/Ideas.md');
const newNote = plan('Comet\\Folder\\Nested\\text.md');
check('plans a new note and all missing folders without touching the vault', newNote.kind === 'create' && newNote.path === '/vault/Folder/Nested/text.md' && JSON.stringify(newNote.missingFolders) === JSON.stringify(['/vault/Folder', '/vault/Folder/Nested']));
check('automatically gives a new extensionless note a Markdown extension', plan('Notes/new idea').path === '/vault/Notes/new idea.md');
check('rejects traversal, empty segments, absolute paths and URLs', ['../secret.md', 'Comet/../secret.md', 'Comet/./note.md', 'Comet//x.md', '/etc/passwd', 'C:\\Windows\\file.md', '\\\\server\\share\\x.md', 'https://example.com'].every((value) => plan(value).kind === 'error'));
check('does not interpret a file as a folder', plan('plain-file/child.md').kind === 'error' && plan('Notes/Ideas.md/').kind === 'error');
check('opens existing files and preserves explicit extensions', plan('photo.png').kind === 'note' && plan('new.txt').kind === 'create' && plan('new.txt').path === '/vault/new.txt');
const newFolder = plan('Comet/Missing/Nested/');
check('plans only missing folders when a path ends in a slash', newFolder.kind === 'create' && newFolder.target === 'folder' && newFolder.path === '/vault/Missing/Nested' && JSON.stringify(newFolder.missingFolders) === JSON.stringify(['/vault/Missing', '/vault/Missing/Nested']));
const windows = [{ name: 'Notes', path: 'C:\\Vault\\Notes', kind: 'folder' }, { name: 'Ideas.MD', path: 'C:\\Vault\\Notes\\Ideas.MD', kind: 'file' }];
check('uses existing Windows paths and their actual casing', planWorkspacePath('comet/notes/ideas.md', 'C:\\Vault', windows).path === 'C:\\Vault\\Notes\\Ideas.MD');
check('preserves case-sensitive names on Unix', plan('notes/Ideas.md').kind === 'create');

const sample = createSampleVault();
const parentFile = joinPath(SAMPLE_ROOT, 'parent.md');
sample.createNote(parentFile, 'Keep me');
let parentRejected = false;
try { sample.createNote(joinPath(parentFile, 'child.md'), 'bad'); } catch { parentRejected = true; }
check('sample refuses to create folders through a file', parentRejected && sample.read(parentFile) === 'Keep me' && !sample.list().some((entry) => entry.path === joinPath(parentFile, 'child.md')));
let outsideRejected = false;
try { sample.createNote(`${SAMPLE_ROOT}/../outside.md`, 'bad'); } catch { outsideRejected = true; }
check('sample also rejects a direct creation outside the workspace', outsideRejected);

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
