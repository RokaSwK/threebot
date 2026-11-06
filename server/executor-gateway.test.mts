import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { startFakeT3 } from '../scripts/fixture-t3.mts';

const TOKEN = 'fake-gateway-executor-token';
const PASSWORD = 'fake-gateway-password';
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

async function fakeExecutor(t: TestContext) {
  const state: { requests: { path: string; method: string; body: string; authorization?: string }[]; linked: boolean; status: string; unauthorized: boolean } = { requests: [], linked: false, status: 'pending', unauthorized: false };
  const account = { id: 'acct_fixture', label: 'Generic account', credentialsFingerprint: 'never-return-this' };
  const app = { id: 'app_fixture', slug: 'sample', name: 'Sample', requirements: { accounts: { service: { scope: 'user', definition: { name: 'Sample service' }, cardinality: 'many' } } } };
  let origin: string;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    state.requests.push({ path: req.url!, method: req.method!, body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization });
    if (state.unauthorized) return json(res, 401, { error: TOKEN });
    const route = req.url!.replace('/api/organizations/workspace', '');
    if (route === '/apps') return json(res, 200, [app]);
    if (route === '/apps/app_fixture') return json(res, 200, app);
    if (route.startsWith('/catalog?')) return json(res, 200, [{ id: 'cat_fixture', name: 'Sample', description: 'Generic', package: 'sample', auth: [] }]);
    if (route === '/apps/install' && req.method === 'POST') return json(res, 200, app);
    if (route === '/apps/app_fixture/accounts/user') return json(res, 200, state.linked ? [{ requirement: 'service', account, signIn: { state: 'saved', reconnectAt: null } }] : []);
    if (route === '/apps/app_fixture/accounts/user/service') return json(res, 200, { requirement: 'service', scope: 'user', cardinality: 'many', accounts: [{ account, linked: state.linked }] });
    if (route === '/apps/app_fixture/accounts/user/service/acct_fixture' && ['PUT', 'DELETE'].includes(req.method!)) { state.linked = req.method === 'PUT'; return json(res, 200, { requirement: 'service', account }); }
    if (route === '/apps/app_fixture/accounts/user/service/connections' || route === '/connections/con_fixture') return json(res, 200, { id: 'con_fixture', target: { app: app.id, requirement: 'service', name: 'Sample service' }, state: { status: state.status, ...(state.status === 'completed' ? { account } : {}) }, url: `${origin}/org/workspace/connections/con_fixture`, expiresAt: '2026-12-01T00:00:00Z', checkable: true });
    json(res, 404, { error: 'Unknown fixture route' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { origin, state };
}

async function gateway(t: TestContext, executorEnv: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'executor-gateway-'));
  const botsRoot = path.join(root, 'bots');
  for (const slug of ['alpha', 'beta']) {
    const dir = path.join(botsRoot, slug); await mkdir(path.join(dir, '.bot'), { recursive: true }); await mkdir(path.join(dir, '.codex'), { recursive: true });
    await writeFile(path.join(dir, '.bot/bot.json'), JSON.stringify({ name: slug, mainThreadId: `thread-${slug}`, projectId: `project-${slug}`, primary: slug === 'alpha', createdAt: '2026-01-01T00:00:00Z' }));
    await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { executor: { url: 'https://old-backup.invalid/mcp', headers: { Authorization: 'Bearer stale-backup-token' } }, retained: { command: 'never-executed' } } }));
    await writeFile(path.join(dir, '.codex/config.toml'), '[mcp_servers.executor]\nurl="https://old-backup.invalid/mcp"\n');
  }
  const fakeT3 = await startFakeT3(root);
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = (socket.address() as AddressInfo).port; await new Promise((resolve) => socket.close(resolve));
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined, stdout = '', stderr = '';
  t.after(async () => {
    if (child?.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    await fakeT3.close(); await rm(root, { recursive: true, force: true });
    assert.doesNotMatch(stdout + stderr, /BLOCKED_EXTERNAL_NETWORK/, 'the fixture must never attempt a production request');
  });
  const networkGuard = path.join(root, 'loopback-only.mjs');
  await writeFile(networkGuard, `const original = globalThis.fetch; globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      console.error('BLOCKED_EXTERNAL_NETWORK'); throw new Error('Disposable gateway permits loopback requests only');
    }
    return original(input, init);
  };`);
  child = spawn(process.execPath, ['--import', networkGuard, new URL('./gateway.mts', import.meta.url).pathname], {
    env: { PATH: path.dirname(process.execPath), HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'), HOST: '127.0.0.1', PORT: String(port), BOTS_ROOT: botsRoot,
      T3_URL: `http://127.0.0.1:${fakeT3.port}`, T3_TOKEN: 'fixture-t3-token', BOT_MCP_TOKEN: 'fixture-bot-token', BOT_PASSWORD: PASSWORD,
      VAULT_FILE: path.join(root, 'vault.enc'), VAULT_KEY_FILE: path.join(root, 'vault-key'), T3_SECRETS_DIR: path.join(root, 'secrets'), ...executorEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Disposable gateway failed to start')), 5000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Disposable gateway exited ${code}`)); });
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('bot gateway on')) { clearTimeout(timer); resolve(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie: string | undefined;
  const request = async (route: string, method = 'GET', body?: unknown, authenticated = true) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(authenticated && cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); return { status: response.status, body: value };
  };
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie')!.split(';')[0];
  return { root, botsRoot, request, logs: () => stdout + stderr };
}

test('all Executor gateway routes require app authentication before reaching upstream', async (t) => {
  const upstream = await fakeExecutor(t);
  const app = await gateway(t, { EXECUTOR_URL: upstream.origin, EXECUTOR_PUBLIC_URL: upstream.origin, EXECUTOR_ORG: 'workspace', EXECUTOR_TOKEN: TOKEN });
  for (const [route, method, body] of [
    ['/api/executor', 'GET'], ['/api/executor/catalog', 'GET'], ['/api/executor/install', 'POST', { entry: 'cat_fixture', name: 'Sample' }],
    ['/api/executor/apps/app_fixture', 'GET'], ['/api/executor/apps/app_fixture/accounts', 'POST', { requirement: 'service', scope: 'user', account: 'acct_fixture', linked: true }],
    ['/api/executor/apps/app_fixture/connections', 'POST', { requirement: 'service', scope: 'user' }], ['/api/executor/connections/con_fixture', 'GET'], ['/api/executor/resolve-link', 'POST', { url: `${upstream.origin}/org/workspace/apps` }],
  ] as [route: string, method: string, body?: unknown][]) {
    const response = await app.request(route, method, body, false);
    assert.deepEqual(response, { status: 401, body: { error: 'login required' } });
  }
  // The Executor client never requests `/`; local tools can probe any newly opened port.
  assert.deepEqual(upstream.state.requests.filter((row) => row.path !== '/'), []);
  const status = await app.request('/api/executor');
  assert.equal(status.status, 200); assert.equal(status.body.connections[0].status, 'needs-connection');
});

test('real gateway install, connect, status refresh and links keep account management in-app', async (t) => {
  const upstream = await fakeExecutor(t);
  const app = await gateway(t, { EXECUTOR_URL: upstream.origin, EXECUTOR_PUBLIC_URL: upstream.origin, EXECUTOR_ORG: 'workspace', EXECUTOR_TOKEN: TOKEN });
  const installed = await app.request('/api/executor/install', 'POST', { entry: 'cat_fixture', name: 'Sample' });
  assert.equal(installed.status, 200); assert.equal(installed.body.app.id, 'app_fixture'); assert.equal(installed.body.app.status, 'needs-connection');
  const launch = await app.request('/api/executor/apps/app_fixture/connections', 'POST', { requirement: 'service', scope: 'user' });
  assert.equal(launch.status, 200); assert.equal(launch.body.status, 'pending'); assert.equal(launch.body.backend, 'self-hosted');
  const resolved = await app.request('/api/executor/resolve-link', 'POST', { url: launch.body.url });
  assert.equal(resolved.body.kind, 'connection'); assert.equal(resolved.body.connection.id, 'con_fixture');
  const wrongBackend = await app.request('/api/executor/connections/con_fixture?backend=cloud');
  assert.equal(wrongBackend.status, 409); assert.match(wrongBackend.body.error, /another Executor backend/);
  upstream.state.status = 'completed'; upstream.state.linked = true;
  const completed = await app.request('/api/executor/connections/con_fixture?backend=self-hosted');
  assert.equal(completed.body.status, 'completed');
  assert.equal((await app.request('/api/executor/apps/app_fixture')).body.app.status, 'connected');
  const unlinked = await app.request('/api/executor/apps/app_fixture/accounts', 'POST', { requirement: 'service', scope: 'user', account: 'acct_fixture', linked: false });
  assert.equal(unlinked.body.app.status, 'needs-connection');
  const relinked = await app.request('/api/executor/apps/app_fixture/accounts', 'POST', { requirement: 'service', scope: 'user', account: 'acct_fixture', linked: true });
  assert.equal(relinked.body.app.status, 'connected');
  assert.deepEqual(upstream.state.requests.filter((row) => ['PUT', 'DELETE'].includes(row.method)).map(({ method, body }) => ({ method, body })), [{ method: 'DELETE', body: '' }, { method: 'PUT', body: '' }]);
  upstream.state.unauthorized = true;
  const failed = await app.request('/api/executor/catalog');
  assert.equal(failed.status, 502); assert.equal(failed.body.error, 'Executor rejected the server access token');
  assert.doesNotMatch(JSON.stringify([installed, launch, resolved, completed, unlinked, relinked, failed]), /fake-gateway-executor-token|credentialsFingerprint|never-return-this/);
  assert.doesNotMatch(app.logs(), /fake-gateway-executor-token/);
});

for (const hasCredential of [true, false]) test(`every Bot gets the selected Cloud MCP configuration without stale self-hosted credentials (credential ${hasCredential ? 'present' : 'missing'})`, async (t) => {
  const app = await gateway(t, { EXECUTOR_BACKEND: 'cloud', EXECUTOR_CLOUD_ORG: 'workspace', ...(hasCredential ? { EXECUTOR_CLOUD_TOKEN: TOKEN } : {}),
    EXECUTOR_URL: 'http://127.0.0.1:1', EXECUTOR_PUBLIC_URL: 'https://backup.example', EXECUTOR_ORG: 'backup', EXECUTOR_TOKEN: 'fake-backup-token', EXECUTOR_SKIPPED_APPS: 'gmail' });
  const config = await app.request('/api/config'); assert.equal(config.status, 200);
  assert.equal(config.body.executorUrl, hasCredential ? 'https://app.executor.sh' : null);
  assert.doesNotMatch(JSON.stringify(config.body), /fake-gateway|fake-backup|TOKEN|credential/);
  const read = async (slug: string) => {
    const directory = path.join(app.botsRoot, slug);
    return { json: JSON.parse(await readFile(path.join(directory, '.mcp.json'), 'utf8')), toml: await readFile(path.join(directory, '.codex/config.toml'), 'utf8'), instructions: await readFile(path.join(directory, 'AGENTS.md'), 'utf8'), directory };
  };
  const deadline = Date.now() + 3000;
  let files: Awaited<ReturnType<typeof read>>[] | undefined;
  while (Date.now() < deadline) {
    try { files = await Promise.all(['alpha', 'beta'].map(read)); if (files.every(({ json }) => hasCredential ? json.mcpServers.executor?.url === 'https://mcp.executor.sh/org/workspace/mcp' : !json.mcpServers.executor)) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(files?.length, 2, 'both Bot managed configurations are generated');
  for (const { json: mcp, toml, instructions, directory } of files!) {
    assert.equal(mcp.mcpServers.retained.command, 'never-executed');
    assert.equal(mcp.mcpServers.bot.headers.Authorization, 'Bearer fixture-bot-token');
    if (hasCredential) {
      assert.deepEqual(mcp.mcpServers.executor, { type: 'http', url: 'https://mcp.executor.sh/org/workspace/mcp', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Executor-Organization': 'workspace' } });
      assert.match(toml, /https:\/\/mcp\.executor\.sh\/org\/workspace\/mcp/);
      assert.match(toml, /"X-Executor-Organization" = "workspace"/);
    } else { assert.equal(mcp.mcpServers.executor, undefined); assert.doesNotMatch(toml, /mcp_servers\.executor/); }
    assert.doesNotMatch(JSON.stringify(mcp), /stale-backup-token|fake-backup-token|old-backup\.invalid/);
    assert.doesNotMatch(toml, /fake-backup-token|old-backup\.invalid/);
    assert.equal((await stat(path.join(directory, '.mcp.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(directory, '.codex/config.toml'))).mode & 0o777, 0o600);
    assert.doesNotMatch(instructions, /fake-gateway-executor-token|fake-backup-token/);
  }
});
