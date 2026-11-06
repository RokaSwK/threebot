import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { buildOnce, domWindow } from './support.mts';

const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: 'https://computer.test/' }));
for (const key of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof IntersectionObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const sockets = [];
class Socket {
  static OPEN = 1; readyState = 1; messages = [];
  url: string;
  onmessage?: (event: { data: string }) => void;
  constructor(url: string) { this.url = url; sockets.push(this); }
  send(value) { this.messages.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
globalThis.WebSocket = Socket as unknown as typeof WebSocket;
const directory = await mkdtemp(join(tmpdir(), 'bot-computer-browser-'));
const src = new URL('../src/', import.meta.url).pathname;
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' }, ssr: { noExternal: true },
  plugins: [{ name: 'computer-browser-test', resolveId: id => id.endsWith('virtual:computer-browser') ? '\0computer-browser' : undefined,
    load: id => id === '\0computer-browser' ? `
export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client';
export * from ${JSON.stringify(src + 'lib/previewApi.ts')};
export * from ${JSON.stringify(src + 'lib/deviceApi.ts')};
export { ComputerOverlay } from ${JSON.stringify(src + 'components/Computer.tsx')};
export { useApp } from ${JSON.stringify(src + 'store.ts')};
export { t3 } from ${JSON.stringify(src + 'lib/t3.ts')};` : undefined }],
  build: { ssr: 'virtual:computer-browser', write: false, rollupOptions: { output: { entryFileNames: 'entry.mjs', chunkFileNames: '[name]-[hash].mjs' } } } });
for (const output of bundle.output) { const path = join(directory, output.fileName); await mkdir(dirname(path), { recursive: true }); await writeFile(path, output.type === 'chunk' ? output.code : output.source); }
const api = await import(pathToFileURL(join(directory, 'entry.mjs')).href);
const { createElement: h, act, createRoot, useApp, t3, ComputerOverlay } = api;
const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = fn => act(async () => { await fn(); await flush(); });
const deferred = () => { let resolve: (value?: unknown) => void, reject: (reason?: unknown) => void; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const session = (tabId = 'tab', extra = {}) => ({ threadId: 'thread', tabId, runtime: 'server', profileId: 'incognito', navStatus: { _tag: 'Success', title: 'Example', url: 'https://example.test' }, ...extra });
const list = (sessions = [session()], revision = 1, serverEpoch = 'server-a') => ({ sessions, revision, serverEpoch });
const event = (type, revision, extra = {}) => ({ type, threadId: 'thread', tabId: 'tab', revision, serverEpoch: 'server-a', createdAt: '2026-01-01T00:00:00Z', ...(type === 'closed' || type === 'failed' ? {} : { snapshot: session() }), ...extra });
function client() {
  const requests = [], subscriptions = [], reconnects = new Set<() => void>(), states = new Set<(state: string) => void>();
  return { state: 'open', requests, subscriptions,
    call: (tag, payload) => { const request = { tag, payload, ...deferred() }; requests.push(request); return request.promise; },
    stream: (tag, payload, receive) => { const completion = deferred(); const sub = { tag, payload, receive, completion, cancelled: false, done: completion.promise, cancel() { this.cancelled = true; } }; subscriptions.push(sub); return sub; },
    onReconnect: fn => { reconnects.add(fn); return () => reconnects.delete(fn); },
    onState: fn => { states.add(fn); return () => states.delete(fn); },
    reconnect: () => { for (const fn of reconnects) fn(); },
    disconnect: () => { for (const fn of states) fn('closed'); },
  };
}
const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); document.body.replaceChildren(); });
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(directory, { recursive: true }); });

test('browser observer subscribes before listing and replays an event that overtakes the list', async () => {
  const rpc = client(), states = [];
  const watcher = api.watchBrowser('thread', state => states.push(state), rpc); cleanup.push(watcher.dispose);
  assert.deepEqual(rpc.subscriptions.map(sub => sub.tag), ['subscribePreviewEvents']);
  assert.deepEqual(rpc.requests.map(({ tag, payload }) => ({ tag, payload })), [{ tag: 'preview.list', payload: { threadId: 'thread' } }]);
  rpc.subscriptions[0].receive(event('opened', 2, { tabId: 'new', snapshot: session('new') }));
  rpc.requests[0].resolve(list()); await flush();
  assert.deepEqual(states.at(-1).index.tabs.map(tab => tab.tabId), ['tab', 'new']);
  assert.equal(states.at(-1).index.revision, 2);
  rpc.subscriptions[0].receive(event('navigated', 3, { snapshot: session('tab', { navStatus: { _tag: 'Loading', title: 'Loading', url: 'https://example.test/new' } }) }));
  assert.deepEqual(states.at(-1).index.tabs.map(tab => tab.tabId), ['tab', 'new']);
  rpc.subscriptions[0].receive(event('closed', 4));
  rpc.subscriptions[0].receive(event('opened', 2));
  assert.deepEqual(states.at(-1).index.tabs.map(tab => tab.tabId), ['new']);
  rpc.subscriptions[0].receive(event('opened', 99, { threadId: 'another-bot', snapshot: session('foreign', { threadId: 'another-bot' }) }));
  assert.equal(rpc.requests.length, 1); // No poll or hidden open/status mutation.
});

test('reconnect cancels the old stream, ignores old responses, and accepts a reset revision', async () => {
  const rpc = client(), states = [];
  const watcher = api.watchBrowser('thread', state => states.push(state), rpc); cleanup.push(watcher.dispose);
  rpc.disconnect(); rpc.reconnect();
  assert.equal(rpc.subscriptions[0].cancelled, true);
  rpc.requests[1].resolve(list([session('replacement')], 0, 'server-b')); await flush();
  rpc.requests[0].resolve(list([session('stale')], 100));
  rpc.subscriptions[0].receive(event('closed', 101)); await flush();
  assert.equal(states.at(-1).index.serverEpoch, 'server-b');
  assert.deepEqual(states.at(-1).index.tabs.map(tab => tab.tabId), ['replacement']);
});

test('new-epoch events refresh the index, and failed pages retain profile and download data', async () => {
  const rpc = client(), states = [];
  const watcher = api.watchBrowser('thread', state => states.push(state), rpc); cleanup.push(watcher.dispose);
  rpc.requests[0].resolve(list()); await flush();
  rpc.subscriptions[0].receive(event('opened', 1, { serverEpoch: 'server-b' }));
  assert.equal(rpc.requests.length, 2);
  rpc.requests[1].resolve(list([], 0, 'server-b')); await flush();
  rpc.subscriptions[0].receive(event('failed', 2, { serverEpoch: 'server-b', url: 'https://example.test', title: 'Export', description: 'Download', download: { id: 'download', fileName: 'report.csv' } }));
  const tab = states.at(-1).index.tabs[0];
  assert.equal(tab.profileId, 'incognito'); assert.equal(tab.status, 'LoadFailed'); assert.equal(tab.download.fileName, 'report.csv');
});

test('denied reads remain errors rather than pretending the browser has no tabs; dispose ignores late data', async () => {
  const rpc = client(), states = [];
  const watcher = api.watchBrowser('thread', state => states.push(state), rpc);
  rpc.requests[0].reject(new Error('Missing preview:read')); await flush();
  assert.deepEqual(states.at(-1), { kind: 'error', message: 'Missing preview:read', index: null });
  watcher.dispose(); const count = states.length;
  rpc.subscriptions[0].receive(event('opened', 2)); rpc.reconnect();
  assert.equal(states.length, count); assert.equal(rpc.subscriptions.length, 1);
});

test('an epoch change racing an initial response triggers a fresh list before exposing tabs', async () => {
  const rpc = client(), states = [];
  const watcher = api.watchBrowser('thread', state => states.push(state), rpc); cleanup.push(watcher.dispose);
  rpc.subscriptions[0].receive(event('opened', 1, { serverEpoch: 'server-b' }));
  rpc.requests[0].resolve(list()); await flush();
  assert.equal(rpc.requests.length, 2); assert.equal(states.at(-1).kind, 'loading');
  rpc.requests[1].resolve(list([session('fresh')], 1, 'server-b')); await flush();
  assert.deepEqual(states.at(-1).index.tabs.map(tab => tab.tabId), ['fresh']);
});

test('a rejected event stream cannot be hidden by a successful list; Retry restores the subscription', async () => {
  const rpc = client(), states = [];
  const watcher = api.watchBrowser('thread', state => states.push(state), rpc); cleanup.push(watcher.dispose);
  rpc.subscriptions[0].completion.reject(new Error('Browser updates denied')); await flush();
  rpc.requests[0].resolve(list()); await flush();
  assert.equal(states.at(-1).kind, 'error'); assert.equal(states.at(-1).message, 'Browser updates denied');
  assert.equal(states.at(-1).index.tabs.length, 1);
  await watcher.refresh(); assert.equal(rpc.subscriptions.length, 2);
  rpc.requests[1].resolve(list()); await flush(); assert.equal(states.at(-1).kind, 'ready');
});

test('unknown/native runtimes remain unautomatable and scoped URLs preserve the environment', () => {
  assert.equal(api.parseBrowserIndex(list([session('native', { runtime: 'desktop' }), session('legacy', { runtime: undefined })])).tabs.filter(tab => tab.runtime === 'server').length, 0);
  assert.throws(() => api.parseBrowserIndex({ sessions: [], revision: null, serverEpoch: 'a' }));
  const url = new URL(api.browserStreamUrl('environment:other-machine:remote-thread', 'tab/with space', false));
  assert.equal(url.pathname, '/t3/environments/other-machine/api/preview-stream/ws');
  assert.equal(url.searchParams.get('threadId'), 'remote-thread'); assert.equal(url.searchParams.get('tabId'), 'tab/with space'); assert.equal(url.searchParams.get('interactive'), 'false');
});

const deviceState = () => ({ revision: 2, hostStatus: 'ready', hosts: [{ id: 'local', label: 'This machine', kind: 'local' }], simlockHosts: [{ id: 'cloud', label: 'Cloud device', kind: 'simlock' }], devices: [{ hostId: 'cloud', id: 'phone/a', name: 'Lab phone' }, { hostId: 'local', id: 'private', name: 'Other phone' }], sessions: [{ threadId: 'remote-thread', hostId: 'cloud', deviceId: 'phone/a', platform: 'android' }, { threadId: 'another-bot', hostId: 'local', deviceId: 'private', platform: 'ios' }] });
test('device subscription and MJPEG target use the conversation, host, and environment, with no device writes', () => {
  const rpc = client(), states = [];
  const dispose = api.watchDevices('environment:other-machine:remote-thread', value => states.push(value), rpc); cleanup.push(dispose);
  assert.deepEqual(rpc.subscriptions.map(sub => sub.tag), ['subscribeDeviceState']);
  rpc.subscriptions[0].receive(deviceState());
  const state = states.at(-1); assert.equal(state.sessions.length, 1); assert.deepEqual(state.devices.map(device => device.name), ['Lab phone']);
  const url = api.deviceFrameUrl('environment:other-machine:remote-thread', state.sessions[0], state);
  assert.equal(url, '/t3/environments/other-machine/api/device-hub/vendor/serve-sim/helper/phone%2Fa/stream.mjpeg?hostId=cloud');
  assert.throws(() => api.deviceFrameUrl('some-other-thread', state.sessions[0], state));
  assert.equal(rpc.requests.length, 0);
  rpc.reconnect(); assert.equal(rpc.subscriptions[0].cancelled, true);
});

test('overlay watching, profile-aware takeover, tab switch and return without help or devices never dispatch chat or settings', async () => {
  const rpc = client(), calls = [], originalCall = t3.call, originalStream = t3.stream;
  t3.call = async (tag, payload) => { calls.push({ tag, payload }); assert.equal(tag, 'preview.list'); return list([session(), session('second', { profileId: 'default' })]); };
  t3.stream = rpc.stream;
  const host = document.createElement('main'); document.body.append(host); const root = createRoot(host);
  cleanup.push(async () => { await settle(() => root.unmount()); t3.call = originalCall; t3.stream = originalStream; });
  const bot = { slug: 'lab', name: 'Lab Bot', shape: 'circle', color: 'blue', mainThreadId: 'thread' };
  useApp.setState({ bots: { lab: bot }, selected: 'lab', selectedThreadId: null, threads: {} });
  await settle(() => root.render(h(ComputerOverlay, { slug: 'lab' })));
  let socket = sockets.at(-1);
  assert.equal(new URL(socket.url).searchParams.get('interactive'), 'false'); assert.deepEqual(socket.messages, []);
  await settle(() => socket.receive({ type: 'control', controller: 'unclaimed', canOperate: false }));
  const button = text => [...host.querySelectorAll('button')].find(button => button.textContent === text);
  assert.equal(button('Take control').disabled, false); // Read-only viewer is not a token capability probe.
  await settle(() => button('Take control').click()); socket = sockets.at(-1);
  await settle(() => socket.receive({ type: 'control', controller: 'agent', canOperate: true }));
  assert.deepEqual(socket.messages, [{ type: 'takeControl' }]); assert.match(host.textContent, /Requesting control/);
  await settle(() => socket.receive({ type: 'control', controller: 'you', canOperate: true }));
  assert.match(host.textContent, /You're in control/); assert.match(host.textContent, /Default profile/);
  await settle(() => button("I'm done").click());
  assert.equal(socket.messages.at(-1).type, 'releaseControl'); assert.equal(socket.readyState, 3);
  assert.equal(new URL(sockets.at(-1).url).searchParams.get('interactive'), 'false');
  await settle(() => button('Take control').click()); socket = sockets.at(-1);
  await settle(() => socket.receive({ type: 'control', controller: 'you', canOperate: true }));
  await settle(() => { const select = host.querySelector('select'); select.value = 'tab'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(socket.messages.at(-1).type, 'releaseControl');
  assert.match(host.textContent, /Incognito/); assert.equal(new URL(sockets.at(-1).url).searchParams.get('interactive'), 'false');
  await settle(() => button('Take control').click()); socket = sockets.at(-1);
  await settle(() => socket.receive({ type: 'control', controller: 'you', canOperate: true }));
  await settle(() => rpc.subscriptions[0].receive(event('closed', 2)));
  assert.equal(socket.messages.at(-1).type, 'releaseControl');
  assert.equal(new URL(sockets.at(-1).url).searchParams.get('interactive'), 'false');
  await settle(() => rpc.subscriptions[0].receive(event('opened', 3)));
  assert.equal(new URL(sockets.at(-1).url).searchParams.get('interactive'), 'false');
  assert.equal(host.querySelector('[aria-label="Using the computer"]'), null);
  assert.doesNotMatch(host.textContent, /Teach a browser task|Devices/);
  assert.equal(button('Start recording'), undefined); assert.equal(button('Wake computer'), undefined);
  assert.deepEqual(calls.map(call => call.tag), ['preview.list']);
});

test('open and close target the requested thread and retain its explicit profile', async () => {
  const original = t3.call, calls = [];
  t3.call = async (tag, payload) => { calls.push({ tag, payload }); return tag === 'preview.open' ? session('opened') : undefined; };
  try {
    const opened = await api.openBrowser('thread', 'incognito');
    await api.closeBrowser('thread', opened.tabId);
    assert.deepEqual(calls, [
      { tag: 'preview.open', payload: { threadId: 'thread', runtime: 'server', reveal: false, profileId: 'incognito' } },
      { tag: 'preview.close', payload: { threadId: 'thread', tabId: 'opened' } },
    ]);
    t3.call = async () => session('wrong', { threadId: 'other' });
    await assert.rejects(api.openBrowser('thread'), /did not open a server browser/);
  } finally { t3.call = original; }
});
