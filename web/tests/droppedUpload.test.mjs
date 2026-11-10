import { DROPPED_CHUNK_BYTES, ensureSampleStorageCapacity, streamDroppedFile } from '../src/utils/droppedUpload.ts';
let failures=0;const check=(name,ok)=>{if(ok)console.log(`  ok   ${name}`);else{failures++;console.log(`  FAIL ${name}`);}};
console.log('\nstreamed file uploads');
const size=20*1024*1024+37;
let maxChunk=0, appended=0, calls=[], progress=[];
const file={size,slice(start,end){return {async arrayBuffer(){return new Uint8Array(end-start).buffer;}};}};
const invoke=async(command,args)=>{calls.push(command);if(command==='begin_dropped_upload')return 'session';if(command==='append_dropped_upload'){maxChunk=Math.max(maxChunk,args.bytes.length);if(args.offset!==appended)throw new Error('bad offset');appended+=args.bytes.length;}};
await streamDroppedFile(file,'/vault','/vault/large.bin',invoke,(loaded,total)=>progress.push([loaded,total]),()=>true);
check('files larger than 20 MB use bounded sequential chunks with real progress',appended===size&&maxChunk<=DROPPED_CHUNK_BYTES&&calls.at(-1)==='finish_dropped_upload'&&progress.at(-1)[0]===size&&!calls.includes('abort_dropped_upload'));
let failedCalls=[];const fails=async(command,args)=>{failedCalls.push(command);if(command==='begin_dropped_upload')return 'session';if(command==='append_dropped_upload')throw new Error('disk full');};
let rejected=false;try{await streamDroppedFile(file,'/vault','/vault/a',fails,()=>{},()=>true);}catch{rejected=true;}
check('failed chunks abort staging and never publish a partial file',rejected&&failedCalls.includes('abort_dropped_upload')&&!failedCalls.includes('finish_dropped_upload'));
let allowed=true, cancelCalls=[];const cancel=async(command,args)=>{cancelCalls.push(command);if(command==='begin_dropped_upload')return 'session';if(command==='append_dropped_upload')allowed=false;};
rejected=false;try{await streamDroppedFile(file,'/vault','/vault/a',cancel,()=>{},()=>allowed);}catch{rejected=true;}
check('changing workspace cancels staging before publication',rejected&&cancelCalls.includes('abort_dropped_upload')&&!cancelCalls.includes('finish_dropped_upload'));
let emptyCalls=[];await streamDroppedFile({...file,size:0},'/vault','/vault/empty',async(c)=>{emptyCalls.push(c);return c==='begin_dropped_upload'?'zero':undefined;},()=>{},()=>true);
check('empty files publish without invalid empty chunks',emptyCalls.join(',')==='begin_dropped_upload,finish_dropped_upload');
let probe=new Map();const storage={setItem(k,v){if(v.length>1_000_000)throw new Error('quota');probe.set(k,v);},removeItem(k){probe.delete(k);}};
rejected=false;try{ensureSampleStorageCapacity(size,false,storage);}catch(error){rejected=error.message.includes('sample storage');}
check('sample imports check the real browser storage quota before reading large files',rejected&&probe.size===0);
const roomy={setItem(k,v){probe.set(k,v.length);},removeItem(k){probe.delete(k);}};
ensureSampleStorageCapacity(size,true,roomy);
check('the browser sample has no fixed 20 MB file-size check',probe.size===0);
globalThis.__cometFailures=(globalThis.__cometFailures??0)+failures;
