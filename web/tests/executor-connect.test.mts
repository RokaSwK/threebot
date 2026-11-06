import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { buildOnce, domWindow } from './support.mts';
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: 'https://bot.example/', width: 390, height: 844 }));
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.getComputedStyle = window.getComputedStyle.bind(window); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Layout stand-in: visible elements have one 32×32 box (happy-dom does no layout).
window.HTMLElement.prototype.getClientRects = function (this: HTMLElement) { return (this.hidden ? [] : [{ width: 32, height: 32 }]) as unknown as DOMRectList; };
const src = new URL('../src/', import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), 'bot-executor-ui-'));
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' }, ssr: { noExternal: true },
  plugins: [{ name: 'executor-ui-test', resolveId: (id) => id.endsWith('virtual:executor-ui') ? '\0executor-ui' : undefined,
    load: (id) => id === '\0executor-ui' ? `
      export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client';
      export { ConnectApps } from ${JSON.stringify(`${src}components/ConnectApps.tsx`)};
      export { SettingsDialog } from ${JSON.stringify(`${src}components/SettingsDialog.tsx`)};
      export { MessageContent } from ${JSON.stringify(`${src}components/Chat.tsx`)};
      export { Dialogs } from ${JSON.stringify(`${src}App.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};
      export { readNavigation } from ${JSON.stringify(`${src}lib/navigation.ts`)};
      export * from ${JSON.stringify(`${src}lib/executor.ts`)};` : undefined,
    transform: (code, id) => id === `${src}components/Chat.tsx` ? { code: `${code}\nexport { MessageContent };`, map: null } : id === `${src}App.tsx` ? { code: `${code}\nexport { Dialogs };`, map: null } : undefined }],
  build: { ssr: 'virtual:executor-ui', write: false, rollupOptions: { output: { entryFileNames: 'entry.mjs', chunkFileNames: '[name]-[hash].mjs' } } },
});
for (const output of bundle.output) { const file = join(directory, output.fileName); await mkdir(dirname(file), { recursive: true }); await writeFile(file, output.type === 'chunk' ? output.code : output.source); }
const { createElement: h, act, createRoot, ConnectApps, SettingsDialog, MessageContent, Dialogs, useApp, readNavigation, isExecutorUrl } = await import(pathToFileURL(join(directory, 'entry.mjs')).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(directory, { recursive: true }); });
let root, host, calls, popups, app, connection, handler, backCount;
const freshApp = () => ({ id: 'app_sample', slug: 'sample', name: 'Sample', status: 'needs-connection', requirements: [{ id: 'service', scope: 'user', name: 'Sample account', cardinality: 'many', accounts: [{ id: 'work', name: 'Work', linked: false, signIn: 'saved' }, { id: 'personal', name: 'Personal', linked: false, signIn: 'saved' }] }] });
const freshConnection = () => ({ id: 'con_sample', backend: 'cloud', appId: 'app_sample', requirement: 'service', scope: 'user', url: 'https://app.executor.sh/connect/con_sample', status: 'pending', expiresAt: '2026-10-30T15:00:00Z' });
const deferred = () => Promise.withResolvers();
const flush = () => new Promise((resolve) => setImmediate(resolve));
const render = async (element = h(ConnectApps, { onBack: () => backCount++ })) => act(async () => { root.render(element); await flush(); });
const labeled = (name) => document.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);
const button = (text, scope = document) => [...scope.querySelectorAll('button')].find((element) => element.textContent.trim() === text);
const click = async (element) => { assert.ok(element, 'control exists'); await act(async () => { element.click(); await flush(); }); };
const settle = async (fn) => act(async () => { fn(); await flush(); });
const body = (call) => JSON.parse(call.body);
const writes = () => calls.filter((call) => call.method === 'POST');
const waitCatalog = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
const setInput = async (element, value) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
});
const manage = () => click(labeled('Open Sample'));
async function start() { await manage(); await click(button('Connect new account')); }
function setConnected() { app = { ...app, status: 'connected', requirements: app.requirements.map((requirement) => ({ ...requirement, accounts: requirement.accounts.map((account) => ({ ...account, linked: account.id === 'work' })) })) }; }
beforeEach(() => {
  calls = []; popups = []; backCount = 0; app = freshApp(); connection = freshConnection();
  handler = async (url, init) => {
    if (url === '/api/executor') return Response.json({ configured: true, hasToken: true, backend: 'cloud', backupAvailable: true, connections: [app] });
    if (url.startsWith('/api/executor/catalog?')) return Response.json({ entries: [{ id: 'entry_sample', name: 'Sample catalog', description: 'A generic app', icon: null, auth: ['oauth'] }] });
    if (url === '/api/executor/install' || url === '/api/executor/apps/app_sample') return Response.json({ app });
    if (url === '/api/executor/apps/app_sample/connections' || url === '/api/executor/connections/con_sample?backend=cloud') return Response.json(connection);
    if (url === '/api/executor/resolve-link') return Response.json({ kind: 'connection', connection });
    throw new Error(`Unexpected request ${url}`);
  };
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, ...init }); return handler(url, init); };
  window.open = (url, target, features) => { const popup = { location: { href: url }, opener: {}, closed: false, close() { this.closed = true; }, focus() {} }; popups.push({ popup, url, target, features }); return popup as unknown as ReturnType<typeof window.open>; };
  useApp.setState({ bots: {}, historicalBots: {}, threads: {}, executorUrl: 'https://app.executor.sh', dialog: null, settingsPane: 'overview', settings: { userName: 'Person', theme: 'light', accent: 'bot', timezone: '', autoReview: true, rules: { alwaysAsk: [], allowWithoutAsking: [] }, sections: [] }, providers: [], toast: null });
  host = document.createElement('main'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });

for (const failure of ['list', 'account']) test(`catalog retry refreshes ${failure} connection failures and restores the authoritative count`, async () => {
  let failing = true;
  const original = handler;
  handler = (url, init) => {
    if (url === '/api/executor' && failing) return Response.json({ configured: true, hasToken: true, backend: 'cloud', backupAvailable: true,
      connections: failure === 'list' ? [] : [{ ...app, status: 'unknown', requirements: [], error: 'Account check failed' }],
      ...(failure === 'list' ? { error: 'Connection list failed' } : {}) });
    if (url.startsWith('/api/executor/catalog?') && failing) return Response.json({}, { status: 503 });
    return original(url, init);
  };
  await render(); await waitCatalog();
  assert.ok(button('Retry search'));
  failing = false; setConnected();
  await click(button('Retry search')); await waitCatalog();
  assert.equal(document.querySelector('.connected-count').textContent, '1 connected');
  assert.doesNotMatch(document.body.textContent, /Some connection details couldn't be checked|Couldn't search apps/);
  assert.ok(labeled('Open Sample catalog'));
  assert.equal(calls.filter(call => call.url === '/api/executor').length, 2);
  assert.equal(writes().length, 0);
});

test('incomplete connection data never reports a zero count and can retry without a catalog failure', async () => {
  let failing = true;
  const original = handler;
  handler = (url, init) => url === '/api/executor' && failing
    ? Response.json({ configured: true, hasToken: true, backend: 'cloud', connections: [{ ...app, status: 'unknown', requirements: [], error: 'Account check failed' }] })
    : original(url, init);
  await render();
  assert.equal(document.querySelector('.connected-count').textContent, 'Status unavailable');
  assert.match(document.body.textContent, /Some connection details couldn't be checked/);
  failing = false; setConnected();
  await click(button('Retry'));
  assert.equal(document.querySelector('.connected-count').textContent, '1 connected');
  assert.doesNotMatch(document.body.textContent, /Some connection details couldn't be checked/);
});

test('catalog recovery alone cannot clear a connection warning or invent a count', async () => {
  let catalogFails = true;
  const original = handler;
  handler = (url, init) => {
    if (url === '/api/executor') return Response.json({ configured: true, hasToken: true, backend: 'cloud', connections: [], error: 'Connection list failed' });
    if (url.startsWith('/api/executor/catalog?') && catalogFails) return Response.json({}, { status: 503 });
    return original(url, init);
  };
  await render(); await waitCatalog(); catalogFails = false;
  await click(button('Retry search')); await waitCatalog();
  assert.ok(labeled('Open Sample catalog'));
  assert.doesNotMatch(document.body.textContent, /Couldn't search apps/);
  assert.match(document.body.textContent, /Some connection details couldn't be checked/);
  assert.equal(document.querySelector('.connected-count').textContent, 'Status unavailable');
  assert.ok(button('Retry'));
  assert.equal(writes().length, 0);
});

test('pending and failed catalog requests do not report zero search results', async () => {
  const pending = deferred(), original = handler;
  handler = (url, init) => url.startsWith('/api/executor/catalog?') ? pending.promise : original(url, init);
  await render(); await setInput(labeled('Search apps'), 'sample');
  assert.doesNotMatch(document.querySelector('.apps-section-title').textContent, /0 apps/);
  await settle(() => pending.resolve(Response.json({}, { status: 503 })));
  assert.doesNotMatch(document.querySelector('.apps-section-title').textContent, /0 apps/);
  handler = original; await click(button('Retry search')); await waitCatalog();
  assert.match(document.querySelector('.apps-section-title').textContent, /1 apps/);
});

test('pending and failed refreshes do not present the previous connected count as current', async () => {
  setConnected(); await render();
  assert.equal(document.querySelector('.connected-count').textContent, '1 connected');
  const pending = deferred(), original = handler;
  handler = (url, init) => url === '/api/executor' ? pending.promise : original(url, init);
  await settle(() => window.dispatchEvent(new window.Event('focus')));
  assert.doesNotMatch(document.querySelector('.connected-count').textContent, /\d+ connected/);
  await settle(() => pending.resolve(Response.json({}, { status: 503 })));
  assert.equal(document.querySelector('.connected-count').textContent, 'Status unavailable');
  assert.match(document.querySelector('[role=alert]').textContent, /Couldn't load apps/);
  handler = original; app = freshApp();
  await click(button('Retry'));
  assert.equal(document.querySelector('.connected-count').textContent, '0 connected');
  assert.equal(document.querySelector('[role=alert]'), null);
});

test('installed app is not connected; Manage and Back stay inside this dialog', async () => {
  await render(); assert.match(document.body.textContent, /Needs sign-in/); assert.doesNotMatch(document.body.textContent, /Connected/);
  await manage(); assert.match(document.body.textContent, /Sample account/); assert.match(document.body.textContent, /Linked for you/);
  assert.equal(document.querySelectorAll('[role=dialog]').length, 1); assert.equal(popups.length, 0);
  assert.deepEqual(calls.filter((call) => call.url.includes('/apps/')).map((call) => call.url), ['/api/executor/apps/app_sample']);
  await click(labeled('Back')); assert.ok(labeled('Open Sample')); assert.equal(backCount, 0);
  await click(labeled('Back')); assert.equal(backCount, 1);
});

test('install dispatches once and opens account management without a dashboard popup', async () => {
  const pending = deferred(), original = handler; handler = (url, init) => url === '/api/executor/install' ? pending.promise : original(url, init);
  await render(); await waitCatalog(); const add = labeled('Connect Sample catalog'); await act(async () => { add.click(); add.click(); });
  assert.deepEqual(writes().map(body), [{ entry: 'entry_sample', name: 'Sample catalog' }]); assert.equal(popups.length, 0); assert.equal(add.disabled, true);
  await settle(() => pending.resolve(Response.json({ app }))); assert.match(document.body.textContent, /Sample account/); assert.equal(document.querySelectorAll('[role=dialog]').length, 1); assert.equal(popups.length, 0);
});

test('catalog browsing reaches the last app and filters real categories and descriptions without another download', async () => {
  const entries = Array.from({ length: 65 }, (_, index) => ({ id: `entry_${index + 1}`, name: `App ${String(index + 1).padStart(2, '0')}`, description: index === 64 ? 'Persistent browser sessions' : 'Generic provider', category: index === 64 ? 'developer tools' : 'email', icon: null, auth: ['apiKey', 'oauth'], authLabels: ['API key', ''] }));
  const original = handler;
  handler = (url, init) => url.startsWith('/api/executor/catalog?') ? Response.json({ entries }) : original(url, init);
  await render(); await waitCatalog();
  await click(button('Browse appsView all'));
  assert.equal(document.querySelectorAll('button[aria-label^="Connect App"]').length, 30);
  assert.equal(labeled('Connect App 65'), null);
  assert.match(document.body.textContent, /65 apps/);
  await click(button('Load more apps')); await click(button('Load more apps'));
  assert.ok(labeled('Connect App 65')); assert.equal(button('Load more apps'), undefined);
  await click(button('Developer Tools'));
  assert.equal(document.querySelectorAll('button[aria-label^="Connect App"]').length, 1);
  assert.ok(labeled('Connect App 65')); await click(labeled('Open App 65')); assert.match(document.body.textContent, /Persistent browser sessions/); assert.equal(writes().length, 0); await click(labeled('Back'));
  await setInput(labeled('Search apps'), 'browser sessions');
  assert.ok(labeled('Connect App 65'));
  await setInput(labeled('Search apps'), 'no matching provider');
  assert.match(document.body.textContent, /No results match/);
  await click(button('All')); await setInput(labeled('Search apps'), ''); await click(button('Browse appsView all'));
  await setInput(labeled('Search apps'), '');
  assert.equal(document.querySelectorAll('button[aria-label^="Connect App"]').length, 30);
  assert.equal(calls.filter((call) => call.url.startsWith('/api/executor/catalog?')).length, 1);
  assert.equal(writes().length, 0);
});

test('single-account radio selection publishes only confirmed links', async () => {
  app.requirements[0].cardinality = 'one'; app.requirements[0].accounts[0].linked = true;
  const pending = deferred(), original = handler; handler = (url, init) => url.endsWith('/accounts') ? pending.promise : original(url, init);
  await render(); await manage(); const radios = [...document.querySelectorAll<HTMLInputElement>('input[type=radio]')]; await click(radios[1]);
  assert.deepEqual(body(writes()[0]), { requirement: 'service', scope: 'user', account: 'personal', linked: true }); assert.deepEqual(radios.map((radio) => radio.checked), [true, false]);
  app.requirements[0].accounts[0].linked = false; app.requirements[0].accounts[1].linked = true; app.status = 'connected';
  await settle(() => pending.resolve(Response.json({ app }))); assert.deepEqual([...document.querySelectorAll<HTMLInputElement>('input[type=radio]')].map((radio) => radio.checked), [false, true]); assert.match(document.body.textContent, /PersonalConnected/);
});

test('failed many-account change retains selection and allows explicit retry', async () => {
  let fails = true; const original = handler;
  handler = (url, init) => { if (!url.endsWith('/accounts')) return original(url, init); if (fails) return Response.json({ error: 'private transport credential detail' }, { status: 503 }); app.requirements[0].accounts[0].linked = true; app.status = 'connected'; return Response.json({ app }); };
  await render(); await manage(); await click(document.querySelector<HTMLInputElement>('input[type=checkbox]'));
  assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]').checked, false); assert.match(document.querySelector('[role=alert]').textContent, /Couldn't complete/); assert.doesNotMatch(document.body.innerHTML, /private transport|credential detail/);
  fails = false; await click(document.querySelector<HTMLInputElement>('input[type=checkbox]')); assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]').checked, true);
  assert.deepEqual(writes().map(body), [{ requirement: 'service', scope: 'user', account: 'work', linked: true }, { requirement: 'service', scope: 'user', account: 'work', linked: true }]);
});

test('shared-account unlink sends app scope and a refusal cannot change the link', async () => {
  app.requirements[0].scope = 'app'; app.requirements[0].accounts[0].linked = true; const original = handler;
  handler = (url, init) => url.endsWith('/accounts') ? Response.json({ error: 'private denial' }, { status: 403 }) : original(url, init);
  await render(); await manage(); assert.match(document.body.textContent, /Linked for everyone/); await click(document.querySelector<HTMLInputElement>('input[type=checkbox]'));
  assert.deepEqual(body(writes()[0]), { requirement: 'service', scope: 'app', account: 'work', linked: false }); assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]').checked, true); assert.match(document.querySelector('[role=alert]').textContent, /don't have permission/);
});

test('new account opens only the direct sign-in URL; closing its popup is not success', async () => {
  await render(); await start(); assert.deepEqual(body(writes()[0]), { requirement: 'service', scope: 'user' });
  assert.equal(popups.length, 1); assert.equal(popups[0].popup.location.href, 'https://app.executor.sh/connect/con_sample'); assert.equal(popups[0].popup.opener, null);
  popups[0].popup.close(); await settle(() => {}); assert.match(document.body.textContent, /Finish connecting your account/); assert.doesNotMatch(document.body.textContent, /Account connected/); assert.equal(calls.filter((call) => call.url.includes('/connections/con_')).length, 0);
  await click(button('Continue sign-in')); assert.equal(popups[1].url, 'https://app.executor.sh/connect/con_sample'); assert.equal(popups[1].features, 'noopener,noreferrer');
});

test('return refresh confirms a saved linked account before reporting connection success', async () => {
  await render(); await start(); connection.status = 'completed'; await settle(() => window.dispatchEvent(new window.Event('focus')));
  assert.match(document.body.textContent, /Checking the account link/); assert.doesNotMatch(document.body.textContent, /Account connected/);
  setConnected(); await click(button('Check again')); assert.match(document.body.textContent, /Account connected/); assert.equal(writes().length, 1);
  assert.ok(calls.some((call) => call.url === '/api/executor/connections/con_sample?backend=cloud'));
  await click(button('Manage accounts')); assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]').checked, true);
});
for (const terminal of ['expired', 'cancelled']) test(`${terminal} starts fresh only on explicit action`, async () => {
  await render(); await start(); connection.status = terminal; await click(button('Check again')); assert.match(document.body.textContent, new RegExp(terminal)); assert.equal(writes().length, 1);
  connection = { ...freshConnection(), id: 'con_new' }; await click(button('Start again')); assert.equal(writes().length, 2); assert.match(document.body.textContent, /Finish connecting your account/);
});

test('Reconnect targets the existing account and duplicate connect clicks dispatch once', async () => {
  app.requirements[0].accounts[0].linked = true; app.requirements[0].accounts[0].signIn = 'reconnect'; const pending = deferred(), original = handler;
  handler = (url, init) => url.endsWith('/connections') ? pending.promise : original(url, init);
  await render(); await manage(); const reconnect = button('Reconnect'); await act(async () => { reconnect.click(); reconnect.click(); });
  assert.deepEqual(writes().map(body), [{ requirement: 'service', scope: 'user', account: 'work' }]); assert.equal(popups.length, 1);
  await settle(() => pending.resolve(Response.json(connection))); assert.match(document.body.textContent, /Finish connecting/);
});

test('duplicate status checks are suppressed until the current check finishes', async () => {
  await render(); await start(); const pending = deferred(), original = handler; handler = (url, init) => url.includes('/connections/con_') ? pending.promise : original(url, init);
  const check = button('Check again'); await act(async () => { check.click(); check.click(); window.dispatchEvent(new window.Event('focus')); }); assert.equal(calls.filter((call) => call.url.includes('/connections/con_')).length, 1);
  await settle(() => pending.resolve(Response.json(connection))); assert.match(document.body.textContent, /Finish connecting/);
});

test('inline cards match the exact active origin and open an app dialog', async () => {
  await render(h(MessageContent, { text: '[Connect Sample](https://app.executor.sh/connect/con_sample)' })); await click(labeled('Sample: Sign-in pending'));
  assert.deepEqual(useApp.getState().dialog, { kind: 'connect-apps', url: 'https://app.executor.sh/connect/con_sample' }); assert.equal(popups.length, 0);
  await settle(() => useApp.setState({ dialog: null })); await render(h(MessageContent, { text: '[Other](https://app.executor.sh.evil.example/connect/con_sample)' }));
  assert.equal(document.querySelector('a').href, 'https://app.executor.sh.evil.example/connect/con_sample'); assert.equal(document.querySelector('button'), null); assert.equal(useApp.getState().dialog, null);
  for (const url of ['https://user:pass@app.executor.sh/connect/con_x', 'https://app.executor.sh:444/connect/con_x', 'http://app.executor.sh/connect/con_x', 'not a URL']) assert.equal(isExecutorUrl(url, 'https://app.executor.sh'), false);
});

test('inline connection card confirms the saved link after management closes and remounts', async () => {
  const card = () => h(MessageContent, { text: '[Connect Sample](https://app.executor.sh/connect/con_sample)' });
  await render(card()); await click(labeled('Sample: Sign-in pending'));
  connection.status = 'completed'; setConnected();
  await settle(() => useApp.setState({ dialog: null }));
  assert.ok(labeled('Sample: Account connected')); assert.equal(button('SampleAccount connectedManage').textContent.trim(), 'SampleAccount connectedManage');
  await act(async () => { root.unmount(); }); root = createRoot(host); await render(card());
  assert.ok(labeled('Sample: Account connected')); assert.equal(popups.length, 0);
  assert.ok(calls.filter((call) => call.url === '/api/executor/apps/app_sample').length >= 3);
});

test('completed sign-in stays unconfirmed until a linked saved account appears on return', async () => {
  connection.status = 'completed';
  await render(h(MessageContent, { text: '[Connect Sample](https://app.executor.sh/connect/con_sample)' }));
  assert.ok(labeled('Sample: Check the account link')); assert.doesNotMatch(document.body.textContent, /Account connected/);
  setConnected(); app.requirements[0].accounts[0].signIn = 'reconnect';
  await settle(() => window.dispatchEvent(new window.Event('focus')));
  assert.ok(labeled('Sample: Check the account link')); assert.doesNotMatch(document.body.textContent, /Account connected/);
  app.requirements[0].accounts[0].signIn = 'saved';
  await settle(() => window.dispatchEvent(new window.Event('focus')));
  assert.ok(labeled('Sample: Account connected'));
  assert.ok(calls.every((call) => !call.url.endsWith('/connections') && !call.url.endsWith('/accounts')));
});

test('a stale inline connection response cannot overwrite the current URL', async () => {
  const pending = deferred(), original = handler, old = { ...connection, status: 'completed' };
  handler = (url, init) => url === '/api/executor/resolve-link'
    ? body(init).url.endsWith('con_sample') ? pending.promise : Response.json({ kind: 'connection', connection: { ...connection, id: 'con_new', status: 'expired' } })
    : original(url, init);
  await render(h(MessageContent, { text: '[Connect Sample](https://app.executor.sh/connect/con_sample)' }));
  await render(h(MessageContent, { text: '[Connect Sample](https://app.executor.sh/connect/con_new)' }));
  assert.ok(labeled('Sample: Sign-in expired'));
  setConnected(); await settle(() => pending.resolve(Response.json({ kind: 'connection', connection: old })));
  assert.ok(labeled('Sample: Sign-in expired')); assert.doesNotMatch(document.body.textContent, /Account connected/);
  assert.equal(calls.find((call) => call.url === '/api/executor/resolve-link').signal.aborted, true);
});

test('inline app card refreshes its confirmed account state after management closes', async () => {
  const original = handler; handler = (url, init) => url === '/api/executor/resolve-link' ? Response.json({ kind: 'app', app }) : original(url, init);
  await render(h(MessageContent, { text: '[Connect Sample](https://app.executor.sh/org/roka/apps/app_sample)' }));
  await click(labeled('Sample: Sign in to connect it')); setConnected();
  await settle(() => useApp.setState({ dialog: null }));
  assert.ok(labeled('Sample: Account connected')); assert.equal(popups.length, 0);
});

test('unknown requirements do not claim an app requires no account', async () => {
  app = { ...app, status: 'unknown', requirements: [], error: 'Account details unavailable' };
  await render(); await manage();
  assert.match(document.body.textContent, /Status unavailable/); assert.match(document.body.textContent, /Some account details couldn't be checked/);
  assert.doesNotMatch(document.body.textContent, /doesn't require an account/);
});

test('confirmed ready apps with no requirements explain that no account is required', async () => {
  app = { ...app, status: 'ready', requirements: [] };
  await render(); await manage();
  assert.match(document.body.textContent, /This app doesn't require an account/); assert.doesNotMatch(document.body.textContent, /Status unavailable/);
});

test('inline object dialog resolves an existing request and survives browser history parsing', async () => {
  useApp.setState({ dialog: { kind: 'connect-apps', url: 'https://app.executor.sh/connect/con_sample' } }); await render(h(Dialogs)); await settle(() => {});
  assert.match(document.body.textContent, /Finish connecting your account/); assert.ok(button('Continue sign-in')); assert.equal(popups.length, 0);
  assert.deepEqual(writes().map((call) => ({ url: call.url, body: body(call) })), [{ url: '/api/executor/resolve-link', body: { url: 'https://app.executor.sh/connect/con_sample' } }]);
  const route = { view: 'overlay', slug: null, threadId: null, details: false, dialog: { kind: 'connect-apps', url: 'https://app.executor.sh/connect/con_sample' } }; assert.deepEqual(readNavigation(route), route); assert.equal(readNavigation({ ...route, dialog: { kind: 'connect-apps', url: 42 } }), null);
});

test('nested Settings Back goes through app detail and restores settings overview', async () => {
  await render(h(SettingsDialog)); await click(button('Connect appsSearch plugins')); await manage(); let dialogs = [...document.querySelectorAll('[role=dialog]')]; assert.equal(dialogs.length, 2);
  await click(dialogs.at(-1).querySelector('[aria-label=Back]')); assert.ok(labeled('Open Sample')); dialogs = [...document.querySelectorAll('[role=dialog]')]; await click(dialogs.at(-1).querySelector('[aria-label=Back]'));
  assert.equal(document.querySelectorAll('[role=dialog]').length, 1); assert.equal(useApp.getState().settingsPane, 'overview'); assert.ok([...document.querySelectorAll('button')].some((button) => button.textContent.startsWith('Appearance')));
});

test('late app read cannot replace another app after Back', async () => {
  const second = { ...freshApp(), id: 'app_second', name: 'Second', slug: 'second' }, pending = deferred(), original = handler;
  handler = (url, init) => url === '/api/executor' ? Response.json({ configured: true, hasToken: true, backend: 'cloud', backupAvailable: true, connections: [app, second] }) : url === '/api/executor/apps/app_sample' ? pending.promise : url === '/api/executor/apps/app_second' ? Response.json({ app: second }) : original(url, init);
  await render(); await manage(); await click(labeled('Back')); await click(labeled('Open Second')); await settle(() => pending.resolve(Response.json({ app })));
  assert.equal(document.querySelector('.bot-modal-header').textContent, 'Second'); assert.equal(labeled('Open Sample'), null);
});

test('leaving a pending connection discards its response and closes its blank popup', async () => {
  const pending = deferred(), original = handler; handler = (url, init) => url.endsWith('/connections') ? pending.promise : original(url, init);
  await render(); await manage(); await click(button('Connect new account')); await click(labeled('Back')); await settle(() => pending.resolve(Response.json(connection)));
  assert.ok(labeled('Open Sample')); assert.equal(popups[0].popup.closed, true); assert.equal(popups[0].popup.location.href, 'about:blank');
});

test('connection failure closes blank popup and renders no private upstream detail', async () => {
  const original = handler; handler = (url, init) => url.endsWith('/connections') ? Response.json({ error: 'private secret=never-render' }, { status: 401 }) : original(url, init);
  await render(); await manage(); await click(button('Connect new account')); assert.match(document.querySelector('[role=alert]').textContent, /Sign in to the app again/); assert.doesNotMatch(document.body.innerHTML, /never-render|secret=/); assert.equal(popups[0].popup.closed, true);
});

test('a response from another backend cannot complete the tracked connection', async () => {
  await render(); await start(); connection = { ...connection, backend: 'self-hosted', status: 'completed' }; setConnected();
  await click(button('Check again'));
  assert.match(document.querySelector('[role=alert]').textContent, /invalid response/); assert.match(document.body.textContent, /Finish connecting your account/); assert.doesNotMatch(document.body.textContent, /Account connected/);
});

test('a late initial status cannot replace newer resolved app account state', async () => {
  const pending = deferred(), old = structuredClone(app), original = handler; setConnected();
  handler = (url, init) => url === '/api/executor' ? pending.promise : url === '/api/executor/resolve-link' ? Response.json({ kind: 'app', app }) : original(url, init);
  await render(h(ConnectApps, { initialUrl: 'https://app.executor.sh/org/roka/apps/app_sample' }));
  await settle(() => pending.resolve(Response.json({ configured: true, hasToken: true, backend: 'cloud', backupAvailable: true, connections: [old] })));
  assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]').checked, true); await click(labeled('Back'));
  assert.match(document.body.textContent, /Connected/); assert.doesNotMatch(document.body.textContent, /Needs sign-in/);
});

test('blocked popup leaves an explicit direct Continue action', async () => {
  window.open = () => null;
  await render(); await start(); assert.ok(button('Continue sign-in')); assert.match(document.body.textContent, /Finish connecting your account/); assert.equal(writes().length, 1);
});

test('returning to account management refreshes externally changed links', async () => {
  await render(); await manage(); assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]').checked, false);
  setConnected(); await settle(() => window.dispatchEvent(new window.Event('focus')));
  assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]').checked, true); assert.match(document.body.textContent, /Connected/); assert.equal(writes().length, 0);
});

test('account settings and unrelated Executor pages remain ordinary links', async () => {
  for (const path of ['/account/tokens', '/account/settings', '/docs']) assert.equal(isExecutorUrl(`https://app.executor.sh${path}`, 'https://app.executor.sh'), false);
  for (const path of ['/', '/org/roka/apps', '/org/roka/apps/app_sample', '/org/roka/connections/con_sample', '/connect/con_sample']) assert.equal(isExecutorUrl(`https://app.executor.sh${path}`, 'https://app.executor.sh'), true);
  await render(h(MessageContent, { text: '[Tokens](https://app.executor.sh/account/tokens)' }));
  assert.equal(document.querySelector('a').href, 'https://app.executor.sh/account/tokens'); assert.equal(document.querySelector('button'), null);
});

test('shelf Back and app-detail Back retain their separate catalog positions without installing', async () => {
  await render(); await waitCatalog();
  document.querySelector('.apps-catalog').scrollTop = 310;
  await click(button('Browse appsView all'));
  assert.equal(document.querySelector('.apps-catalog').scrollTop, 0);
  document.querySelector('.apps-catalog').scrollTop = 125;
  await click(labeled('Open Sample catalog')); assert.equal(writes().length, 0);
  await click(labeled('Back'));
  assert.equal(document.querySelector('.apps-catalog').scrollTop, 125);
  assert.match(document.body.textContent, /All apps/);
  await click(labeled('Back'));
  assert.equal(document.querySelector('.apps-catalog').scrollTop, 310);
  assert.ok(button('Browse appsView all')); assert.equal(backCount, 0);
});

test('inline card shows the app logo, falls back through its site icon to the plug, and badges a confirmed account', async () => {
  const card = () => h(MessageContent, { text: '[Connect Sample](https://app.executor.sh/connect/con_sample)' });
  const logo = () => document.querySelector('button[aria-label^="Sample:"] img');
  const fail = async () => act(async () => { logo().dispatchEvent(new window.Event('error')); await flush(); });
  app = { ...app, icon: 'data:image/svg+xml;base64,PHN2Zy8+', domain: 'sample.example' };
  await render(card());
  assert.ok(labeled('Sample: Sign-in pending'));
  assert.equal(logo().getAttribute('src'), 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(document.querySelector('button[aria-label^="Sample:"] .lucide-plug'), null);
  assert.equal(document.querySelector('button[aria-label^="Sample:"] .lucide-check'), null);
  await fail();
  assert.equal(logo().getAttribute('src'), '/api/site-icon?domain=sample.example');
  await fail();
  assert.equal(logo(), null);
  assert.ok(document.querySelector('button[aria-label^="Sample:"] .lucide-plug'));
  connection.status = 'completed'; setConnected(); app = { ...app, domain: 'sample.example' }; delete app.icon;
  await act(async () => { root.unmount(); }); root = createRoot(host); await render(card());
  assert.ok(labeled('Sample: Account connected'));
  assert.equal(logo().getAttribute('src'), '/api/site-icon?domain=sample.example');
  assert.ok(document.querySelector('button[aria-label^="Sample:"] .lucide-check'), 'confirmed state is a badge beside the logo');
});
