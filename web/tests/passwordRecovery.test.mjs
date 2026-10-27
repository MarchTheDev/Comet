import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { PasswordsView } from '../src/PasswordsView.tsx';
import { derivePasswordKey, encryptPasswordData, generateRecoveryCode, makeRecoveryRecord, packPasswordStorage, PASSWORD_STORAGE_KEY, readPasswordStorage, unlockPasswordData, unlockPasswordRecovery } from '../src/utils/passwords.ts';

let failures=0;const check=(name,ok)=>{if(ok)console.log(`  ok   ${name}`);else{failures++;console.log(`  FAIL ${name}`);}};
console.log('\npassword recovery, migration and concurrency');
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const data={format:'comet-passwords-data',version:1,entries:[{id:'1',name:'Test',website:'https://example.com/',username:'someone',password:'sensitive',notes:'private'}]};
const master='long original master password', salt=webcrypto.getRandomValues(new Uint8Array(16));
const key=await derivePasswordKey(master,salt,600_000,true), legacy=await encryptPasswordData(data,key,salt);
const code=generateRecoveryCode(), otherCode=generateRecoveryCode(), record=await makeRecoveryRecord(key,salt,code), bundled=packPasswordStorage(legacy,record);
check('legacy vaults remain readable without rewriting',readPasswordStorage(legacy)?.recovery===null && (await unlockPasswordData(readPasswordStorage(legacy).envelope,master)).data.entries[0].password==='sensitive');
check('recovery uses independent random 256-bit codes that are not stored',/^(?:[0-9A-F]{8}-){7}[0-9A-F]{8}$/.test(code)&&code!==otherCode&&!bundled.includes(code)&&!bundled.includes(code.replaceAll('-','')));
check('master and recovery code independently decrypt the same vault',(await unlockPasswordData(readPasswordStorage(bundled).envelope,master)).data.entries[0].password==='sensitive'&&(await unlockPasswordRecovery(bundled,code.toLowerCase().replaceAll('-',' '))).data.entries[0].password==='sensitive');
let wrong=false;try{await unlockPasswordRecovery(bundled,otherCode);}catch{wrong=true;}
check('wrong recovery code is rejected without changing encrypted data',wrong&&readPasswordStorage(bundled)?.envelope===legacy);
let bad=JSON.parse(bundled);bad.recovery.salt='AAAAAAAAAAAAAAAAAAAAAA==';
check('mismatched recovery metadata is rejected instead of replacing the vault',readPasswordStorage(JSON.stringify(bad))===null);
bad=JSON.parse(bundled);bad.version=2;check('newer or malformed password bundles are refused',readPasswordStorage(JSON.stringify(bad))===null&&readPasswordStorage('{')===null);
const newMaster='new replacement master password', newSalt=webcrypto.getRandomValues(new Uint8Array(16)), newKey=await derivePasswordKey(newMaster,newSalt,600_000,true);
const newRaw=packPasswordStorage(await encryptPasswordData((await unlockPasswordRecovery(bundled,code)).data,newKey,newSalt),await makeRecoveryRecord(newKey,newSalt,code));
let oldFails=false;try{await unlockPasswordData(readPasswordStorage(newRaw).envelope,master);}catch{oldFails=true;}
check('reset rotates the password key and salt while keeping recovery usable',oldFails&&(await unlockPasswordData(readPasswordStorage(newRaw).envelope,newMaster)).data.entries[0].password==='sensitive'&&(await unlockPasswordRecovery(newRaw,code)).data.entries[0].password==='sensitive');
check('a previous backup retains its original password and recovery state',(await unlockPasswordData(readPasswordStorage(bundled).envelope,master)).data.entries.length===1&&(await unlockPasswordRecovery(bundled,code)).data.entries.length===1);
const rotated=packPasswordStorage(legacy,await makeRecoveryRecord(key,salt,otherCode));let previousFails=false;try{await unlockPasswordRecovery(rotated,code);}catch{previousFails=true;}
check('replacing a recovery code invalidates the old code only for the new backup',previousFails&&(await unlockPasswordRecovery(rotated,otherCode)).data.entries.length===1&&(await unlockPasswordRecovery(bundled,code)).data.entries.length===1);

// Exercise the component with a real WebCrypto implementation and real storage.
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{pretendToBeVisual:true,url:'https://comet-password.test/'});
dom.window.HTMLElement.prototype.attachEvent=function(name,listener){this.addEventListener(name.replace(/^on/,''),listener);};dom.window.HTMLElement.prototype.detachEvent=function(name,listener){this.removeEventListener(name.replace(/^on/,''),listener);};
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.localStorage=dom.window.localStorage;globalThis.Node=dom.window.Node;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});localStorage.setItem(PASSWORD_STORAGE_KEY,bundled);
const root=createRoot(document.getElementById('root'));
const click=async element=>act(async()=>element.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true})));
const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===text);
const fill=async(element,text)=>act(async()=>{element.focus();Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(element,text);const e=new dom.window.Event('propertychange',{bubbles:true});Object.defineProperty(e,'propertyName',{value:'value'});element.dispatchEvent(e);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
const submit=async()=>act(async()=>document.querySelector('form.password-unlock').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
const wait=async(test)=>{for(let i=0;i<60&&!test();i++)await act(async()=>new Promise(r=>setTimeout(r,50)));};
await act(async()=>root.render(React.createElement(PasswordsView)));
await click(button('Forgot master password? Use recovery code'));
let inputs=document.querySelectorAll('.password-unlock input');await fill(inputs[0],otherCode);await fill(inputs[1],newMaster);await fill(inputs[2],newMaster);await submit();await wait(()=>!!document.querySelector('[role="alert"]'));
check('failed recovery in the UI leaves the original vault byte-identical',localStorage.getItem(PASSWORD_STORAGE_KEY)===bundled&&!!document.querySelector('[role="alert"]'));
await fill(inputs[0],code);await submit();await wait(()=>!!button('Lock'));
const updated=localStorage.getItem(PASSWORD_STORAGE_KEY);
check('the recovery UI resets and unlocks without losing existing entries',!!button('Lock')&&document.querySelector('.password-list')?.textContent.includes('Test')&&(await unlockPasswordData(readPasswordStorage(updated).envelope,newMaster)).data.entries[0].password==='sensitive');
await click(button('Lock'));await click(button('Forgot master password? Use recovery code'));
inputs=document.querySelectorAll('.password-unlock input');await fill(inputs[0],code);await fill(inputs[1],master);await fill(inputs[2],master);
await submit();const external='changed elsewhere';localStorage.setItem(PASSWORD_STORAGE_KEY,external);await wait(()=>!!document.querySelector('[role="alert"]'));
check('recovery refuses to overwrite a vault changed in another window',localStorage.getItem(PASSWORD_STORAGE_KEY)===external&&document.querySelector('[role="alert"]')?.textContent.includes('elsewhere'));
await act(async()=>root.unmount());dom.window.close();delete globalThis.IS_REACT_ACT_ENVIRONMENT;delete globalThis.localStorage;
globalThis.__cometFailures=(globalThis.__cometFailures??0)+failures;
