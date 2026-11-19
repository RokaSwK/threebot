import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { buildOnce, entryChunk } from './support.mts';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem() {} } as unknown as Storage;
globalThis.location = new URL('http://rooms-offline.test/') as unknown as Location;
const listeners = new Map<string, (event: unknown) => void>();
globalThis.window = { setInterval() {}, clearInterval() {}, addEventListener: (type: string, fn: (event: unknown) => void) => { listeners.set(type, fn); } } as unknown as typeof window;
globalThis.document = { addEventListener() {}, visibilityState: 'visible' } as unknown as Document;

const src = fileURLToPath(new URL('../src/', import.meta.url));
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', plugins: [{ name: 'rooms-offline', resolveId: (id) => id.endsWith('virtual:rooms-offline') ? '\0rooms-offline' : undefined, load: (id) => id === '\0rooms-offline' ? `export * from ${JSON.stringify(src + 'store.ts')}; export { t3 } from ${JSON.stringify(src + 'lib/t3.ts')}; export { api } from ${JSON.stringify(src + 'lib/api.ts')}; export * from ${JSON.stringify(src + 'lib/threadCache.ts')}; export { roomLines } from ${JSON.stringify(src + 'lib/roomDelegation.ts')};` : undefined }], ssr: { noExternal: true }, build: { ssr: 'virtual:rooms-offline', write: false } });
const entry = entryChunk(bundle);
const app = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
const { useApp, t3, boot, loadRooms, selectRoom, watchThread, writeBoot, writeRoom, writeRooms, writeView, roomLines } = app;

const streams = new Map();
t3.onState = () => () => {};
t3.onReconnect = () => () => {};
t3.connect = () => {};
t3.stream = (tag, _payload, receive) => { streams.set(tag, receive); return { cancel() {}, done: new Promise(() => {}), live: () => false }; };
t3.call = async () => ({ providers: [] });
// No route to the gateway at all: the session, the room list and the room itself all fail to fetch.
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
after(() => { streams.clear(); });

const settle = () => new Promise((resolve) => setImmediate(resolve));
const at = '2026-01-01T00:00:00Z';
const settings = { userName: 'Cristian', timezone: 'UTC', autoReview: true, theme: 'dark', sections: [], rules: { alwaysAsk: [], allowWithoutAsking: [] } };
const bot = { slug: 'alpha', name: 'Alpha', label: 'Test Bot', primary: true, hidden: false, pinned: false, mainThreadId: 'thread-alpha', projectId: 'project-alpha', workspaceRoot: '/bots/alpha', createdAt: at };
const member = { slug: 'alpha', name: 'Alpha', label: 'Test Bot', color: 'green', shape: 'sphere', avatarImage: null, threadId: 'thread-alpha', status: 'ready', model: null, runtimeMode: 'auto', lastTurnAt: at };
const summary = { id: 'r1', name: 'Design review', description: '', section: null, pinned: false, mode: 'panel', members: [member], lastTurnAt: at, lastActivityAt: at, lastText: 'Look at this', queued: 0, running: false };
const turn = { id: 'turn-1', at, text: 'Look at this', mentions: ['alpha'], replyTo: null, status: 'done', runs: [{ slug: 'alpha', runId: 'run-1', replyItemId: 'reply-1', status: 'replied', at }] };
const room = { id: 'r1', name: 'Design review', description: '', guidance: '', section: null, pinned: false, createdAt: at, settings: { mode: 'panel', defaultResponder: 'lead', lead: 'alpha', model: 'inherit', mentionPolicy: 'anywhere', allowCrossMentions: true, maxWaves: 3, maxReplies: 10, memberTimeoutMin: 10, turnDeadlineMin: 20, notifications: true }, members: [member], formerMembers: [], turns: [turn] };
const reply = { id: 'reply-1', threadId: 'thread-alpha', runId: 'run-1', type: 'assistant_message', status: 'completed', text: 'The layout holds.', ordinal: 2, updatedAt: at };

test('a room lists and opens from what the device kept when the gateway is unreachable', async () => {
  await writeBoot({ botsRoot: '/bots', executorUrl: null, settings, bots: [bot], historical: [] });
  await writeRooms([summary] as never);
  await writeRoom(room as never);
  await writeView({ v: 1, key: 'thread-alpha', savedAt: Date.now(), thread: null, items: [reply] as never, runs: [], requests: [], subagents: [], historyCursor: null, hasMoreHistory: false });
  await boot();
  assert.equal(useApp.getState().auth, 'ready', 'the app opened from its copy');
  // The room list and the session check are read in the background: the app never waits to paint.
  await settle();
  assert.equal(useApp.getState().offline, true, 'the unreachable gateway is what marks it offline');

  assert.deepEqual(Object.keys(useApp.getState().rooms), ['r1'], 'opening the app already lists the room, not "No rooms yet"');
  const list = await loadRooms();
  assert.deepEqual(Object.keys(useApp.getState().rooms), ['r1'], 'and asking again still answers from the copy');
  assert.equal(list.length, 1);

  selectRoom('r1');
  await settle();
  await settle();
  const state = useApp.getState();
  assert.equal(state.roomView?.name, 'Design review', 'the room opens, not "Room unavailable"');
  assert.equal(state.roomStale, true, 'and says it is not live');
  assert.equal(state.roomError, null);

  // The replies live in the members' threads, which a room reads in full.
  const stop = watchThread('thread-alpha', false);
  await settle();
  await settle();
  const data = useApp.getState().threadData['thread-alpha'];
  assert.equal(data?.items['reply-1']?.text, 'The layout holds.');
  const lines = roomLines(room.members as never, room.turns as never, { 'thread-alpha': data });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'The layout holds.');
  assert.equal(lines[0].member.slug, 'alpha');
  stop();
});

test('a room this device never opened says so without waiting for the network', async () => {
  // A phone that has to fail a request before it can say "not here" shows a spinner for seconds.
  globalThis.fetch = () => new Promise<Response>((_, reject) => setTimeout(() => reject(new TypeError('Failed to fetch')), 800));
  const started = Date.now();
  selectRoom('never-opened');
  await settle();
  await settle();
  assert.equal(useApp.getState().roomMissing, true, 'storage answered: there is no copy');
  assert.equal(useApp.getState().roomView, null);
  assert.equal(useApp.getState().roomError, null, 'and nothing is wrong yet, the network has not even failed');
  assert.ok(Date.now() - started < 600, 'the page decided before the request gave up');
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(useApp.getState().roomMissing, true, 'a late failure changes nothing for the user');
});

test('the room list comes from the device before the gateway answers', async () => {
  // A phone can spend seconds failing a request: the list must not wait for that.
  globalThis.fetch = () => new Promise<Response>((_, reject) => setTimeout(() => reject(new TypeError('Failed to fetch')), 400));
  useApp.setState({ rooms: {} });
  const pending = loadRooms();
  await settle();
  await settle();
  assert.deepEqual(Object.keys(useApp.getState().rooms), ['r1'], 'listed from storage while the request is still out');
  await pending;
  assert.deepEqual(Object.keys(useApp.getState().rooms), ['r1'], 'and a request that fails changes nothing');
});

test('the radio saying offline is enough, without waiting for a socket', () => {
  useApp.setState({ offline: false });
  listeners.get('offline')?.(new Event('offline'));
  assert.equal(useApp.getState().offline, true);
});

test('a live room clears the copy flag, and a deleted room is forgotten', async () => {
  // The poll answers now: the room on screen is T3's, not the copy.
  globalThis.fetch = async (input: unknown) => Response.json(String(input).includes('/api/rooms/r1') ? { room } : { rooms: [summary] });
  selectRoom('r1');
  await settle();
  await app.loadRoom('r1');
  assert.equal(useApp.getState().roomStale, false);
  assert.equal(useApp.getState().roomView?.turns.length, 1);
  await app.forgetRoom('r1');
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await app.readRoom('r1'), null, 'deleting a room does not leave it to come back on the next launch');
});

test('a room deleted elsewhere does not come back from its copy', async () => {
  await writeRoom(room as never);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Room not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  useApp.setState({ selectedRoom: null, roomView: null, roomGone: false });
  selectRoom('r1');
  await settle();
  await settle();
  await settle();
  const state = useApp.getState();
  assert.equal(state.roomGone, true, 'a 404 is not a network failure');
  assert.equal(state.roomView, null, 'the copy is not painted back');
  assert.equal(state.roomStale, false);
  assert.equal(await app.readRoom('r1'), null, 'and the copy is forgotten for the next launch');
});
