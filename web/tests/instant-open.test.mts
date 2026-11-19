import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { buildOnce, entryChunk } from './support.mts';
import { fileURLToPath } from 'node:url';

// Node has no IndexedDB, which is exactly the case the cache has to survive: it falls back to memory.
globalThis.localStorage = { getItem: () => null, setItem() {} } as unknown as Storage;
globalThis.location = new URL('http://instant-open.test') as unknown as Location;
globalThis.window = { setInterval() {}, clearInterval() {}, addEventListener() {} } as unknown as typeof window;
globalThis.document = { addEventListener() {}, visibilityState: 'visible' } as unknown as Document;

const src = fileURLToPath(new URL('../src/', import.meta.url));
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', plugins: [{ name: 'instant-open', resolveId: (id) => id.endsWith('virtual:instant-open') ? '\0instant-open' : undefined, load: (id) => id === '\0instant-open' ? `export * from ${JSON.stringify(src + 'store.ts')}; export { t3 } from ${JSON.stringify(src + 'lib/t3.ts')}; export { api } from ${JSON.stringify(src + 'lib/api.ts')}; export * from ${JSON.stringify(src + 'lib/threadCache.ts')};` : undefined }], ssr: { noExternal: true }, build: { ssr: 'virtual:instant-open', write: false } });
const entry = entryChunk(bundle);
const app = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
const { useApp, t3, api, watchThread, readView, writeView, VIEW_BYTES } = app;

const streams = new Map();
const payloads = new Map();
t3.onState = () => () => {};
t3.onReconnect = () => () => {};
t3.connect = () => {};
t3.stream = (tag, payload, receive) => { streams.set(tag, receive); payloads.set(tag, payload); return { cancel() {}, done: new Promise(() => {}), live: () => false }; };
t3.call = async () => ({ providers: [] });
api.session = async () => ({ authenticated: true });
api.config = async () => ({}); api.settings = async () => ({}); api.bots = async () => []; api.botIdentities = async () => [];
globalThis.fetch = async () => Response.json([]);
await app.boot();
app.useApp.setState({ threads: {} });
after(() => { t3.stream = () => ({ cancel() {}, done: new Promise(() => {}), live: () => false }); });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const root = { id: 'root', title: 'Root', status: 'completed', lineage: { parentThreadId: null, rootThreadId: 'root' }, updatedAt: '2026-01-01T00:00:00Z' };
const message = (id: string, text: string) => ({ id, threadId: 'root', runId: 'run-1', type: 'assistant_message', status: 'completed', text, updatedAt: '2026-01-01T00:00:00Z' });
const view = (items: unknown[]) => ({ v: 1, key: 'root', savedAt: Date.now(), thread: null, items, runs: [], requests: [], subagents: [], historyCursor: null, hasMoreHistory: false });
const snapshot = (extra: Record<string, unknown>) => ({ kind: 'snapshot', snapshotSequence: 7, projection: { thread: root, runs: [], runtimeRequests: [], subagents: [], ...extra } });

test('a compact snapshot paints the rows it shows, and keeps interrupt requests from turnItems', () => {
  app.useApp.setState({ threadData: {} });
  const stop = watchThread('root');
  assert.equal(payloads.get('orchestration.subscribeThread').acceptCompactTurnItems, true, 'the snapshot asks for the rows once');
  const stopRow = { id: 'stop-1', threadId: 'root', type: 'run_interrupt_request', status: 'pending', updatedAt: root.updatedAt };
  const row = { item: message('m1', 'hello'), position: 0, visibility: 'local', sourceThreadId: 'root' };
  streams.get('orchestration.subscribeThread')(snapshot({ visibleTurnItems: [row], turnItems: [stopRow], turnItemsOmitLocalVisible: true }));
  const data = useApp.getState().threadData.root;
  assert.equal(data.stale, false, 'a snapshot is live');
  assert.deepEqual(Object.keys(data.items).sort(), ['m1', 'stop-1'], 'the shown row and the interrupt request, and no duplicate');
  assert.equal(data.items.m1.text, 'hello');
  stop();
});

test('the last copy paints before the snapshot, and the snapshot replaces it', async () => {
  app.useApp.setState({ threadData: {} });
  await writeView(view([message('old', 'from yesterday')]) as never);
  const stop = watchThread('root');
  await settle();
  await settle();
  const painted = useApp.getState().threadData.root;
  assert.equal(painted.stale, true, 'what a device kept says nothing about now');
  assert.equal(painted.loaded, true, 'and it is not a reason to wait');
  assert.deepEqual(Object.keys(painted.items), ['old']);
  streams.get('orchestration.subscribeThread')(snapshot({ visibleTurnItems: [{ item: message('new', 'this morning'), position: 0, visibility: 'local', sourceThreadId: 'root' }], turnItems: [] }));
  const live = useApp.getState().threadData.root;
  assert.equal(live.stale, false);
  assert.deepEqual(Object.keys(live.items), ['new'], 'the snapshot is the whole window, not a merge');
  stop();
});

test('a copy read back from the device is never written back as fresh', async () => {
  app.useApp.setState({ threadData: {} });
  const seeded = view([message('old', 'from yesterday')]);
  await writeView(seeded as never);
  const before = await readView('root');
  const stop = watchThread('root');
  await settle();
  await wait(1400);
  const afterWait = await readView('root');
  assert.equal(afterWait?.savedAt, before?.savedAt, 'a stale paint must not renew its own timestamp');
  assert.deepEqual(afterWait?.items.map((item: { id: string }) => item.id), ['old']);
  streams.get('orchestration.subscribeThread')(snapshot({ visibleTurnItems: [{ item: message('new', 'this morning'), position: 0, visibility: 'local', sourceThreadId: 'root' }], turnItems: [] }));
  await wait(1400);
  const saved = await readView('root');
  assert.deepEqual(saved?.items.map((item: { id: string }) => item.id), ['new'], 'a live thread is what the next launch opens');
  assert.equal(saved?.thread?.id, 'root');
  stop();
});

test('one conversation over its budget keeps its newest rows', async () => {
  const big = Array.from({ length: 400 }, (_, i) => ({ ...message(`m${i}`, 'x'.repeat(10_000)), ordinal: i }));
  await writeView(view(big) as never);
  const saved = await readView('root');
  const bytes = JSON.stringify(saved).length;
  assert.ok(bytes <= VIEW_BYTES + 200_000, `kept ${bytes} bytes`);
  assert.ok((saved?.items.length ?? 0) < big.length, 'the old end goes first');
  assert.equal(saved?.items.at(-1)?.id, 'm399', 'the newest row survives');
});
