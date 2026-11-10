import { pauseStoredCloudBindings } from '../src/utils/pauseCloud.ts';
import { readFileSync } from 'node:fs';
let failures = 0;
function check(name, ok) { if (ok) console.log(`  ok   ${name}`); else { failures++; console.log(`  FAIL ${name}`); } }
console.log('\nlegacy cloud suspension and scoped sync');
const entries = new Map([
  ['comet:drive-incremental:v1:%2Fone', JSON.stringify({ group: 'a'.repeat(32), base: 'old-base', enabled: true, extra: 'keep' })],
  ['comet:rclone-sync:v1:%2Ftwo', JSON.stringify({ group: '', base: '', enabled: true, provider: 'google', remote: 'comet-rclone-google', identity: 'b'.repeat(64) })],
  ['comet:drive-incremental:v1:%2Fbad', '{damaged'],
  ['comet:rclone-sync:v1:%2Ffuture', JSON.stringify({ enabled: true, future: 'unknown format' })],
  ['comet:drive-activity:v1:%2Fone', 'history'],
  ['comet:rclone-sync:text-v2:%2Fnew', JSON.stringify({ group: '', base: '', enabled: true, provider: 'google', remote: 'comet-rclone-google', identity: 'c'.repeat(64) })],
  ['other', JSON.stringify({ enabled: true })],
]);
const store = { get length() { return entries.size; }, key: index => [...entries.keys()][index] ?? null, getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
pauseStoredCloudBindings(store);
const drive = JSON.parse(entries.get('comet:drive-incremental:v1:%2Fone'));
const rclone = JSON.parse(entries.get('comet:rclone-sync:v1:%2Ftwo'));
check('old direct Drive and rclone bindings are paused without losing baseline or identity', drive.enabled === false && drive.base === 'old-base' && drive.extra === 'keep' && rclone.enabled === false && rclone.identity === 'b'.repeat(64));
check('unrecognized records and activity history are left untouched', entries.get('comet:drive-incremental:v1:%2Fbad') === '{damaged' && entries.get('comet:rclone-sync:v1:%2Ffuture') === JSON.stringify({ enabled: true, future: 'unknown format' }) && entries.get('comet:drive-activity:v1:%2Fone') === 'history' && JSON.parse(entries.get('other')).enabled);
const blocked = { get length() { throw new Error('blocked'); }, key() { throw new Error('blocked'); }, getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
let survived = true; try { pauseStoredCloudBindings(blocked); } catch { survived = false; }
check('storage failures do not prevent the app from starting', survived);
check('scoped text bindings are not modified by legacy suspension', JSON.parse(entries.get('comet:rclone-sync:text-v2:%2Fnew')).enabled === true);
const app = readFileSync('src/App.tsx', 'utf8');
const native = readFileSync('src-tauri/src/lib.rs', 'utf8');
const handlerStart = native.indexOf('.invoke_handler(tauri::generate_handler![');
const handlers = native.slice(handlerStart);
check('the running app starts no cloud sync and has no quit-time cloud step', !/useIncrementalDrive/.test(app) && !/useRcloneSync/.test(app) && !/finishForQuit/.test(app) && !/cloudSync/.test(app));
check('release registers no cloud commands and ships no rclone', handlerStart >= 0 && !/\bgoogle::/.test(handlers) && !/\brclone_sync::/.test(handlers) && /#\[cfg\(test\)\]\nmod rclone_sync;/.test(native) && !/COMET_RCLONE_BIN/.test(readFileSync('src-tauri/build.rs', 'utf8')));
globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
