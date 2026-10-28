import { savePasswordBackup } from '../src/utils/passwordBackup.ts';
let failures=0;const check=(name,ok)=>{if(ok)console.log(`  ok   ${name}`);else{failures++;console.log(`  FAIL ${name}`);}};
console.log('\nencrypted backup save location');
const token='a'.repeat(32), calls=[], encrypted='encrypted-only'; let current=true;
const native={desktop:true,call:async(command,args)=>{calls.push({command,args});if(command==='choose_password_backup')return token;}};
check('native backup uses a picker capability, not a renderer-supplied path',await savePasswordBackup(encrypted,()=>current,native)&&calls.map(x=>x.command).join(',')==='choose_password_backup,write_password_backup'&&calls[1].args.token===token&&calls[1].args.encrypted===encrypted&&!('path' in calls[1].args));
calls.length=0;const changed={...native,call:async(command,args)=>{calls.push({command,args});if(command==='choose_password_backup'){current=false;return token;}}};let stale=false;
try{await savePasswordBackup(encrypted,()=>current,changed);}catch(error){stale=String(error).includes('changed');}
check('a vault changed during the native picker cancels its capability without writing',stale&&calls.map(x=>x.command).join(',')==='choose_password_backup,cancel_password_backup');
current=true;calls.length=0;check('cancelling the native picker does not write a file',!(await savePasswordBackup(encrypted,()=>true,{...native,call:async()=>null})));
let written='',closed=false,aborted=false;const web={desktop:false,call:async()=>{},pick:async()=>({createWritable:async()=>({write:async data=>{written=data;},close:async()=>{closed=true;},abort:async()=>{aborted=true;}})})};
check('supported browsers open a Save As picker and write the encrypted snapshot',await savePasswordBackup(encrypted,()=>true,web)&&written===encrypted&&closed);
written='';let picked=false;const staleBrowser={...web,pick:async()=>{picked=true;return {createWritable:async()=>{throw Error('must not open');}};}};let refused=false;
try{await savePasswordBackup(encrypted,()=>!picked,staleBrowser);}catch(error){refused=String(error).includes('changed');}
check('a browser picker also rechecks the vault before creating a writer',refused&&!written);
let checks=0;closed=false;try{await savePasswordBackup(encrypted,()=>++checks<3,web);}catch{};
check('a change before the browser write aborts the writable',aborted&&!closed);
const abort=Object.assign(new Error('cancelled'),{name:'AbortError'});check('cancelling a browser picker is not treated as an error',!(await savePasswordBackup(encrypted,()=>true,{...web,pick:async()=>{throw abort;}})));
let unsupported=false;try{await savePasswordBackup(encrypted,()=>true,{desktop:false,call:async()=>{}});}catch(error){unsupported=String(error).includes("can't choose");}
check('unsupported browsers do not silently download to a default folder',unsupported);
globalThis.__cometFailures=(globalThis.__cometFailures??0)+failures;
