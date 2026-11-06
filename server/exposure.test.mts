import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { exposureConfig, landingPath } from './exposure.mts';

const freePort = async () => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
};

// Fixture directories and an unreachable T3 only. Nothing real is read or changed.
async function startGateway(env) {
  const root = await mkdtemp(path.join(tmpdir(), 'exposure-'));
  await mkdir(path.join(root, 'bots'), { recursive: true });
  await mkdir(path.join(root, 'dist/welcome/img'), { recursive: true });
  await writeFile(path.join(root, 'dist/index.html'), 'APP SHELL');
  await writeFile(path.join(root, 'dist/welcome/index.html'), 'LANDING');
  await writeFile(path.join(root, 'dist/welcome/img/ball.webp'), 'BALL');
  const port = await freePort(), tailnet = await freePort();
  const child = spawn(process.execPath, [new URL('./gateway.mts', import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH, HOME: root, CODEX_HOME: path.join(root, 'codex'), HOST: '127.0.0.1', PORT: String(port),
      BOTS_ROOT: path.join(root, 'bots'), STATIC_DIR: path.join(root, 'dist'), T3_URL: 'http://127.0.0.1:1', T3_TOKEN: 'fixture-only',
      BOT_MCP_TOKEN: 'fixture-only', BOT_PASSWORD: '', VAULT_FILE: path.join(root, 'vault.enc'), VAULT_KEY_FILE: path.join(root, 'vault-key'),
      CF_ACCESS_TEAM_DOMAIN: 'fixture.invalid', CF_ACCESS_AUD: 'fixture', CF_ACCESS_EMAILS: 'me@example.com',
      TAILNET_PORT: String(tailnet), TAILNET_USERS: 'me@example.com', ...env,
    }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('fixture gateway did not start')), 8000);
    let seen = '';
    child.stdout.on('data', (data) => { seen += data; if (seen.includes('bot gateway on') && seen.includes('tailnet listener')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', (code) => reject(new Error(`gateway exited ${code}`)));
  });
  return { port, tailnet, stop: async () => { child.removeAllListeners('exit'); child.kill(); await once(child, 'exit').catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}
const get = (port, url, headers = {}, method = 'GET') => fetch(`http://127.0.0.1:${port}${url}`, { headers, method, redirect: 'manual' });
const you = { 'tailscale-user-login': 'me@example.com' };
const socketStatus = (port, headers) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/t3/ws`, { headers });
  ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate(); });
  ws.on('open', () => { resolve('open'); ws.terminate(); });
  ws.on('error', () => resolve('error'));
});

describe('landing-only mode', () => {
  let gateway;
  before(async () => { gateway = await startGateway({ PUBLIC_LANDING_ONLY: 'true' }); });
  after(() => gateway.stop());

  test('the public port shows the landing page and nothing else', async () => {
    assert.equal(await (await get(gateway.port, '/')).text(), 'LANDING');
    assert.equal(await (await get(gateway.port, '/welcome/')).text(), 'LANDING');
    assert.equal(await (await get(gateway.port, '/welcome/img/ball.webp')).text(), 'BALL');
    for (const url of ['/index.html', '/sw.js', '/login', '/assets/index.js', '/api/session', '/api/bots', '/t3/ws', '/t3/api/anything']) {
      assert.equal((await get(gateway.port, url)).status, 404, url);
    }
    assert.equal((await get(gateway.port, '/api/bots', you)).status, 404, 'a Tailscale header means nothing on the public port');
    assert.equal((await get(gateway.port, '/', {}, 'POST')).status, 404);
  });

  test('sockets on the public port are refused outright', async () => {
    assert.equal(await socketStatus(gateway.port, you), 404);
  });

  test("the Bots' local tool server stays reachable locally and never through Cloudflare", async () => {
    assert.notEqual((await get(gateway.port, '/mcp/bot', { authorization: 'Bearer fixture-only' }, 'POST')).status, 404);
    assert.equal((await get(gateway.port, '/mcp/bot', { 'cf-ray': 'x', authorization: 'Bearer fixture-only' }, 'POST')).status, 404);
  });

  test('the tailnet port serves the app to you and only you', async () => {
    assert.equal(await (await get(gateway.tailnet, '/')).text(), 'APP SHELL');
    assert.equal((await get(gateway.tailnet, '/api/bots', you)).status, 200);
    assert.equal((await get(gateway.tailnet, '/api/bots', { 'tailscale-user-login': 'ME@example.com ' })).status, 200);
    assert.equal((await get(gateway.tailnet, '/api/bots')).status, 401);
    assert.equal((await get(gateway.tailnet, '/api/bots', { 'tailscale-user-login': 'guest@example.com' })).status, 401);
    assert.equal((await get(gateway.tailnet, '/api/bots', { 'cf-access-jwt-assertion': 'a.b.c' })).status, 401);
    assert.equal(await socketStatus(gateway.tailnet, {}), 401);
    assert.equal(await socketStatus(gateway.tailnet, { ...you, origin: 'https://example.com' }), 403);
  });

  test('signing out on the tailnet stays on the tailnet', async () => {
    const config = await (await get(gateway.tailnet, '/api/config', you)).json();
    assert.equal(config.accessLogout, false);
  });
});

test('with the switch off, the public port behaves as before', async () => {
  const gateway = await startGateway({});
  try {
    assert.equal(await (await get(gateway.port, '/')).text(), 'APP SHELL');
    assert.equal((await get(gateway.port, '/api/bots')).status, 401);
    assert.equal((await get(gateway.port, '/api/bots', you)).status, 401, 'a Tailscale header means nothing on the public port');
    assert.equal(await socketStatus(gateway.port, you), 401);
  } finally { await gateway.stop(); }
});

test('configuration is explicit', () => {
  assert.deepEqual(exposureConfig({}), { tailnetPort: 0, tailnetUsers: new Set(), landingOnly: false });
  assert.deepEqual([...exposureConfig({ TAILNET_USERS: ' A@b.com, c@d.com ' }).tailnetUsers], ['a@b.com', 'c@d.com']);
  assert.equal(exposureConfig({ PUBLIC_LANDING_ONLY: '1' }).landingOnly, false);
  for (const url of ['/', '/welcome/', '/welcome/img/x.webp']) assert.equal(landingPath(url), true, url);
  for (const url of ['/welcome/../api/bots', '/welcome/img/../../sw.js', '/welcome/img/.env', '/index.html']) assert.equal(landingPath(url), false, url);
});
