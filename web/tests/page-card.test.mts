import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { buildOnce, domWindow } from './support.mts';
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: 'https://page-card.test/', settings: { navigation: { disableChildFrameNavigation: true } } }));
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const directory = await mkdtemp(join(tmpdir(), 'bot-page-card-'));
const source = new URL('../src/', import.meta.url).pathname;
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' }, ssr: { noExternal: true },
  plugins: [{ name: 'page-card-test', resolveId: id => id.endsWith('virtual:page-card-test') ? '\0page-card-test' : undefined,
    load: id => id === '\0page-card-test' ? `export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'; export { PageCard } from ${JSON.stringify(`${source}components/Cards.tsx`)}; export { t3 } from ${JSON.stringify(`${source}lib/t3.ts`)};` : undefined }],
  build: { ssr: 'virtual:page-card-test', write: false, rollupOptions: { output: { entryFileNames: 'entry.mjs', chunkFileNames: '[name]-[hash].mjs' } } } });
for (const output of bundle.output) { const path = join(directory, output.fileName); await mkdir(dirname(path), { recursive: true }); await writeFile(path, output.type === 'chunk' ? output.code : output.source); }
const { createElement: h, act, createRoot, PageCard, t3 } = await import(pathToFileURL(join(directory, 'entry.mjs')).href);
const entry = { kind: 'page', id: 'counter-item', attachmentId: 'counter-file', title: 'Sample counter card', heights: [], height: 480 };
const html = '<!doctype html><html><head><title>Counter</title></head><body><h1>Counter</h1><button onclick="this.textContent=Number(this.textContent)+1">0</button></body></html>';
const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async fn => act(async () => { fn(); await flush(); });
let root, host, calls, fetches, response, rpc;
const render = async (value = entry) => settle(() => root.render(h(PageCard, { entry: value })));
const openButton = () => host.querySelector('button[aria-label="Open page, Sample counter card"]');
const click = async element => { assert.ok(element, 'control exists'); await settle(() => element.click()); };
beforeEach(() => {
  calls = []; fetches = []; response = () => new Response(html); rpc = async () => ({ relativeUrl: '/assets/counter' });
  t3.call = async (tag, payload) => { calls.push({ tag, payload }); return rpc(tag, payload); };
  globalThis.fetch = async (url, init) => { fetches.push({ url, init }); return response(url, init); };
  host = document.createElement('main'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await settle(() => root.unmount()); document.body.replaceChildren(); document.body.style.overflow = ''; });
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(directory, { recursive: true }); });

test('Page shows inline as an interactive sandboxed frame with a corner expand button and no footer', async () => {
  await render();
  const open = openButton(); assert.ok(open); assert.equal(open.tagName, 'BUTTON'); assert.equal(open.disabled, false);
  assert.ok(open.classList.contains('page-card-expand'));
  const preview = host.querySelector('iframe'); assert.equal(preview.closest('[inert]'), null);
  assert.equal(preview.getAttribute('aria-hidden'), null); assert.equal(preview.getAttribute('title'), 'Sample counter card');
  assert.equal(preview.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(host.querySelector('.page-card-footer'), null);
  assert.equal(document.querySelector('dialog'), null);
  assert.deepEqual(calls[0].payload.resource, { _tag: 'attachment', attachmentId: 'counter-file', disposition: 'inline' });
});

test('open presents the actual interactive sandboxed Page; Close and Escape restore focus to the chat card', async () => {
  document.body.style.overflow = 'auto'; await render();
  const open = openButton(); assert.ok(open); open.focus(); await click(open);
  const dialog = document.querySelector('dialog'); assert.ok(dialog); assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute('aria-label'), 'Sample counter card');
  const frame = dialog.querySelector('iframe'); assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-popups');
  assert.match(frame.srcdoc, /onclick="this.textContent=Number\(this.textContent\)\+1"/);
  assert.equal(frame.closest('[inert]'), null); assert.equal(frame.getAttribute('aria-hidden'), null);
  const close = dialog.querySelector('button[aria-label="Close page"]'); assert.equal(document.activeElement, close);
  const original = dialog.querySelector<HTMLAnchorElement>('a[aria-label="Open in new tab"]'); assert.equal(original.getAttribute('href'), '/t3/assets/counter'); assert.equal(original.rel, 'noreferrer');
  assert.equal(dialog.querySelector('[aria-label="Share"]'), null);
  await click(close); assert.equal(document.querySelector('dialog'), null); assert.equal(document.activeElement, open); assert.equal(document.body.style.overflow, 'auto');
  await click(open); await settle(() => document.querySelector('dialog').dispatchEvent(new window.Event('cancel', { cancelable: true })));
  assert.equal(document.querySelector('dialog'), null); assert.equal(document.activeElement, open);
  assert.equal(calls.length, 1); assert.equal(fetches.length, 1);
});

test('failed asset loads show a retry, and retry gets a fresh signed URL without exposing a broken page', async () => {
  response = () => new Response('Missing', { status: 404 }); await render();
  assert.match(host.querySelector('[role="alert"]').textContent, /Couldn't load/);
  assert.equal(host.querySelector('iframe'), null); assert.equal(openButton()?.disabled ?? true, true);
  response = () => new Response(html); await click([...host.querySelectorAll('button')].find(button => button.textContent === 'Retry'));
  assert.equal(calls.length, 2); assert.ok(openButton()); assert.equal(openButton().disabled, false);
});

test('switching Page cancels stale work and ignores old attachment content', async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  response = url => url.endsWith('/counter') ? pending : new Response('<h1>Current page</h1>');
  await render(); const oldRequest = fetches[0];
  rpc = async () => ({ relativeUrl: '/assets/new' });
  await render({ ...entry, attachmentId: 'new-file', title: 'Current page' });
  await settle(() => resolve(new Response('<h1>Old page</h1>')));
  assert.equal(oldRequest.init.signal.aborted, true);
  assert.match(host.querySelector('iframe').srcdoc, /Current page/); assert.doesNotMatch(host.querySelector('iframe').srcdoc, /Old page/);
  assert.equal(host.querySelector('button[aria-label="Open page, Current page"]').disabled, false);
});

test('Page theme follows the app for fragments and full documents without broadening sandbox permissions', async () => {
  response = () => new Response('<!doctype html><html><body><h1>Fragment</h1></body></html>');
  await render({ ...entry, title: '  ' });
  const preview = host.querySelector('iframe');
  assert.ok(host.querySelector('button[aria-label="Open page, Untitled page"]'));
  assert.match(preview.srcdoc, /^<!doctype html><html><head><style id="t3-theme">/);
  assert.match(preview.srcdoc, /color-scheme:light/);
  await settle(() => document.documentElement.classList.add('dark'));
  await window.happyDOM.waitUntilComplete(); await settle(() => {});
  assert.match(preview.srcdoc, /color-scheme:dark/);
  await click(host.querySelector('button[aria-label="Open page, Untitled page"]'));
  assert.match(document.querySelector<HTMLIFrameElement>('dialog iframe').srcdoc, /color-scheme:dark/);
  assert.equal(preview.sandbox.contains('allow-same-origin'), false);
  assert.equal(document.querySelector<HTMLIFrameElement>('dialog iframe').sandbox.contains('allow-same-origin'), false);
  await settle(() => document.documentElement.classList.remove('dark'));
});

test('only finite height updates from the preview window affect its bounded canvas', async () => {
  await render(); const preview = host.querySelector('iframe');
  const post = (source, value) => settle(() => window.dispatchEvent(new window.MessageEvent('message', { source, data: { botPageHeight: value } })));
  await post(window, 1300); assert.equal(preview.style.height, '480px');
  await post(preview.contentWindow, Infinity); assert.equal(preview.style.height, '480px');
  await post(preview.contentWindow, -4); assert.equal(preview.style.height, '480px');
  await post(preview.contentWindow, 100000); assert.equal(preview.style.height, '1400px');
  await post(preview.contentWindow, 600); assert.equal(preview.style.height, '600px');
  await click(openButton());
  await post(document.querySelector<HTMLIFrameElement>('dialog iframe').contentWindow, 1200);
  assert.equal(preview.style.height, '600px');
});
