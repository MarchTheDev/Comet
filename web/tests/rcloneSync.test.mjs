import { JSDOM } from 'jsdom';
import { accountForBinding, readRcloneBinding, rcloneBindingKey, saveRcloneBinding, validRcloneBinding } from '../src/utils/rcloneBinding.ts';

let failures=0;const check=(name,ok)=>{if(ok)console.log(`  ok   ${name}`);else{failures++;console.log(`  FAIL ${name}`);}};
console.log('\nrclone workspace binding safety');
const dom=new JSDOM('',{url:'https://comet-cloud.test/'});globalThis.localStorage=dom.window.localStorage;
const account={provider:'icloud',remote:`comet-icloud-${'a'.repeat(32)}`,identity:'b'.repeat(64),label:'example'};
const binding={group:'c'.repeat(32),base:'d'.repeat(32),enabled:true,remote:account.remote,provider:account.provider,identity:account.identity};
check('only valid, scoped provider bindings are accepted',validRcloneBinding(binding)&&!validRcloneBinding({...binding,remote:'../../outside'})&&!validRcloneBinding({...binding,identity:'bad'})&&!validRcloneBinding({...binding,provider:'google'}));
check('an offline first sync has a valid pending intent but no partial baseline',validRcloneBinding({...binding,group:'',base:''})&&!validRcloneBinding({...binding,group:'',base:binding.base})&&!validRcloneBinding({...binding,group:binding.group,base:''}));
saveRcloneBinding('/vault',binding);check('cloud bindings round-trip and are stored separately from direct Drive',JSON.stringify(readRcloneBinding('/vault'))===JSON.stringify(binding)&&rcloneBindingKey('/vault').includes('rclone-sync'));
const reconnected={...account,remote:`comet-icloud-${'e'.repeat(32)}`};
check('a replacement iCloud session resumes only the same account identity',accountForBinding(binding,[reconnected])?.remote===reconnected.remote&&accountForBinding(binding,[{...reconnected,identity:'f'.repeat(64)}])===null);
check('the original authorization is preferred when still present',accountForBinding(binding,[reconnected,account])?.remote===account.remote);
localStorage.setItem(rcloneBindingKey('/vault'),'{corrupt');check('corrupt state cannot turn into a sync connection',readRcloneBinding('/vault')===null);
const originalSet=dom.window.Storage.prototype.setItem;dom.window.Storage.prototype.setItem=function(){throw Error('full');};let rejected=false;
try{saveRcloneBinding('/vault',binding);}catch{rejected=true;}check('unavailable storage prevents claiming a saved cloud baseline',rejected);dom.window.Storage.prototype.setItem=originalSet;
dom.window.close();delete globalThis.localStorage;globalThis.__cometFailures=(globalThis.__cometFailures??0)+failures;
