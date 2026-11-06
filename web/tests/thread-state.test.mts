import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { buildOnce, entryChunk } from './support.mts';

globalThis.localStorage = { getItem: () => null, setItem() {} } as unknown as Storage;
globalThis.location = new URL('http://thread-state.test') as unknown as Location;
globalThis.window = { setInterval() {}, clearInterval() {} } as unknown as typeof window;
const src = new URL('../src/', import.meta.url).pathname;
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', plugins: [{ name: 'thread-state',
  resolveId: id => id.endsWith('virtual:thread-state') ? '\0thread-state' : undefined,
  load: id => id === '\0thread-state' ? `export * from ${JSON.stringify(src + 'store.ts')}; export { t3 } from ${JSON.stringify(src + 'lib/t3.ts')}; export { api } from ${JSON.stringify(src + 'lib/api.ts')};` : undefined,
}], ssr: { noExternal: true }, build: { ssr: 'virtual:thread-state', write: false } });
const entry = entryChunk(bundle);
const { boot, useApp, t3, api, loadThreadFamily, watchThread, conversationStatus, botStatus } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
const streams = new Map(); let reconnect;
t3.onState = () => () => {};
t3.onReconnect = fn => { reconnect = fn; return () => {}; };
t3.connect = () => {};
t3.stream = (tag, payload, receive) => { streams.set(tag, receive); return { cancel() {}, done: new Promise(() => {}) }; };
t3.call = async tag => tag === 'server.getConfig' ? { providers: [] } : { threads: [] };
api.session = async () => ({ authenticated: true }); api.config = async () => ({}); api.settings = async () => ({}); api.bots = async () => []; api.botIdentities = async () => [];
globalThis.fetch = async () => Response.json([]);
await boot(); reconnect();
const root = { id: 'root', title: 'Root', status: 'completed', lineage: { parentThreadId: null }, updatedAt: '2026-01-01T00:00:00Z' };
const child = { id: 'child', title: 'Child', status: 'idle', lineage: { parentThreadId: 'root', relationshipToParent: 'subagent' }, settledOverride: null, settledAt: null, updatedAt: root.updatedAt };
const shell = snapshot => streams.get('orchestration.subscribeShell')({ kind: 'snapshot', snapshot: { projects: [], threads: snapshot } });
after(() => { shell([]); });

test('family children survive omitted shell snapshots and concurrent reads share one request', async () => {
  let resolve, calls = 0;
  t3.call = (tag) => { assert.equal(tag, 'orchestration.getThreadFamily'); calls++; return new Promise(done => { resolve = done; }); };
  const first = loadThreadFamily('root'), second = loadThreadFamily('root');
  assert.equal(calls, 1); resolve({ threads: [root, child] }); await Promise.all([first, second]);
  shell([root]); assert.equal(useApp.getState().threads.child.id, 'child');
  shell([]); assert.equal(useApp.getState().threads.child.id, 'child'); assert.equal(useApp.getState().threads.root, undefined, 'an empty authoritative shell removes absent roots');
  streams.get('orchestration.subscribeShell')({ kind: 'thread.removed', threadId: 'child' });
  assert.equal(useApp.getState().threads.child, undefined);
});

test('a Bot keeps its main thread through a shell snapshot that omits it', () => {
  useApp.setState({ bots: { money: { slug: 'money', mainThreadId: 'root' } }, threads: { root } });
  shell([]);
  assert.equal(useApp.getState().threads.root?.id, 'root');
  streams.get('orchestration.subscribeShell')({ kind: 'thread.removed', threadId: 'root' });
  assert.equal(useApp.getState().threads.root, undefined, 'an explicit removal still wins');
  useApp.setState({ bots: {} });
});

test('subagent snapshot and updates resolve native idle children without a turn-item resend', () => {
  useApp.setState({ threads: { root, child } });
  const stop = watchThread('root'); const receive = streams.get('orchestration.subscribeThread');
  const agent = { id: 'agent', childThreadId: 'child', status: 'running', updatedAt: root.updatedAt };
  t3.call = async () => ({ threads: [root, child] });
  receive({ kind: 'snapshot', projection: { thread: root, turnItems: [], runs: [], subagents: [agent] } });
  assert.equal(conversationStatus('child'), 'running');
  receive({ kind: 'event', event: { type: 'subagent.updated', payload: { ...agent, status: 'completed', updatedAt: '2026-01-02T00:00:00Z' } } });
  assert.equal(conversationStatus('child'), 'completed'); stop();
});

test('settled and unsettled lifecycle events reach Details state and settled Bots are done', () => {
  useApp.setState({ threads: { root } });
  const stop = watchThread('root'); const receive = streams.get('orchestration.subscribeThread');
  receive({ kind: 'event', event: { type: 'thread.settled', payload: { ...root, settledOverride: 'settled', settledAt: root.updatedAt, unsettledAt: null } } });
  assert.equal(conversationStatus('root'), 'completed'); assert.equal(botStatus({ mainThreadId: 'root' }), 'done');
  receive({ kind: 'event', event: { type: 'thread.unsettled', payload: { ...root, status: 'idle', settledOverride: 'active', settledAt: null, unsettledAt: '2026-01-02T00:00:00Z' } } });
  assert.equal(conversationStatus('root'), 'idle'); assert.equal(botStatus({ mainThreadId: 'root' }), 'idle'); stop();
});
