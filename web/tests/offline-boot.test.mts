import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { buildOnce, entryChunk } from './support.mts';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem() {} } as unknown as Storage;
globalThis.location = new URL('http://offline-boot.test/') as unknown as Location;
const listeners = new Map<string, (event: unknown) => void>();
globalThis.window = { setInterval() {}, clearInterval() {}, clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), addEventListener: (type: string, fn: (event: unknown) => void) => { listeners.set(type, fn); } } as unknown as typeof window;
globalThis.document = { addEventListener() {}, visibilityState: 'visible' } as unknown as Document;

const src = fileURLToPath(new URL('../src/', import.meta.url));
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', plugins: [{ name: 'offline-boot', resolveId: (id) => id.endsWith('virtual:offline-boot') ? '\0offline-boot' : undefined, load: (id) => id === '\0offline-boot' ? `export * from ${JSON.stringify(src + 'store.ts')}; export { t3 } from ${JSON.stringify(src + 'lib/t3.ts')}; export { api } from ${JSON.stringify(src + 'lib/api.ts')}; export * from ${JSON.stringify(src + 'lib/threadCache.ts')};` : undefined }], ssr: { noExternal: true }, build: { ssr: 'virtual:offline-boot', write: false } });
const entry = entryChunk(bundle);
const app = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
const { useApp, t3, api, boot, watchThread, writeBoot, writeView } = app;

const streams = new Map();
let stateListener: (state: string) => void = () => {};
t3.onState = (fn) => { stateListener = fn; return () => {}; };
t3.onReconnect = () => () => {};
t3.connect = () => {};
t3.stream = (tag, payload, receive) => { streams.set(tag, receive); return { cancel() {}, done: new Promise(() => {}), live: () => false }; };
t3.call = async () => ({ providers: [] });
// A device with no route to the gateway: the fetch itself fails, which is not the same as a refused sign-in.
api.session = async () => { throw new TypeError('Failed to fetch'); };
api.config = async () => { throw new TypeError('Failed to fetch'); };
api.settings = async () => { throw new TypeError('Failed to fetch'); };
api.bots = async () => { throw new TypeError('Failed to fetch'); };
api.botIdentities = async () => { throw new TypeError('Failed to fetch'); };
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
after(() => { t3.stream = () => ({ cancel() {}, done: new Promise(() => {}), live: () => false }); });

const settle = () => new Promise((resolve) => setImmediate(resolve));
const bot = { slug: 'alpha', name: 'Alpha', label: 'Test Bot', primary: true, hidden: false, pinned: false, mainThreadId: 'thread-alpha', projectId: 'project-alpha', workspaceRoot: '/bots/alpha', createdAt: '2026-01-01T00:00:00Z' };
const settings = { userName: 'Cristian', timezone: 'UTC', autoReview: true, theme: 'dark', sections: [], rules: { alwaysAsk: [], allowWithoutAsking: [] } };
const thread = { id: 'thread-alpha', title: 'Alpha', status: 'completed', lineage: { parentThreadId: null, rootThreadId: 'thread-alpha' }, updatedAt: '2026-01-01T00:00:00Z' };
const item = { id: 'm1', threadId: 'thread-alpha', type: 'assistant_message', status: 'completed', text: 'from before the flight', updatedAt: '2026-01-01T00:00:00Z' };

test('a device that never opened before still says it could not load', async () => {
  await boot();
  assert.equal(useApp.getState().auth, 'error');
  assert.equal(useApp.getState().offline, false, 'nothing was kept, so nothing is being shown');
});

test('with a copy on the device, an unreachable gateway opens the app instead of an error', async () => {
  await writeBoot({ botsRoot: '/bots', executorUrl: null, settings, bots: [bot], historical: [] });
  await writeView({ v: 1, key: 'thread-alpha', savedAt: Date.now(), thread, items: [item], runs: [], requests: [], subagents: [], historyCursor: null, hasMoreHistory: false });
  await boot();
  assert.equal(useApp.getState().auth, 'ready', 'the app opens at once from its copy');
  await settle();
  const state = useApp.getState();
  assert.equal(state.offline, true, 'and the check that could not reach the gateway says it is not live');
  assert.equal(state.botsRoot, '/bots');
  assert.equal(state.settings?.userName, 'Cristian');
  assert.equal(state.bots.alpha?.mainThreadId, 'thread-alpha');
  watchThread('thread-alpha');
  await settle();
  await settle();
  const data = useApp.getState().threadData['thread-alpha'];
  assert.equal(data?.stale, true);
  assert.equal(data?.items.m1?.text, 'from before the flight', 'the Bot shows its last copy, not a spinner');
  // The gateway comes back: the socket opening is what ends "offline", not a timer.
  stateListener('open');
  assert.equal(useApp.getState().offline, false);
  assert.equal(useApp.getState().threadData['thread-alpha']?.stale, true, 'the rows stay stale until a snapshot says otherwise');
});

test('a socket that stayed open does not leave the app offline when the radio returns', () => {
  // The browser fired "offline" (a captive portal, a network switch) but the socket never closed:
  // no "open" event will come, so the "online" event has to clear the claim itself.
  useApp.setState({ offline: true, connection: 'open' });
  listeners.get('online')?.(new Event('online'));
  assert.equal(useApp.getState().offline, false);
});
