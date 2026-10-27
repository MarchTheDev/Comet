import { createSampleVault, SAMPLE_ROOT } from '../src/utils/sampleVault.ts';
import { joinPath } from '../src/utils/vault.ts';
import { fileKind, isTextFile, youtubeIds } from '../src/utils/fileTypes.ts';
import { emptyWorkspaceMeta, itemMeta, updateItem, renameMeta, removeMeta, reorderChildren, readWorkspaceMeta, saveWorkspaceMeta } from '../src/utils/workspaceMeta.ts';
import { readVaultList, saveVaultList } from '../src/utils/vaultList.ts';

let failures = 0;
function check(name, ok) { if (ok) console.log(`  ok   ${name}`); else { failures++; console.log(`  FAIL ${name}`); } }
console.log('\nfile types and organization');
check('classifies common text, image, audio, video and unknown extensions', fileKind('note.MARKDOWN') === 'markdown' && fileKind('data.json') === 'text' && fileKind('photo.JPG') === 'image' && fileKind('song.mp3') === 'audio' && fileKind('clip.webm') === 'video' && fileKind('archive.zip') === 'other');
check('does not treat unknown or media files as editable text', !isTextFile('archive.zip') && !isTextFile('song.mp3') && isTextFile('notes.txt'));
check('validates YouTube hosts and IDs, deduplicating links', JSON.stringify(youtubeIds('https://youtu.be/dQw4w9WgXcQ https://www.youtube.com/watch?v=dQw4w9WgXcQ https://evil-youtube.com/watch?v=dQw4w9WgXcQ https://youtube.com/watch?v=not-valid')) === JSON.stringify(['dQw4w9WgXcQ']));
const memory = new Map();
const store = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
let meta = emptyWorkspaceMeta();
meta.tags.push({ id: 't1', name: 'Work', color: '#83b8ca' });
meta = updateItem(meta, '/vault/Projects/note.md', { tags: ['t1'], pinned: true, favorite: true });
meta = reorderChildren(meta, '/vault/Projects', ['/vault/Projects/note.md', '/vault/Projects/other.md'], '/vault/Projects/note.md', '/vault/Projects/other.md', true);
check('reorders siblings without moving files', meta.order['/vault/Projects'].join('|') === '/vault/Projects/other.md|/vault/Projects/note.md');
meta = renameMeta(meta, '/vault/Projects', '/vault/Ideas');
check('remaps item and ordering metadata when a folder moves', itemMeta(meta, '/vault/Ideas/note.md').pinned && itemMeta(meta, '/vault/Ideas/note.md').favorite && meta.order['/vault/Ideas'].includes('/vault/Ideas/note.md') && !meta.items['/vault/Projects/note.md']);
const movedMetadata = renameMeta(meta, '/vault/Ideas/note.md', '/vault/Elsewhere/note.md');
check('cross-folder moves remove the old sibling ordering while retaining tags', !movedMetadata.order['/vault/Ideas'].includes('/vault/Elsewhere/note.md') && itemMeta(movedMetadata, '/vault/Elsewhere/note.md').tags.includes('t1'));
check('persists workspace organization per vault', saveWorkspaceMeta('/vault', meta, store) && readWorkspaceMeta('/vault', store).tags[0].name === 'Work' && readWorkspaceMeta('/other', store).tags.length === 0);
meta = removeMeta(meta, '/vault/Ideas');
check('removes a folder’s item and order metadata without deleting tag definitions', Object.keys(meta.items).length === 0 && Object.keys(meta.order).length === 0 && meta.tags.length === 1);
check('remembers distinct vaults', saveVaultList(['/vault', '/vault', '/other'], store) && readVaultList(store).join('|') === '/vault|/other');

const sample = createSampleVault(store);
const a = joinPath(SAMPLE_ROOT, 'MoveA'), b = joinPath(SAMPLE_ROOT, 'MoveB');
sample.createFolder(a); sample.createFolder(b);
sample.createNote(joinPath(a, 'memo.txt'), 'keep me');
const moved = sample.move(joinPath(a, 'memo.txt'), b);
check('moves sample files without changing their contents', moved === joinPath(b, 'memo.txt') && sample.read(moved) === 'keep me');
sample.createNote(joinPath(a, 'memo.txt'), 'do not overwrite');
let collision = false;
try { sample.move(joinPath(a, 'memo.txt'), b); } catch { collision = true; }
check('refuses move collisions without altering either file', collision && sample.read(joinPath(a, 'memo.txt')) === 'do not overwrite' && sample.read(moved) === 'keep me');
let cycle = false;
try { sample.move(a, a); } catch { cycle = true; }
check('rejects moving a folder into itself', cycle);
sample.createNote(joinPath(a, 'pic.png'), 'data:image/png;base64,c2VjcmV0');
check('does not search inside browser sample media', sample.search('c2VjcmV0').length === 0);
sample.createNote(joinPath(a, 'literal.txt'), 'data: a legitimate text note');
check('searches plain text that begins with data:', sample.search('legitimate text').some((hit) => hit.name === 'literal.txt'));

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
