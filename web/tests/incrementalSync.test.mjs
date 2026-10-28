import { JSDOM } from 'jsdom';
import { DriveSyncRunner, bindingKey, readDriveBinding, saveDriveBinding, validBinding } from '../src/utils/incrementalSync.ts';

let failures = 0;
const check = (name, ok) => { if (ok) console.log(`  ok   ${name}`); else { failures++; console.log(`  FAIL ${name}`); } };
console.log('\nincremental sync orchestration');
const dom = new JSDOM('', { url:'https://comet-incremental.test/' });
globalThis.localStorage = dom.window.localStorage;
const vault='/my/workspace', initial={group:'a'.repeat(32),base:'base1',enabled:true};
const applied={applied:1,deleted:1,conflicts:1,safetyFolder:'/safe',changedPaths:['notes/a.md','gone.md']};
let calls=[], saved=[], current=true, block=false, failure='', more=0, sequence=0;
const adapter={
  phase: phase => calls.push(`phase:${phase}`),
  prepare: async (path, group, base) => { calls.push(['prepare',path,group,base]); if(failure==='prepare') throw Error('offline'); return {ticket:'b'.repeat(32),incoming:true}; },
  beforeApply: async () => {calls.push('before'); return !block;},
  apply: async () => {calls.push('apply'); if(failure==='apply') throw Error('partial merge'); return applied;},
  afterApply: async (_vault, result) => {calls.push(['after',result]); if(failure==='refresh') throw Error('refresh failed');},
  publish: async () => {calls.push('publish'); if(failure==='publish') throw Error('offline upload'); return {group:initial.group,base:`base${++sequence+1}`,uploaded:1,downloaded:1,more:more-- > 0};},
  abort: async () => {calls.push('abort');},
  isCurrent: () => current,
  save: (_path, binding) => {calls.push('save'); if(failure==='storage') throw Error('storage full'); saved.push(binding);},
};
const runner=new DriveSyncRunner(adapter);
let result=await runner.run(vault,initial);
check('network preparation precedes guarded local application and background publication', JSON.stringify(calls.map(x=>Array.isArray(x)?x[0]:x))===JSON.stringify(['phase:checking','prepare','before','phase:applying','apply','after','phase:uploading','publish','save']));
check('successful publication advances the baseline and reports conflict backups',saved[0].base==='base2'&&result.summary.conflicts===1&&result.summary.safetyFolder==='/safe'&&result.summary.changedPaths.includes('gone.md'));
calls=[];saved=[];failure='prepare';try {await runner.run(vault,initial);}catch(e){check('offline preparation preserves the original baseline and never blocks the editor',e.message.includes('offline')&&!saved.length&&!calls.includes('before'));}
failure='publish';calls=[];try{await runner.run(vault,initial);}catch(e){check('interrupted publication releases the guard and never advances baseline',e.message.includes('/safe')&&!saved.length&&calls.some(c=>Array.isArray(c)&&c[0]==='after')&&calls.includes('abort'));}
failure='apply';calls=[];try{await runner.run(vault,initial);}catch(e){check('a partial local merge always refreshes and aborts without publication',e.message.includes('partial merge')&&calls.some(c=>Array.isArray(c)&&c[0]==='after'&&c[1]===null)&&!calls.includes('publish')&&calls.includes('abort'));}
failure='refresh';calls=[];try{await runner.run(vault,initial);}catch(e){check('a failed editor refresh stops before publishing and releases the job',e.message.includes('refresh failed')&&!calls.includes('publish')&&calls.includes('abort'));}
failure='storage';calls=[];try{await runner.run(vault,initial);}catch(e){check('device storage failures are surfaced after publication without claiming a saved binding',e.message.includes('could not save its sync state')&&!saved.length);}
failure='';calls=[];current=false;result=await runner.run(vault,initial);current=true;check('switching workspaces during a download aborts before any local merge',result===null&&calls.includes('abort')&&!calls.includes('before'));
calls=[];block=true;result=await runner.run(vault,initial);block=false;check('active editor/import guard defers the merge and aborts the prepared job',result===null&&calls.includes('abort')&&!calls.includes('apply'));
calls=[];saved=[];more=2;result=await runner.run(vault,initial);check('concurrent heads are merged in bounded passes and each published baseline is stored',saved.length===3&&result.summary.conflicts===3&&result.summary.uploaded===3&&!result.summary.more);
check('a valid binding requires a scoped workspace ID, baseline, and explicit enabled flag',validBinding(initial)&&!validBinding({...initial,base:'../escape'})&&!validBinding({...initial,group:'other'})&&!validBinding({...initial,enabled:undefined}));
saveDriveBinding(vault,initial);check('workspace bindings round-trip independently of legacy snapshot bindings',JSON.stringify(readDriveBinding(vault))===JSON.stringify(initial)&&bindingKey(vault).includes('drive-incremental'));
localStorage.setItem(bindingKey(vault),'{bad json');check('corrupt sync state never turns into a valid binding',readDriveBinding(vault)===null);
dom.window.close();delete globalThis.localStorage;
globalThis.__cometFailures=(globalThis.__cometFailures??0)+failures;
