import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { buildOnce, entryChunk } from './support.mts';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem() {} } as unknown as Storage;
globalThis.location = new URL('http://asset-copies.test/') as unknown as Location;
globalThis.window = { setInterval() {}, clearInterval() {}, addEventListener() {} } as unknown as typeof window;
globalThis.document = { addEventListener() {}, visibilityState: 'visible' } as unknown as Document;

const src = fileURLToPath(new URL('../src/', import.meta.url));
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', plugins: [{ name: 'asset-copies', resolveId: (id) => id.endsWith('virtual:asset-copies') ? '\0asset-copies' : undefined, load: (id) => id === '\0asset-copies' ? `export * from ${JSON.stringify(src + 'lib/assetCopies.ts')}; export * from ${JSON.stringify(src + 'lib/threadCache.ts')};` : undefined }], ssr: { noExternal: true }, build: { ssr: 'virtual:asset-copies', write: false } });
const entry = entryChunk(bundle);
const app = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
const { assetKey, assetSource, localAssetUrl, clearCache, readAsset, writeAsset } = app;

const network = globalThis.fetch;
const settle = () => new Promise((resolve) => setImmediate(resolve));
let requests: string[] = [];
const picture = (bytes: number, type = 'image/png') => new Response(new Blob([new Uint8Array(bytes)], { type }), { status: 200, headers: { 'content-type': type, 'content-length': String(bytes) } });
globalThis.fetch = async (url: unknown) => { requests.push(String(url)); return picture(1024); };
after(() => { globalThis.fetch = network; });

const storedBytes = (value: unknown): value is { bytes: number } => !!value && typeof value === 'object' && 'blob' in (value as Record<string, unknown>);

test('a picture is fetched once, kept, and comes back from the device when the gateway cannot sign it', async () => {
  const key = assetKey({ _tag: 'attachment', attachmentId: 'pic-1' })!;
  assert.equal(key, 'attachment:pic-1');
  requests = [];
  const online = await assetSource(async () => '/t3/assets/pic-1?sig=abc', key);
  assert.deepEqual(requests, ['/t3/assets/pic-1?sig=abc'], 'one request: the bytes that render are the bytes that are kept');
  assert.match(String(online), /^blob:/, 'and the picture renders from those bytes');
  assert.equal((await readAsset(key, storedBytes))?.bytes, 1024);

  const again = await assetSource(async () => '/t3/assets/pic-1?sig=def', key);
  assert.equal(again, online, 'a kept picture is not requested or signed twice');
  assert.deepEqual(requests, ['/t3/assets/pic-1?sig=abc']);

  // Offline: the RPC that issues the URL fails, and the copy answers instead.
  const offline = await assetSource(async () => { throw new TypeError('Failed to fetch'); }, key);
  assert.equal(offline, online, 'the same object URL serves the last copy');
  assert.equal(await localAssetUrl(key), offline);
});

test('a file past the budget is not kept, and its signed URL still renders', async () => {
  globalThis.fetch = async (url: unknown) => { requests.push(String(url)); return picture(9 * 1024 * 1024, 'image/png'); };
  requests = [];
  const key = assetKey({ _tag: 'attachment', attachmentId: 'huge' })!;
  const source = await assetSource(async () => '/t3/assets/huge', key);
  assert.equal(source, '/t3/assets/huge', 'too big to keep, so the browser loads it the way it always did');
  assert.equal(await readAsset(key, storedBytes), null);
  globalThis.fetch = async (url: unknown) => { requests.push(String(url)); return picture(1024); };
});

test('signing out forgets the bytes as well as the transcripts', async () => {
  const key = assetKey({ _tag: 'attachment', attachmentId: 'pic-2' })!;
  await assetSource(async () => '/t3/assets/pic-2', key);
  assert.ok(await readAsset(key, storedBytes));
  await clearCache();
  await settle();
  assert.equal(await readAsset(key, storedBytes), null);
});

test('a file too big to keep is signed, not downloaded on the way through', async () => {
  requests = [];
  const key = assetKey({ _tag: 'attachment', attachmentId: 'huge' })!;
  const url = await assetSource(async () => '/t3/assets/huge', key, { knownBytes: 9 * 1024 * 1024 });
  assert.equal(url, '/t3/assets/huge');
  assert.deepEqual(requests, [], 'the caller downloads it once; keeping it would have downloaded it first');
});

test('assets are budgeted by their bytes, not by the length of their metadata', async () => {
  await clearCache();
  const size = 14 * 1024 * 1024;
  const stored = (key: string) => ({ v: 1, key, savedAt: Date.now(), bytes: size, mimeType: 'image/png', blob: new Blob([new Uint8Array(size)], { type: 'image/png' }) });
  await writeAsset('big-1', stored('big-1'));
  await writeAsset('big-2', stored('big-2'));
  await writeAsset('big-3', stored('big-3'));
  assert.equal(await readAsset('big-1', storedBytes), null, 'three times the rule drops the oldest');
  assert.ok(await readAsset('big-2', storedBytes));
  assert.ok(await readAsset('big-3', storedBytes));
});

test('offline, a sign that never answers does not hold a kept file back', async () => {
  const key = assetKey({ _tag: 'workspace-file', threadId: 'thread-w', path: 'notes/chart.png' })!;
  await assetSource(async () => '/t3/assets/chart?sig=1', key);
  app.resetAssetCopies();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
  try {
    const started = Date.now();
    const url = await assetSource(() => new Promise<string>(() => {}), key);
    assert.match(String(url), /^blob:/);
    assert.ok(Date.now() - started < 1000, 'the copy answers at once instead of waiting on a socket');
  } finally {
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  }
});

test('a deleted conversation takes the pictures it showed with it, and a late fetch cannot bring one back', async () => {
  const key = assetKey({ _tag: 'attachment', attachmentId: 'pic-deleted' })!;
  const drawn = await assetSource(async () => '/t3/assets/pic-deleted?sig=1', key, { owner: 'view:thread-with-picture' });
  assert.ok(await readAsset(key, storedBytes));
  const gone = await app.forgetRecords(['view:thread-with-picture'], { deleted: true });
  app.revokeAssetHandles(gone);
  assert.equal(await readAsset(key, storedBytes), null, 'owned by the conversation, so it goes with it');
  assert.notEqual(await localAssetUrl(key), drawn, 'and its handle is no longer handed out');
  // A fetch that started before the deletion lands afterwards.
  const late = await assetSource(async () => '/t3/assets/pic-deleted?sig=2', key, { owner: 'view:thread-with-picture' });
  assert.equal(await readAsset(key, storedBytes), null, 'the deleted conversation does not get its picture back');
  assert.equal(late, '/t3/assets/pic-deleted?sig=2', 'and no handle to unkept bytes is handed out');
});

test('only raster pictures are kept: anything a browser could run stays on its signed URL', async () => {
  for (const type of ['image/svg+xml', 'text/html', 'application/pdf']) {
    globalThis.fetch = async (url: unknown) => { requests.push(String(url)); return picture(512, type); };
    const key = assetKey({ _tag: 'attachment', attachmentId: `active-${type}` })!;
    assert.equal(await assetSource(async () => `/t3/assets/active?sig=${type}`, key), `/t3/assets/active?sig=${type}`, type);
    assert.equal(await readAsset(key, storedBytes), null, `${type} is not kept`);
  }
  globalThis.fetch = async (url: unknown) => { requests.push(String(url)); return picture(1024); };
});

test('a picture whose size is not declared stops downloading at the budget', async () => {
  let pulled = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({ pull(controller) { pulled += 1024 * 1024; controller.enqueue(new Uint8Array(1024 * 1024)); } }), { status: 200, headers: { 'content-type': 'image/png' } });
  const key = assetKey({ _tag: 'attachment', attachmentId: 'endless' })!;
  assert.equal(await assetSource(async () => '/t3/assets/endless', key), '/t3/assets/endless');
  assert.ok(pulled <= 6 * 1024 * 1024, `stopped after ${pulled} bytes`);
  assert.equal(await readAsset(key, storedBytes), null);
  globalThis.fetch = async (url: unknown) => { requests.push(String(url)); return picture(1024); };
});

test('a kept picture older than a sign-in lasts is not drawn', async () => {
  const real = Date.now;
  const key = assetKey({ _tag: 'attachment', attachmentId: 'old-pic' })!;
  Date.now = () => real() - 31 * 24 * 60 * 60 * 1000;
  try { await assetSource(async () => '/t3/assets/old-pic', key); } finally { Date.now = real; }
  app.resetAssetCopies();
  assert.equal(await localAssetUrl(key), null);
});

test('a picture never outlives the conversation copy that showed it, even when that copy is evicted', async () => {
  await clearCache();
  const key = assetKey({ _tag: 'attachment', attachmentId: 'evicted-owner-pic' })!;
  const view = (name: string) => ({ v: 1, key: name, savedAt: Date.now(), thread: null, items: [{ id: 'm1' }], runs: [], requests: [], subagents: [], historyCursor: null, hasMoreHistory: false });
  await app.writeView(view('thread-oldest'));
  const drawn = await assetSource(async () => '/t3/assets/evicted-owner-pic', key, { owner: 'view:thread-oldest' });
  assert.match(String(drawn), /^blob:/);
  // Eight newer conversations push the oldest out of its budget.
  for (let index = 0; index < 8; index++) await app.writeView(view(`thread-newer-${index}`));
  assert.equal(await app.readView('thread-oldest'), null);
  assert.equal(await readAsset(key, storedBytes), null, 'its picture went with it');
  assert.notEqual(await localAssetUrl(key), drawn, 'and so did the handle');
});

test('a picture whose owner expires while it is fetched is neither kept nor handed out', async () => {
  await clearCache();
  const real = Date.now;
  const key = assetKey({ _tag: 'attachment', attachmentId: 'orphaned-pic' })!;
  Date.now = () => real() - 31 * 24 * 60 * 60 * 1000;
  try { await app.writeView({ v: 1, key: 'thread-expired', savedAt: Date.now(), thread: null, items: [], runs: [], requests: [], subagents: [], historyCursor: null, hasMoreHistory: false }); } finally { Date.now = real; }
  const source = await assetSource(async () => '/t3/assets/orphaned-pic', key, { owner: 'view:thread-expired' });
  assert.equal(source, '/t3/assets/orphaned-pic');
  assert.equal(await readAsset(key, storedBytes), null);
});
