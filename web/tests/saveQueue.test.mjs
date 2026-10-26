import { SaveQueue } from '../src/utils/saveQueue.ts';

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}`); }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

console.log('\nautosave queue');
const writes = [];
const states = [];
let notices = 0;
const queue = new SaveQueue((path, content) => new Promise((resolve, reject) => {
  writes.push({ path, content, resolve, reject });
}), (state) => states.push(state), () => { notices += 1; }, 10000);
queue.queue('/vault/a.md', 'old');
const first = queue.flush();
await tick();
queue.queue('/vault/a.md', 'newest');
const second = queue.flush();
await tick();
check('serializes writes instead of racing them', writes.length === 1 && writes[0].content === 'old');
writes[0].reject(new Error('temporary failure'));
await first;
await tick();
check('a failed older write cannot replace the newer snapshot', writes.length === 2 && writes[1].content === 'newest');
writes[1].resolve();
await second;
await queue.flushAll();
check('reports the newer successful write as saved', states.at(-1) === 'saved' && notices === 0);

let attempts = 0;
const retryStates = [];
const retry = new SaveQueue(async () => {
  if (++attempts === 1) throw new Error('disk full');
}, (state) => retryStates.push(state), () => {}, 10000);
retry.queue('/vault/b.md', 'keep me');
let failed = false;
try { await retry.flushAll(); } catch { failed = true; }
check('keeps a failed latest edit and reports the error', failed && retryStates.at(-1) === 'error');
await retry.flushAll();
check('retries the retained edit successfully', attempts === 2 && retryStates.at(-1) === 'saved');

const delayedWrites = [];
const duringSwitch = new SaveQueue((_path, content) => new Promise((resolve) => {
  delayedWrites.push({ content, resolve });
}), () => {}, () => {}, 10000);
duringSwitch.queue('/vault/c.md', 'before');
const inFlight = duringSwitch.flush();
await tick();
const switching = duringSwitch.flushAll();
duringSwitch.queue('/vault/c.md', 'typed while switching');
delayedWrites[0].resolve();
await inFlight;
await tick();
check('flushes edits made while a note switch is waiting', delayedWrites[1]?.content === 'typed while switching');
delayedWrites[1].resolve();
await switching;

const recoveringWrites = [];
const recovering = new SaveQueue((_path, content) => new Promise((resolve, reject) => {
  recoveringWrites.push({ content, resolve, reject });
}), () => {}, () => {}, 10000);
recovering.queue('/vault/d.md', 'older');
const failingWrite = recovering.flush();
await tick();
const waitingSwitch = recovering.flushAll();
recovering.queue('/vault/d.md', 'newer');
recoveringWrites[0].reject(new Error('transient'));
await failingWrite;
await tick();
check('a switch waits for newer edits even when an earlier in-flight save fails', recoveringWrites[1]?.content === 'newer');
recoveringWrites[1].resolve();
await waitingSwitch;

globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
