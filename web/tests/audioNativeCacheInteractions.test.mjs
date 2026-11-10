import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { indexedDB } from 'fake-indexeddb';

let failures = 0;
const check = (name, ok) => { if (ok) console.log(`  ok   ${name}`); else { failures++; console.log(`  FAIL ${name}`); } };
console.log('\naudio native cache bridge (mocked native commands)');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'https://comet-audio-native.test/' });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage; globalThis.Node = dom.window.Node; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true; globalThis.isTauri = true; globalThis.indexedDB = indexedDB;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.cancelAnimationFrame = () => {}; dom.window.HTMLCanvasElement.prototype.getContext = () => null;
const ids = { '/vault/embedded.mp3': 'a'.repeat(64), '/vault/slow.mp3': 'b'.repeat(64), '/vault/new.mp3': 'c'.repeat(64) };
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+NqkAAAAASUVORK5CYII=';
const art = { url: 'https://is1-ssl.mzstatic.com/image/a.png', mime: 'image/png', data: image };
const aliases = new Map([[ids['/vault/slow.mp3'], { query: 'some artist track', artwork: art }]]), calls = [];
let lookupCount = 0, scans = 0;
dom.window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
  calls.push({ command, args });
  if (command === 'music_file_fingerprint') return ids[args.path];
  if (command === 'read_audio_metadata') return args.fingerprint === ids['/vault/embedded.mp3'] ? { title: 'Native title', artist: 'Native artist', mime: 'image/png', data: image } : null;
  if (command === 'read_music_cover_for_file') return aliases.get(args.fingerprint) ?? null;
  if (command === 'read_cached_music_cover') return null;
  if (command === 'lookup_music_cover') { lookupCount++; return art; }
  if (command === 'remember_music_cover_for_file') { aliases.set(args.fingerprint, { query: args.query, artwork: art }); return; }
}};
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  scans++;
  if (String(url).includes('slow')) return new Promise((resolve, reject) => options?.signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
  throw Error('metadata unavailable');
};
const { AudioPlayer } = await import('../src/MediaPlayer.tsx');
const root = createRoot(document.getElementById('root'));
const render = async path => { await act(async () => { root.render(React.createElement(AudioPlayer, { key: path, url: `https://audio.test/${path.split('/').at(-1)}`, name: path.split('/').at(-1), vault: '/vault', path })); await new Promise(resolve => setTimeout(resolve, 80)); }); };
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); }); };
await render('/vault/embedded.mp3'); await settle();
check('native embedded tags and artwork restore without scanning or a catalog lookup', document.querySelector('.audio-copy h3')?.textContent === 'Native title' && document.querySelector('.audio-art img')?.src.startsWith('blob:') && scans === 0 && lookupCount === 0);
await render('/vault/slow.mp3'); await settle();
check('native file alias displays artwork before a slow metadata scan finishes', !!document.querySelector('.audio-art img')?.src.startsWith('blob:') && lookupCount === 0 && scans === 1);
await render('/vault/new.mp3'); await settle();
check('a new file performs one lookup and persists a native file alias', lookupCount === 1 && aliases.has(ids['/vault/new.mp3']) && calls.some(call => call.command === 'remember_music_cover_for_file' && call.args.fingerprint === ids['/vault/new.mp3']));
await render('/vault/slow.mp3'); await settle();
const before = lookupCount; localStorage.clear();
await render('/vault/new.mp3'); await settle();
check('the native alias restores offline even if browser-local aliases were removed', !!document.querySelector('.audio-art img')?.src.startsWith('blob:') && lookupCount === before && calls.filter(call => call.command === 'read_music_cover_for_file' && call.args.fingerprint === ids['/vault/new.mp3']).length >= 2);
await act(async () => root.unmount());
dom.window.close(); globalThis.fetch = oldFetch; delete globalThis.localStorage; delete globalThis.indexedDB; delete globalThis.isTauri; delete globalThis.cancelAnimationFrame; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.__cometFailures = (globalThis.__cometFailures ?? 0) + failures;
