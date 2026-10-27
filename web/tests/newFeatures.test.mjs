import { editableTextError, MAX_EDITABLE_BYTES } from "../src/utils/textSafety.ts";
import { selectRange, selectionRoots } from '../src/utils/selection.ts';
import { keyboardShortcut, readShortcuts, DEFAULT_SHORTCUTS } from '../src/utils/shortcuts.ts';
import { parseTodo, serializeTodo, newTodoDocument, TODO_CONNECTION_COLOR } from '../src/utils/todo.ts';
import { safeWebUrl, parseShortcut, serializeShortcut, videoLink, firstDroppedUrl } from '../src/utils/links.ts';
import { graphEdges } from '../src/utils/graph.ts';
import { connectionGeometry } from '../src/utils/todoGeometry.ts';
import { fileKind } from '../src/utils/fileTypes.ts';
import { entryIcon } from '../src/FileIcon.tsx';
import { Music2, FileImage, Clapperboard, FileType2, ListChecks, Folder } from 'lucide-react';
import { readWorkspaceIdentities, saveWorkspaceIdentities, identityFor } from '../src/utils/workspaceIdentity.ts';

let failures = 0;
function check(name, ok) { if (ok) console.log(`  ok   ${name}`); else { failures++; console.log(`  FAIL ${name}`); } }
console.log('\nselection, links, boards and exploration');
const ordered = ['/vault/a', '/vault/b', '/vault/c', '/vault/d'];
let selected = selectRange(new Set(), '', ordered, '/vault/a', false, false);
selected = selectRange(selected.selected, selected.anchor, ordered, '/vault/c', false, true);
check('shift selects a contiguous range without opening items', !selected.open && [...selected.selected].join() === ordered.slice(0, 3).join());
selected = selectRange(selected.selected, selected.anchor, ordered, '/vault/b', true, false);
check('modifier click toggles an item independently', !selected.selected.has('/vault/b') && selected.selected.has('/vault/c'));
check('deduplicates descendants before deleting', selectionRoots(['/vault/a/x', '/vault/b', '/vault/a', '/vault/a/y']).join() === '/vault/b,/vault/a' || selectionRoots(['/vault/a/x', '/vault/b', '/vault/a', '/vault/a/y']).sort().join() === '/vault/a,/vault/b');
check('editable text limits count UTF-8 bytes and reject NULs before writing', !editableTextError('plain text') && !!editableTextError('a\0b') && !editableTextError('a'.repeat(MAX_EDITABLE_BYTES)) && !!editableTextError('😀'.repeat(MAX_EDITABLE_BYTES / 4 + 1)));
check('distinguishes PDF, link and dedicated board files', fileKind('a.PDF') === 'pdf' && fileKind('v.url') === 'link' && fileKind('plan.comet-todo') === 'todo');
const iconEntry = (path, kind = 'file') => ({ name: path, path, kind });
check('uses distinct icons for media, PDFs, to-do boards and folders wherever files are listed', entryIcon(iconEntry('song.mp3')) === Music2 && entryIcon(iconEntry('pic.png')) === FileImage && entryIcon(iconEntry('clip.webm')) === Clapperboard && entryIcon(iconEntry('paper.pdf')) === FileType2 && entryIcon(iconEntry('plan.comet-todo')) === ListChecks && entryIcon(iconEntry('notes', 'folder')) === Folder);
check('round-trips standard web shortcut data', parseShortcut(serializeShortcut('https://youtu.be/dQw4w9WgXcQ')) === 'https://youtu.be/dQw4w9WgXcQ');
check('rejects dangerous, malformed and credentialed links', ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.com/', 'https://'].every((url) => safeWebUrl(url) === null));
check('extracts only a validated YouTube id or supported direct video link', videoLink('https://youtu.be/dQw4w9WgXcQ')?.kind === 'youtube' && videoLink('https://example.com/a.mp4?x=1')?.kind === 'video' && !videoLink('https://youtube.com.evil/watch?v=dQw4w9WgXcQ'));
check('reads the first valid URI dropped from a browser', firstDroppedUrl('# source\nhttps://example.com/watch\n', 'ignore') === 'https://example.com/watch');
const board = newTodoDocument();
board.categories.push({ id: 'category', title: 'Work', color: '#123456' });
board.tasks.push({ id: 'task', text: 'One', done: false, notes: 'Details', x: 20, y: 30, categoryId: 'category', subtasks: [{ id: 'meeting', text: 'Meeting', done: false }, { id: 'dinner', text: 'Dinner', done: true }] }, { id: 'task2', text: 'Two', done: true, notes: '', x: 400, y: 50, categoryId: null, subtasks: [] });
board.connections.push({ from: 'task', to: 'task2', color: '#1255aa' });
check('new to-do boards start as a blank canvas without default lines', newTodoDocument().tasks.length === 0 && newTodoDocument().connections.length === 0);
check('to-do canvas round-trips tasks, positions, categories and task connections', JSON.stringify(parseTodo(serializeTodo(board))) === JSON.stringify(board));
const legacy = { format: 'comet-todo', version: 1, lists: [
  { id: 'a', title: 'Backlog', color: '#112233', tasks: [{ id: 'old-task', text: 'Keep', done: true, notes: 'Important detail' }] },
  { id: 'b', title: 'Done', color: '#334455', tasks: [] },
], connections: [{ from: 'a', to: 'b' }] };
const migrated = parseTodo(JSON.stringify(legacy));
check('legacy list tasks and connections survive in-memory migration without drawing default lines', migrated?.version === 3 && migrated.tasks[0].notes === 'Important detail' && migrated.tasks[0].done && migrated.tasks[0].categoryId === 'a' && migrated.categories[1].title === 'Done' && migrated.connections.length === 0 && migrated.legacyListConnections[0].to === 'b');
check('migrated board remains valid after serialization', parseTodo(serializeTodo(migrated))?.legacyListConnections.length === 1);
const v2 = { format: 'comet-todo', version: 2, categories: [{ id: 'category', title: 'Work', color: '#123456' }], tasks: [{ id: 'task', text: 'Keep me', done: true, notes: 'notes', x: 200, y: 140, categoryId: 'category' }, { id: 'task2', text: 'Other', done: false, notes: '', x: 700, y: 140, categoryId: null }], connections: [{ from: 'task', to: 'task2' }], legacyListConnections: [] };
const v2Before = JSON.stringify(v2), migratedV2 = parseTodo(v2Before);
check('v2 migration preserves existing data and links in memory without rewriting the source', JSON.stringify(v2) === v2Before && migratedV2?.version === 3 && migratedV2.tasks[0].notes === 'notes' && migratedV2.tasks[0].done && migratedV2.tasks[0].subtasks.length === 0 && migratedV2.connections[0].color === TODO_CONNECTION_COLOR && parseTodo(serializeTodo(migratedV2))?.connections[0].to === 'task2');
check('rejects unknown v2 fields and malformed nested items or colors', parseTodo(JSON.stringify({ ...v2, extra: 'do not discard' })) === null && parseTodo(JSON.stringify({ ...board, tasks: [{ ...board.tasks[0], subtasks: [{ id: 'x', text: 'x', done: false, extra: true }] }, board.tasks[1]] })) === null && parseTodo(JSON.stringify({ ...board, connections: [{ from: 'task', to: 'task2', color: 'red' }] })) === null);

const invalid = { ...board, futureField: 'keep me' };
check('unknown board fields and future versions are rejected without serialization', parseTodo(JSON.stringify(invalid)) === null && parseTodo(JSON.stringify({ ...board, version: 4 })) === null);
check('corrupt or duplicate IDs, invalid coordinates and unknown connections cannot become editable boards', parseTodo('{bad') === null && parseTodo(JSON.stringify({ ...board, tasks: [board.tasks[0], board.tasks[0]] })) === null && parseTodo(JSON.stringify({ ...board, tasks: [{ ...board.tasks[0], x: -1 }] })) === null && parseTodo(JSON.stringify({ ...board, connections: [{ from: board.tasks[0].id, to: 'missing' }] })) === null);
const card = { x: 50, y: 50, width: 270, height: 110 };
const below = connectionGeometry(card, { x: 50, y: 400, width: 270, height: 120 });
const above = connectionGeometry({ x: 50, y: 400, width: 270, height: 120 }, card);
const left = connectionGeometry(card, { x: -400, y: 50, width: 270, height: 110 });
check('connections join facing card edges vertically and horizontally, in either direction', !below.horizontal && below.from.y === 160 && below.to.y === 400 && above.from.y === 400 && above.to.y === 160 && left.horizontal && left.from.x === 50 && left.to.x === -130);

const entries = [
  { path: '/vault/Notes', name: 'Notes', kind: 'folder' },
  { path: '/vault/Notes/One.md', name: 'One.md', kind: 'file' },
  { path: '/vault/Notes/Two.md', name: 'Two.md', kind: 'file' },
  { path: '/vault/picture.png', name: 'picture.png', kind: 'file' },
];
const edges = graphEdges('/vault', entries, { '/vault/Notes/One.md': '[Two](./Two.md) [[Two]] [outside](../../secret.md) ![image](../picture.png)' });
check('graph includes hierarchy and deduplicates local note connections', edges.filter((edge) => edge.kind === 'hierarchy').length === 4 && edges.filter((edge) => edge.kind === 'link').length === 1 && edges.some((edge) => edge.kind === 'link' && edge.to === '/vault/Notes/Two.md'));
check('space, plus and punctuation shortcuts survive capture and validation', readShortcuts({ pin: 'Mod+Shift+!' }).pin === 'Mod+Shift+!' && keyboardShortcut({key:'+',ctrlKey:true,metaKey:false,altKey:false,shiftKey:true}, false) === 'Mod+Shift+Plus' && keyboardShortcut({key:' ',ctrlKey:false,metaKey:false,altKey:true,shiftKey:false}, false) === 'Alt+Space' && keyboardShortcut({key:'?',ctrlKey:true,metaKey:false,altKey:false,shiftKey:true}, false) === 'Mod+Shift+?');
check('editable shortcuts normalize modifiers and restore defaults for invalid values', keyboardShortcut({key:'p',ctrlKey:true,metaKey:false,altKey:false,shiftKey:true}, false) === 'Mod+Shift+P' && readShortcuts({ pin: 'Mod+Alt+P', favorite: 14 }).pin === 'Mod+Alt+P' && readShortcuts({ favorite: 14 }).favorite === DEFAULT_SHORTCUTS.favorite);
const memory = new Map(); const store = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
check('workspace names and icons persist independently from the vault', saveWorkspaceIdentities({ '/vault': { name: 'Ideas', icon: '🏔️' } }, store) && identityFor(readWorkspaceIdentities(store), '/vault', 'Vault').name === 'Ideas');

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
