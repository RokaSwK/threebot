import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { T3Client } from '../server/t3rpc.mjs';
import { parseLocalPwaOptions, startLocalPwaDev } from './local-pwa-dev.mjs';

test('CLI rejects ambiguous origins and attempts to select a live backend', () => {
  assert.throws(() => parseLocalPwaOptions(['--pwa-port', '5180', '--hmr-port', '5180']), /must differ/);
  assert.throws(() => parseLocalPwaOptions(['--hmr-port', 'NaN']), /integer/);
  assert.throws(() => parseLocalPwaOptions(['--scenario', 'live']), /Scenario must be/);
  assert.throws(() => parseLocalPwaOptions(['--live']), /Live mode is deliberately unavailable/);
});

test('cancelled startup does not allocate fixture listeners', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startLocalPwaDev({ signal: controller.signal }), { name: 'AbortError' });
});

test('actual HMR frontend, API/RPC proxy and built PWA assets share only disposable state', { timeout: 45000 }, async () => {
  const loop = await startLocalPwaDev({ pwaPort: 0, hmrPort: 0 });
  const rpc = new T3Client({ baseUrl: `${loop.hmrUrl}/t3`, token: 'fixture-only' });
  try {
    const hmrHtml = await (await fetch(loop.hmrUrl)).text();
    assert.match(hmrHtml, /\/@vite\/client/);
    assert.match(hmrHtml, /\/src\/main.tsx/);
    const module = await (await fetch(loop.hmrUrl + '/src/main.tsx')).text();
    assert.match(module, /"DEV": true/);
    assert.match(module, /createRoot/);
    const appModule = await (await fetch(loop.hmrUrl + '/src/App.tsx')).text();
    assert.match(appModule, /import\.meta\.hot/);
    const client = await (await fetch(loop.hmrUrl + '/@vite/client')).text();
    const token = client.match(/const wsToken = ["']([^"']+)["']/)[1];
    const hmrSocket = new WebSocket(loop.hmrUrl.replace(/^http/, 'ws') + '/?token=' + encodeURIComponent(token), 'vite-hmr');
    try {
      const connected = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('HMR connection timed out.')), 5000);
        hmrSocket.addEventListener('message', (event) => { clearTimeout(timeout); resolve(JSON.parse(event.data)); }, { once: true });
        hmrSocket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('HMR connection failed.')); }, { once: true });
      });
      assert.deepEqual(connected, { type: 'connected' });
    } finally { hmrSocket.close(); }
    assert.deepEqual(await (await fetch(loop.hmrUrl + '/api/session')).json(), { authenticated: true, passwordRequired: false, accessLogin: false });
    const bots = await (await fetch(loop.hmrUrl + '/api/bots')).json();
    assert.deepEqual(bots.bots.map((bot) => bot.slug).sort(), ['alpha', 'beta', 'gamma']);
    const environment = await (await fetch(loop.hmrUrl + '/t3/.well-known/t3/environment')).json();
    assert.equal(environment.label, 'Disposable local fixture (fake T3)');
    await rpc.connect();
    const family = await rpc.call('orchestration.getThreadFamily', { threadId: 'thread-alpha' });
    assert.deepEqual(family.threads.map((thread) => thread.id), ['thread-alpha', 'thread-alpha-child']);
    const manifest = await (await fetch(loop.pwaUrl + '/manifest.webmanifest')).json();
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    const worker = await fetch(loop.pwaUrl + '/sw.js');
    assert.equal(worker.headers.get('cache-control'), 'no-cache');
    assert.equal(await worker.text(), await readFile(new URL('../web/dist/sw.js', import.meta.url), 'utf8'));
    const builtHtml = await (await fetch(loop.pwaUrl)).text();
    assert.doesNotMatch(builtHtml, /\/@vite\/client/);
    const asset = builtHtml.match(/src="(\/assets\/[^" ]+\.js)"/)[1];
    assert.deepEqual(Buffer.from(await (await fetch(loop.pwaUrl + asset)).arrayBuffer()), await readFile(new URL('../web/dist' + asset, import.meta.url)));
    await loop.fixture.request('/api/main-bot', 'PUT', { slug: 'beta' });
    await loop.fixture.restart();
    const restarted = await (await fetch(loop.hmrUrl + '/api/bots')).json();
    assert.equal(restarted.bots.find((bot) => bot.primary).slug, 'beta');
    await loop.fixture.reset();
    const reset = await (await fetch(loop.hmrUrl + '/api/bots')).json();
    assert.equal(reset.bots.find((bot) => bot.primary).slug, 'alpha');
  } finally { rpc.close(); await loop.close(); await loop.close(); }
  await assert.rejects(access(loop.fixture.root), { code: 'ENOENT' });
  await assert.rejects(fetch(loop.hmrUrl, { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(fetch(loop.pwaUrl, { signal: AbortSignal.timeout(1000) }));
});

test('occupied HMR port fails without stopping its owner', { timeout: 30000 }, async () => {
  const owner = http.createServer((_req, res) => res.end('existing owner'));
  owner.listen(0, '127.0.0.1');
  await once(owner, 'listening');
  const hmrPort = owner.address().port;
  try {
    await assert.rejects(startLocalPwaDev({ pwaPort: 0, hmrPort }), /already in use/);
    assert.equal(await (await fetch(`http://127.0.0.1:${hmrPort}`)).text(), 'existing owner');
  } finally { await new Promise((resolve) => owner.close(resolve)); }
});

test('inherited backend and frontend environment values do not change fixture isolation', { timeout: 30000 }, async () => {
  const variables = { BOT_GATEWAY: 'http://127.0.0.1:1', BOT_SESSION: 'generic-do-not-forward', VITE_PRIVATE_CANARY: 'generic-not-for-client' };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  let loop;
  try {
    Object.assign(process.env, variables);
    loop = await startLocalPwaDev({ pwaPort: 0, hmrPort: 0 });
    const bots = await (await fetch(loop.hmrUrl + '/api/bots')).json();
    assert.deepEqual(bots.bots.map((bot) => bot.slug).sort(), ['alpha', 'beta', 'gamma']);
    const module = await (await fetch(loop.hmrUrl + '/src/main.tsx')).text();
    assert.doesNotMatch(module, /generic-not-for-client|generic-do-not-forward|127\.0\.0\.1:1["']/);
  } finally {
    await loop?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
