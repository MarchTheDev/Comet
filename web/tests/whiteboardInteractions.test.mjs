import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { Whiteboard } from '../src/Whiteboard.tsx';
import { newWhiteboard, parseWhiteboard, serializeWhiteboard } from '../src/utils/whiteboard.ts';
let failures=0;const check=(name,ok)=>{if(ok)console.log(`  ok   ${name}`);else{failures++;console.log(`  FAIL ${name}`);}};
console.log('\nwhiteboard interactions');
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{pretendToBeVisual:true,url:'https://comet-whiteboard.test/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.Node=dom.window.Node;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
let current=newWhiteboard();function Harness(){const [board,setBoard]=useState(current);return React.createElement(Whiteboard,{board,name:'Canvas',saveState:'saved',onChange(next){current=next;setBoard(next);return true;},onRename(){},onRetry(){}});}
const root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Harness)));
const click=async element=>act(async()=>element.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true})));
const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===text);
const pointer=(type,x,y)=>{const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});return event;};
const fire=async(element,event)=>act(async()=>element.dispatchEvent(event));
await click(button('Text'));await click(button('To-do'));
check('new whiteboard items are spaced apart',current.items.length===2 && (current.items[0].x!==current.items[1].x || current.items[0].y!==current.items[1].y));
const stage=document.querySelector('.whiteboard-stage');stage.setPointerCapture=()=>{};Object.defineProperty(stage,'offsetWidth',{value:500});stage.getBoundingClientRect=()=>({left:0,top:0,width:500,height:400});stage.scrollLeft=200;stage.scrollTop=200;
await fire(stage,pointer('pointerdown',300,250));await fire(stage,pointer('pointermove',240,200));await fire(stage,pointer('pointerup',240,200));
check('the whiteboard uses a scrollable canvas and pans with a drag',stage.classList.contains('todo-canvas')&&stage.scrollLeft===260&&stage.scrollTop===250);
document.elementFromPoint=()=>document.querySelector('.whiteboard-todo');await fire(document.querySelector('[aria-label="Connect text to another item"]'),pointer('pointerdown',100,100));await fire(window,pointer('pointermove',200,200));await fire(window,pointer('pointerup',200,200));
check('dragging a connection dot links whiteboard items', current.connections.length===1 && !!document.querySelector('[aria-label="Select whiteboard connection"]'));
const css=readFileSync('src/index.css','utf8');check('connection dots become visible on whiteboard hover',/\.whiteboard-item:hover\s+\.todo-connect-dot[^}]*opacity\s*:\s*1/.test(css));
await click(button('Shape'));await click(button('Ellipse'));
check('choosing a shape arms the drawing tool without placing an item',current.items.length===2);
await fire(stage,pointer('pointerdown',300,250));await fire(stage,pointer('pointermove',380,310));await fire(stage,pointer('pointerup',380,310));
const shape=current.items.at(-1);
check('drawing a shape uses the pointer bounds, including small sizes',shape.type==='shape'&&shape.shape==='ellipse'&&shape.width===80&&shape.height===60&&parseWhiteboard(serializeWhiteboard(current))?.items.at(-1).width===80);
await click(button('Shape'));await click(button('Rectangle'));await fire(stage,pointer('pointerdown',310,260));await fire(stage,pointer('pointermove',390,330));await fire(stage,pointer('pointercancel',390,330));
check('cancelling a shape gesture does not add an item',current.items.length===3);
await fire(stage,pointer('pointerdown',310,260));await fire(stage,pointer('pointermove',390,330));await fire(window,new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await fire(stage,pointer('pointerup',390,330));
check('Escape cancels an in-progress shape and disarms the tool',current.items.length===3&&!document.querySelector('.whiteboard-shape-hint'));

check('shape outlines are transparent and item handles respect stacking order',/\.whiteboard-item\s*\{\s*z-index:0/.test(css)&&/\.whiteboard-shape-visual > \*, \.whiteboard-shape-preview > \*\s*\{\s*fill:none/.test(css));

await act(async()=>root.unmount());dom.window.close();delete globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.__cometFailures=(globalThis.__cometFailures??0)+failures;
