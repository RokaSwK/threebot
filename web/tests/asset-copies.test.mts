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
const { assetKey, assetSource, signedAsset, localAssetUrl, clearCache, readAsset, writeAsset } = app;

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
  const online = await assetSource(async () => '/t3/assets/pic-1?sig=abc', key, 'image');
  assert.deepEqual(requests, ['/t3/assets/pic-1?sig=abc'], 'one request: the bytes that render are the bytes that are kept');
  assert.match(String(online), /^blob:/, 'and the picture renders from those bytes');
  assert.equal((await readAsset(key, storedBytes))?.bytes, 1024);

  const again = await assetSource(async () => '/t3/assets/pic-1?sig=def', key, 'image');
  assert.equal(again, online, 'a kept picture is not requested or signed twice');
  assert.deepEqual(requests, ['/t3/assets/pic-1?sig=abc']);

  // Offline: the RPC that issues the URL fails, and the copy answers instead.
  const offline = await assetSource(async () => { throw new TypeError('Failed to fetch'); }, key, 'image');
  assert.equal(offline, online, 'the same object URL serves the last copy');
  assert.equal(await localAssetUrl(key), offline);
});

test('a file past the budget is not kept, and its signed URL still renders', async () => {
  globalThis.fetch = async (url: unknown) => { requests.push(String(url)); return picture(9 * 1024 * 1024, 'image/png'); };
  requests = [];
  const key = assetKey({ _tag: 'attachment', attachmentId: 'huge' })!;
  const source = await assetSource(async () => '/t3/assets/huge', key, 'image');
  assert.equal(source, '/t3/assets/huge', 'too big to keep, so the browser loads it the way it always did');
  assert.equal(await readAsset(key, storedBytes), null);
  globalThis.fetch = async (url: unknown) => { requests.push(String(url)); return picture(1024); };
});

test('signing a document is not downloading it', async () => {
  requests = [];
  const card = assetKey({ _tag: 'workspace-file', threadId: 'thread-a', path: 'docs/report.pdf' }, 'thread-a')!;
  assert.equal(await signedAsset(async () => '/t3/assets/report.pdf', card), '/t3/assets/report.pdf');
  await settle();
  assert.deepEqual(requests, [], 'a card signer never fetches the file it points at');
  assert.equal(await localAssetUrl(card), null);
  // Offline, a document nobody opened has no copy to fall back to: the caller keeps its error.
  await assert.rejects(signedAsset(async () => { throw new TypeError('Failed to fetch'); }, card));
});

test('signing out forgets the bytes as well as the transcripts', async () => {
  const key = assetKey({ _tag: 'attachment', attachmentId: 'pic-2' })!;
  await assetSource(async () => '/t3/assets/pic-2', key, 'image');
  assert.ok(await readAsset(key, storedBytes));
  await clearCache();
  await settle();
  assert.equal(await readAsset(key, storedBytes), null);
});

test('a file too big to keep is signed, not downloaded on the way through', async () => {
  requests = [];
  const key = assetKey({ _tag: 'attachment', attachmentId: 'huge' })!;
  const url = await assetSource(async () => '/t3/assets/huge', key, 'file', 9 * 1024 * 1024);
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
