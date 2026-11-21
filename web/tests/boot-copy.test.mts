import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { buildOnce, entryChunk } from './support.mts';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem() {} } as unknown as Storage;
globalThis.location = new URL('http://boot-copy.test/') as unknown as Location;
globalThis.window = { setInterval() {}, clearInterval() {}, addEventListener() {} } as unknown as typeof window;
globalThis.document = { addEventListener() {}, visibilityState: 'visible' } as unknown as Document;

const src = fileURLToPath(new URL('../src/', import.meta.url));
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', plugins: [{ name: 'boot-copy', resolveId: (id) => id.endsWith('virtual:boot-copy') ? '\0boot-copy' : undefined, load: (id) => id === '\0boot-copy' ? `export * from ${JSON.stringify(src + 'store.ts')}; export { t3 } from ${JSON.stringify(src + 'lib/t3.ts')}; export { api } from ${JSON.stringify(src + 'lib/api.ts')}; export * from ${JSON.stringify(src + 'lib/threadCache.ts')};` : undefined }], ssr: { noExternal: true }, build: { ssr: 'virtual:boot-copy', write: false } });
const entry = entryChunk(bundle);
const app = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
const { useApp, t3, api, boot, resetBootForTest, writeBoot, resetCacheForTest } = app;

let sessionCalls = 0;
let sessionAnswer: () => Promise<{ authenticated: boolean; passwordRequired?: boolean; accessLogin?: boolean }> = async () => ({ authenticated: true });
let liveSettings = { userName: 'From the gateway', timezone: 'UTC', autoReview: true, theme: 'dark', sections: [], rules: { alwaysAsk: [], allowWithoutAsking: [] } };
t3.onState = () => () => {};
t3.onReconnect = () => () => {};
t3.connect = () => {};
t3.stream = () => ({ cancel() {}, done: new Promise(() => {}), live: () => false });
t3.call = async () => ({ providers: [] });
api.session = () => { sessionCalls++; return sessionAnswer(); };
api.config = async () => ({ botsRoot: '/bots' });
api.settings = async () => liveSettings;
api.bots = async () => [bot];
api.botIdentities = async () => [];
const fetched: string[] = [];
globalThis.fetch = async (input: RequestInfo | URL) => { fetched.push(String(input)); return Response.json([]); };
after(() => { globalThis.fetch = fetch; });

const settle = () => new Promise((resolve) => setImmediate(resolve));
const copySettings = { userName: 'From the copy', timezone: 'UTC', autoReview: true, theme: 'dark', sections: [], rules: { alwaysAsk: [], allowWithoutAsking: [] } };
const bot = { slug: 'alpha', name: 'Alpha', label: 'Test Bot', primary: true, hidden: false, pinned: false, mainThreadId: 'thread-alpha', projectId: 'project-alpha', workspaceRoot: '/bots/alpha', createdAt: '2026-01-01T00:00:00Z' };
const keepCopy = () => writeBoot({ botsRoot: '/bots', executorUrl: null, settings: copySettings as never, bots: [bot], historical: [] });
const setOnline = (online: boolean) => Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: online });

test('with nothing kept, an unreachable gateway still says it could not load', async () => {
  setOnline(false);
  sessionAnswer = async () => { throw new TypeError('Failed to fetch'); };
  await boot();
  assert.equal(useApp.getState().auth, 'error', 'there is nothing to show, so the app says so');
  assert.equal(useApp.getState().offline, false);
});

test('a copy paints at once, and the gateway asked behind it goes live', async () => {
  sessionCalls = 0;
  resetCacheForTest();
  resetBootForTest();
  setOnline(true);
  sessionAnswer = async () => ({ authenticated: true });
  await keepCopy();
  const started = Date.now();
  await boot();
  assert.ok(Date.now() - started < 500, 'no launch waits for the network');
  assert.equal(useApp.getState().auth, 'ready');
  assert.equal(useApp.getState().settings?.userName, 'From the copy', 'the copy is what the first frame shows');
  assert.equal(useApp.getState().offline, false, 'a copy is not an offline claim while the browser has a network');
  await settle();
  await settle();
  assert.equal(sessionCalls, 1, 'the gateway is still asked, once');
  assert.equal(useApp.getState().settings?.userName, 'From the gateway', 'and its answer replaces the copy');
});

test('a gateway that never answers does not hold the screen, and does not claim offline', async () => {
  sessionCalls = 0;
  resetBootForTest();
  setOnline(true);
  sessionAnswer = () => new Promise<never>(() => {});
  await keepCopy();
  const started = Date.now();
  await boot();
  const waited = Date.now() - started;
  assert.ok(waited < 500, `opened after ${waited}ms, not after the fetch timeout`);
  assert.equal(useApp.getState().auth, 'ready');
  assert.equal(useApp.getState().offline, false, 'a slow gateway is not a dead one');
  assert.equal(useApp.getState().settings?.userName, 'From the copy');
});

test('with the network gone, the copy is all there is and the app says so', async () => {
  sessionCalls = 0;
  resetBootForTest();
  setOnline(false);
  sessionAnswer = async () => { throw new TypeError('Failed to fetch'); };
  await keepCopy();
  await boot();
  assert.equal(useApp.getState().offline, true, 'the browser already knew there is no network');
  assert.equal(useApp.getState().auth, 'ready');
});

test('a password that changed elsewhere wins over the copy', async () => {
  sessionCalls = 0;
  resetBootForTest();
  setOnline(true);
  // Answered a beat later, so the first frame is the copy and the answer is the change.
  sessionAnswer = () => new Promise((resolve) => setTimeout(() => resolve({ authenticated: false, passwordRequired: true, accessLogin: false }), 30));
  await keepCopy();
  await boot();
  assert.equal(useApp.getState().auth, 'ready', 'the copy paints first');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(useApp.getState().auth, 'password', 'and the gateway answer takes over');
  assert.equal(await app.readBoot(), null, 'whoever signs in next is not shown what the last session kept');
});

test('a warm launch still asks for the Vault and the machines it does not cache', async () => {
  resetBootForTest();
  sessionAnswer = async () => ({ authenticated: true });
  await keepCopy();
  fetched.length = 0;
  await boot();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(fetched.some((url) => url.includes('/api/vault')), 'the copy paints the first frame, but the Vault is still asked for');
  assert.ok(fetched.some((url) => url.includes('/api/machines')), 'and neither are the linked machines');
});

test('signing out refuses the saves that are still on their way', async () => {
  resetCacheForTest();
  const view = { v: 1, key: 'thread-signout', savedAt: Date.now(), thread: null, items: [{ id: 'm1', text: 'kept' }], runs: [], requests: [], subagents: [], historyCursor: null, hasMoreHistory: false };
  await app.writeView(view);
  assert.ok(await app.readView('thread-signout'), 'the transcript was kept');
  await app.forgetDeviceCopy();
  assert.equal(await app.readView('thread-signout'), null, 'signing out forgets it');
  // A debounced save or a pagehide flush lands after the erase; it must not bring the transcript back.
  await app.writeView(view);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await app.readView('thread-signout'), null, 'nothing on screen is saved after signing out');
});

test('a copy past its sign-in lifetime is never painted', async () => {
  resetCacheForTest();
  const old = { v: 1, key: 'thread-old', savedAt: Date.now() - 31 * 24 * 60 * 60 * 1000, thread: null, items: [{ id: 'm1', text: 'old' }], runs: [], requests: [], subagents: [], historyCursor: null, hasMoreHistory: false };
  await app.writeView(old);
  assert.equal(await app.readView('thread-old'), null);
});

test('a deleted conversation leaves no copy behind', async () => {
  resetCacheForTest();
  resetBootForTest();
  const view = { v: 1, key: 'thread-gone', savedAt: Date.now(), thread: null, items: [{ id: 'm1', text: 'kept' }], runs: [], requests: [], subagents: [], historyCursor: null, hasMoreHistory: false };
  await app.writeView(view);
  await app.writeView({ ...view, key: 'thread-stays' });
  app.forgetThreadCopy(['thread-gone']);
  await settle();
  assert.equal(await app.readView('thread-gone'), null);
  assert.ok(await app.readView('thread-stays'), 'only that conversation goes');
  // A save another tab queued before the deletion lands afterwards: it must not bring the transcript back.
  await app.writeView(view);
  assert.equal(await app.readView('thread-gone'), null, 'a deleted conversation stays deleted');
});

test('a conversation too big for its budget even after trimming is not kept', async () => {
  resetCacheForTest();
  const view = { v: 1, key: 'thread-huge', savedAt: Date.now(), thread: null, items: [{ id: 'm1', text: 'x'.repeat(3 * 1024 * 1024) }], runs: [], requests: [], subagents: [], historyCursor: null, hasMoreHistory: false };
  await app.writeView(view);
  assert.equal(await app.readView('thread-huge'), null);
});

test('a request card painted from the saved copy cannot be answered', async () => {
  useApp.setState({ threadData: { 'thread-saved': { items: {}, runs: {}, requests: {}, subagents: {}, loaded: true, stale: true } } });
  let dispatched = 0;
  const dispatch = t3.dispatch;
  t3.dispatch = async () => { dispatched++; };
  try {
    await assert.rejects(app.respondRequest('thread-saved', 'request-1', 'accept'), /saved copy/);
    await assert.rejects(app.answerQuestion('thread-saved', 'request-1', { layout: 'compact' }), /saved copy/);
    assert.equal(dispatched, 0, 'nothing reaches T3 from a copy');
  } finally { t3.dispatch = dispatch; }
});
