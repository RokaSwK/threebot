import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAssetManifest, verifyAssets } from './verify-assets.mjs';

const executable = fileURLToPath(new URL('./verify-assets.mjs', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const content = new Map([
  ['/index.html', Buffer.from('<script src="/assets/app.js"></script>')],
  ['/assets/app.js', Buffer.from('import("./lazy/grammar.js");')],
  ['/assets/lazy/grammar.js', Buffer.from('export const language = "雪";')],
  ['/assets/img%20%231.png', Buffer.from([0, 255, 40, 1])],
]);

async function buildFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'bot-assets-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  await mkdir(path.join(dist, 'assets', 'lazy'), { recursive: true });
  for (const [name, bytes] of content) await writeFile(path.join(dist, decodeURIComponent(name)), bytes);
  return { root, dist };
}

async function serverFixture(t, handler) {
  const seen = [];
  // The verifier never requests `/`; local tools can probe any newly opened port.
  const server = http.createServer((req, res) => { if (req.url !== '/') seen.push(req.url); handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

function cli(args, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [executable, ...args], { timeout: 10_000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function tree(directory) {
  const result = [];
  for (const name of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, name.name);
    if (name.isDirectory()) result.push(...(await tree(filename)).map(([child, bytes]) => [name.name + '/' + child, bytes]));
    else result.push([name.name, (await readFile(filename)).toString('base64')]);
  }
  return result.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

test('deterministic manifest covers exact binary bytes and encoded nested lazy asset paths', async (t) => {
  const { root, dist } = await buildFixture(t);
  await writeFile(path.join(dist, 'ignored.txt'), 'Not a generated asset');
  const before = await tree(dist);
  const expected = { files: [...content].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  assert.deepEqual(await createAssetManifest(dist), expected);
  assert.deepEqual(await createAssetManifest(dist), expected);
  const output = await cli(['--dist', dist], { cwd: root });
  assert.equal(output.code, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout), expected);
  assert.equal(output.stderr, '');
  assert.deepEqual(await tree(dist), before, 'manifest generation creates, edits and removes no files');
});

test('CLI verifies every expected file and ignores retained old assets without mutation', async (t) => {
  const { dist } = await buildFixture(t);
  const before = await tree(dist);
  const { origin, seen } = await serverFixture(t, (req, res) => {
    const body = content.get(req.url) ?? (req.url === '/assets/old.js' ? Buffer.from('retained old build') : null);
    res.writeHead(body ? 200 : 404); res.end(body);
  });
  const output = await cli(['--origin', origin, '--dist', dist]);
  assert.equal(output.code, 0, output.stderr);
  assert.equal(output.stdout, `Verified 4 build files (${[...content.values()].reduce((n, bytes) => n + bytes.length, 0)} bytes).\n`);
  assert.equal(output.stderr, '');
  assert.deepEqual(seen.sort(), [...content.keys()].sort());
  assert.deepEqual(await tree(dist), before);
});

for (const variant of ['missing', 'truncated', 'same-size-corrupt', 'oversized', 'redirect']) {
  test(`CLI fails on ${variant} lazy chunk without leaking a response body`, async (t) => {
    const { dist } = await buildFixture(t);
    const failed = '/assets/lazy/grammar.js';
    const { origin, seen } = await serverFixture(t, (req, res) => {
      if (req.url !== failed) { const body = content.get(req.url); res.writeHead(body ? 200 : 404); res.end(body); return; }
      if (variant === 'missing') { res.writeHead(404); res.end('private server response'); }
      else if (variant === 'redirect') { res.writeHead(302, { location: '/login?secret=private-token' }); res.end('private server response'); }
      else if (variant === 'truncated') { res.end(content.get(failed).subarray(0, 3)); }
      else if (variant === 'oversized') { res.end(Buffer.alloc(content.get(failed).length + 1, 'x')); }
      else res.end(Buffer.alloc(content.get(failed).length, 'x'));
    });
    const output = await cli(['--dist', dist, '--origin', origin]);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /Asset \/assets\/lazy\/grammar\.js: (HTTP (404|302)|byte length mismatch|SHA-256 mismatch)/);
    assert.equal(output.stdout, '');
    assert.doesNotMatch(output.stderr, /private|server response|login|secret/);
    assert.equal(seen.some((name) => name.startsWith('/login')), false, 'redirect is never followed');
  });
}

test('network concurrency is bounded while all chunks are verified', async (t) => {
  const { dist } = await buildFixture(t);
  let active = 0, maximum = 0;
  const { origin, seen } = await serverFixture(t, (req, res) => {
    if (req.url === '/') return res.end();
    active++; maximum = Math.max(maximum, active);
    setTimeout(() => { active--; res.end(content.get(req.url)); }, 20);
  });
  const summary = await verifyAssets(dist, origin, { concurrency: 2, timeoutMs: 1000 });
  assert.deepEqual(summary, { files: 4, bytes: [...content.values()].reduce((n, bytes) => n + bytes.length, 0) });
  assert.equal(maximum, 2);
  assert.deepEqual(seen.sort(), [...content.keys()].sort());
});

test('stalled response is aborted with a bounded timeout', async (t) => {
  const { dist } = await buildFixture(t);
  const { origin } = await serverFixture(t, (_req, res) => { res.writeHead(200); res.flushHeaders(); });
  await assert.rejects(verifyAssets(dist, origin, { concurrency: 1, timeoutMs: 50 }), /request timed out/);
});

for (const entry of ['dist', 'index.html', 'assets', 'assets/lazy/grammar.js', 'ignored-link']) {
  test(`symlink rejected before reading build content: ${entry}`, async (t) => {
    const { root, dist } = await buildFixture(t);
    const outside = path.join(root, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'secret'), 'outside build');
    const target = entry === 'dist' ? dist : path.join(dist, entry);
    await rm(target, { recursive: true, force: true });
    await symlink(outside, target);
    await assert.rejects(createAssetManifest(dist), /Symlink rejected/);
    assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'outside build');
  });
}

test('missing index, empty index, missing assets and empty assets fail closed', async (t) => {
  const { root, dist } = await buildFixture(t);
  await assert.rejects(createAssetManifest(path.join(root, 'missing')), /Missing or unreadable/);
  await rm(path.join(dist, 'index.html'));
  await assert.rejects(createAssetManifest(dist), /requires index\.html/);
  await writeFile(path.join(dist, 'index.html'), '');
  await assert.rejects(createAssetManifest(dist), /empty or unreadable build file: \/index\.html/);
  await writeFile(path.join(dist, 'index.html'), 'index');
  await rm(path.join(dist, 'assets'), { recursive: true });
  await assert.rejects(createAssetManifest(dist), /requires nonempty assets/);
  await mkdir(path.join(dist, 'assets'));
  await assert.rejects(createAssetManifest(dist), /requires nonempty assets/);
  const output = await cli(['--dist', dist]);
  assert.equal(output.code, 1); assert.equal(output.stdout, '');
});

test('invalid origins and options reject without echoing credential-bearing input', async (t) => {
  const { dist } = await buildFixture(t);
  for (const origin of ['ftp://example.invalid', 'not-an-origin', 'https://private-user:private-password@example.invalid', 'https://example.invalid/path', 'https://example.invalid/path/..', 'https://example.invalid/?', 'https://example.invalid/#', 'https://example.invalid/?secret=private-token', 'https://example.invalid/#private-token']) {
    const output = await cli(['--dist', dist, '--origin', origin]);
    assert.equal(output.code, 1); assert.equal(output.stdout, '');
    assert.match(output.stderr, /Origin must be an HTTP\(S\) origin/);
    assert.doesNotMatch(output.stderr, /private-user|private-password|private-token|example\.invalid/);
  }
  await assert.rejects(verifyAssets(dist, 'http://127.0.0.1', { concurrency: 0 }), /Concurrency/);
  await assert.rejects(verifyAssets(dist, 'http://127.0.0.1', { timeoutMs: 0 }), /Timeout/);
  const unknown = await cli(['--unknown']);
  assert.equal(unknown.code, 1); assert.match(unknown.stderr, /Usage/);
});

for (const failed of ['/assets/lazy/grammar.js', '/index.html']) test(`network errors at ${failed} produce nonzero CLI exit without revealing transport details`, async (t) => {
  const { dist } = await buildFixture(t);
  const { origin, seen } = await serverFixture(t, (req, res) => {
    // Keep other concurrent requests pending so this file fails first on every
    // platform. Cancellation must not replace its error with another path.
    if (req.url === failed) res.destroy();
  });
  const output = await cli(['--dist', dist, '--origin', origin]);
  assert.equal(output.code, 1); assert.equal(output.stdout, '');
  assert.equal(output.stderr, `Asset ${failed}: request failed\n`);
  assert.ok(seen.includes(failed), 'the failing file was actually requested');
  assert.doesNotMatch(output.stderr, /socket|UND_ERR|stack|cause/);
});
