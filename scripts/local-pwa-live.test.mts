import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startLivePwaDev, validateLiveGateway } from './local-pwa-live.mts';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const { WebSocket, WebSocketServer } = require('ws');
const web = fileURLToPath(new URL('../web/', import.meta.url));
const TOKEN = 'fixture.private.signature';
let root: string, buildDir: string;
before(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'bot-local-live-')));
  buildDir = path.join(root, 'built');
  const { build } = await import(pathToFileURL(webRequire.resolve('vite')).href);
  await build({ root: web, configFile: path.join(web, 'vite.config.ts'), envDir: false, envPrefix: [], logLevel: 'silent', build: { outDir: buildDir, emptyOutDir: true } });
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

// What the fake gateway saw of each request or upgrade.
type Captured = { url: string | undefined; headers: http.IncomingHttpHeaders };
// `ws` comes from server/node_modules through require, untyped; this is the part of a socket used here.
type FakeWs = { send(data: unknown): void; on(event: 'message', listener: (message: Buffer) => void): void };

async function upstream() {
  let expected = TOKEN;
  const requests: Captured[] = [], upgrades: Captured[] = [], sockets = new Set<Socket>();
  const server = http.createServer(async (request, response) => {
    // T3 Code probes / on every new local port; the proxy always sends the Access assertion.
    if (request.url !== '/' || request.headers['cf-access-jwt-assertion']) requests.push({ url: request.url, headers: { ...request.headers } });
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cf-Access-Jwt-Assertion', expected);
    response.setHeader('Set-Cookie', 'CF_Authorization=must-not-reach-browser');
    if (request.headers['cf-access-jwt-assertion'] !== expected) {
      response.writeHead(401); response.end(JSON.stringify({ authenticated: false })); return;
    }
    if (request.url === '/api/session') response.end(JSON.stringify({ authenticated: true }));
    else {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.end(JSON.stringify({ ok: true, body: Buffer.concat(chunks).toString(), cookie: request.headers.cookie ?? null, authorization: request.headers.authorization ?? null }));
    }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('headers', (headers: string[]) => { headers.push(`Cf-Access-Jwt-Assertion: ${expected}`, 'Set-Cookie: CF_Authorization=must-not-reach-browser'); });
  server.on('upgrade', (request, socket, head) => {
    upgrades.push({ url: request.url, headers: { ...request.headers } });
    if (request.headers['cf-access-jwt-assertion'] !== expected) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, (ws: FakeWs) => {
      ws.send(JSON.stringify({ ready: true }));
      ws.on('message', (message) => ws.send(message));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, upgrades,
    setToken(value: string) { expected = value; },
    async close() { for (const client of wss.clients) client.terminate(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); wss.close(); },
  };
}

async function credentials(name = 'access.token', content = TOKEN) {
  const file = path.join(root, name);
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

test('target accepts only explicit loopback HTTP origins', () => {
  assert.equal(validateLiveGateway('http://127.0.0.1:43781'), 'http://127.0.0.1:43781');
  for (const target of ['https://example.com', 'http://192.0.2.10:3780', 'http://user:secret@127.0.0.1:43781', 'http://127.0.0.1:43781/path', 'http://127.0.0.1:43781/?token=secret']) {
    assert.throws(() => validateLiveGateway(target), /explicit HTTP loopback origin/);
  }
});

test('startup rejects missing, public, symlinked, malformed and unauthenticated credentials', { timeout: 15000 }, async () => {
  const remote = await upstream();
  const privateFile = await credentials('private.token');
  const publicFile = await credentials('public.token'); await chmod(publicFile, 0o644);
  const link = path.join(root, 'symlink.token'); await symlink(privateFile, link);
  const malformed = await credentials('malformed.token', 'private-value-with-newline\nunsafe');
  const servedFile = path.join(buildDir, 'must-not-serve.token'); await writeFile(servedFile, TOKEN, { mode: 0o600 });
  try {
    for (const tokenFile of [path.join(root, 'missing'), publicFile, link, malformed, servedFile]) {
      await assert.rejects(startLivePwaDev({ gateway: remote.origin, tokenFile, buildDir, hmrPort: 0, pwaPort: 0 }), /private regular token file/);
    }
    assert.equal(remote.requests.length, 0);
    const wrong = await credentials('wrong.token', 'wrong.private.signature');
    await assert.rejects(startLivePwaDev({ gateway: remote.origin, tokenFile: wrong, buildDir, hmrPort: 0, pwaPort: 0 }), /authentication failed/);
    assert.equal(remote.requests.length, 1);
  } finally { await rm(servedFile); await remote.close(); }
});

test('both actual local frontends proxy HTTP and WebSockets with private server-side authentication', { timeout: 30000 }, async () => {
  const remote = await upstream();
  const tokenFile = await credentials('live.token');
  const loop = await startLivePwaDev({ gateway: remote.origin, tokenFile, buildDir, hmrPort: 0, pwaPort: 0 });
  try {
    for (const origin of [loop.hmrUrl, loop.pwaUrl]) {
      const beforeDiagnostics = remote.requests.length;
      const diagnostics = await fetch(origin + '/api/__local_pwa_diagnostics', { headers: { 'Cf-Access-Jwt-Assertion': 'browser-spoof', Cookie: 'private-local-cookie', Authorization: 'private-local-bearer' } });
      assert.equal(diagnostics.status, 200);
      assert.match(diagnostics.headers.get('content-type')!, /^text\/html/);
      assert.equal(diagnostics.headers.get('cache-control'), 'no-store');
      assert.equal(diagnostics.headers.get('cf-access-jwt-assertion'), null);
      assert.equal(diagnostics.headers.get('set-cookie'), null);
      const diagnosticHtml = await diagnostics.text();
      assert.match(diagnosticHtml, /Local PWA diagnostics/);
      assert.match(diagnosticHtml, /navigator\.serviceWorker\.register\('\/sw\.js'/);
      assert.doesNotMatch(diagnosticHtml, /fixture\.private\.signature|browser-spoof|private-local-cookie|private-local-bearer/);
      assert.equal(remote.requests.length, beforeDiagnostics, 'diagnostics intercept before auth and upstream proxy');
      const response = await fetch(origin + '/api/probe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'browser-spoof', Cookie: 'local-cookie=private', Authorization: 'local-bearer' }, body: JSON.stringify({ operation: 'generic-test' }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cf-access-jwt-assertion'), null);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(await response.json(), { ok: true, body: '{"operation":"generic-test"}', cookie: null, authorization: null });
      const outgoing = remote.requests.at(-1)!;
      assert.equal(outgoing.headers['cf-access-jwt-assertion'], TOKEN);
      const client = new WebSocket(origin.replace(/^http/, 'ws') + '/t3/ws', { headers: { 'Cf-Access-Jwt-Assertion': 'browser-spoof', Cookie: 'local-cookie=private', Authorization: 'local-bearer' } });
      let handshake!: http.IncomingHttpHeaders;
      client.once('upgrade', (response: http.IncomingMessage) => { handshake = response.headers; });
      try {
        const [ready] = await once(client, 'message');
        assert.deepEqual(JSON.parse(ready), { ready: true });
        assert.equal(handshake['cf-access-jwt-assertion'], undefined);
        assert.equal(handshake['set-cookie'], undefined);
        const outgoing = remote.upgrades.at(-1)!;
        assert.equal(outgoing.headers['cf-access-jwt-assertion'], TOKEN);
        assert.equal(outgoing.headers.cookie, undefined);
        assert.equal(outgoing.headers.authorization, undefined);
        client.send('generic-echo');
        assert.equal(String((await once(client, 'message'))[0]), 'generic-echo');
      } finally { client.terminate(); }
    }
    const devHtml = await (await fetch(loop.hmrUrl)).text();
    assert.match(devHtml, /\/@vite\/client/);
    const module = await (await fetch(loop.hmrUrl + '/src/App.tsx')).text();
    assert.match(module, /import\.meta\.hot/);
    assert.doesNotMatch(module, /fixture\.private\.signature/);
    const dependencyPath = module.match(/from "([^"]+\/react\.js\?[^"]+)"/)![1];
    const dependency = await fetch(loop.hmrUrl + dependencyPath);
    assert.equal(dependency.status, 200);
    assert.match(await dependency.text(), /export/);
    const builtHtml = await (await fetch(loop.pwaUrl)).text();
    assert.doesNotMatch(builtHtml, /\/@vite\/client|fixture\.private\.signature/);
    const manifest = await (await fetch(loop.pwaUrl + '/manifest.webmanifest')).json();
    assert.equal(manifest.display, 'standalone');
    assert.equal(await (await fetch(loop.pwaUrl + '/sw.js')).text(), await readFile(path.join(buildDir, 'sw.js'), 'utf8'));
    const denied = await fetch(loop.hmrUrl + '/@fs' + tokenFile);
    assert.equal(denied.status, 403);
    assert.doesNotMatch(await denied.text(), /fixture\.private\.signature/);
    const replacement = 'replacement.private.signature';
    await writeFile(tokenFile, replacement); remote.setToken(replacement);
    assert.deepEqual(await (await fetch(loop.pwaUrl + '/api/session')).json(), { authenticated: true });
    assert.equal(remote.requests.at(-1)!.headers['cf-access-jwt-assertion'], replacement);
    const retained = new WebSocket(loop.pwaUrl.replace(/^http/, 'ws') + '/t3/ws');
    await once(retained, 'message');
    const retainedClosed = once(retained, 'close');
    const previousCount = remote.requests.length;
    const previousUpgrades = remote.upgrades.length;
    await rm(tokenFile);
    const unavailable = await fetch(loop.hmrUrl + '/api/probe');
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'Live gateway credentials are unavailable.' });
    assert.equal(remote.requests.length, previousCount);
    const blocked = new WebSocket(loop.pwaUrl.replace(/^http/, 'ws') + '/t3/ws', { headers: { 'Cf-Access-Jwt-Assertion': 'browser-spoof' } });
    await assert.rejects(once(blocked, 'open'), /503|socket hang up/);
    assert.equal(remote.upgrades.length, previousUpgrades);
    await loop.close();
    await retainedClosed;
    assert.equal(retained.readyState, WebSocket.CLOSED);
    assert.deepEqual(await (await fetch(remote.origin + '/api/session', { headers: { 'Cf-Access-Jwt-Assertion': replacement } })).json(), { authenticated: true });
  } finally { await loop.close(); await loop.close(); await remote.close(); }
  await assert.rejects(fetch(loop.hmrUrl, { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(fetch(loop.pwaUrl, { signal: AbortSignal.timeout(1000) }));
});

test('occupied frontend port is preserved and the other owned listener is cleaned up', { timeout: 15000 }, async () => {
  const remote = await upstream();
  const tokenFile = await credentials('owner.token');
  const owner = http.createServer((_req, response) => response.end('existing owner'));
  owner.listen(0, '127.0.0.1'); await once(owner, 'listening');
  const pwaPort = (owner.address() as AddressInfo).port;
  try {
    await assert.rejects(startLivePwaDev({ gateway: remote.origin, tokenFile, buildDir, hmrPort: 0, pwaPort }), /already in use/);
    assert.equal(await (await fetch(`http://127.0.0.1:${pwaPort}`)).text(), 'existing owner');
  } finally { await new Promise((resolve) => owner.close(resolve)); await remote.close(); }
});
