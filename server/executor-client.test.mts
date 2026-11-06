import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { appIcon, appSiteDomain, createExecutorClient } from './executor-client.mts';

const TOKEN = 'fake-executor-token-private';
const account = (id) => ({ id, label: id === 'acct_a' ? 'Personal' : 'Work', provider: 'provider', method: 'oauth', credentialsFingerprint: 'private-fingerprint' });
const definitions = {
  app_many: { id: 'app_many', slug: 'many', name: 'Many', requirements: { accounts: { service: { scope: 'user', definition: { name: 'Sample service' }, cardinality: 'many' } } } },
  app_one: { id: 'app_one', slug: 'one', name: 'One', requirements: { accounts: { shared: { scope: 'app', definition: { name: 'Shared service' }, cardinality: 'one' } } } },
  app_ready: { id: 'app_ready', slug: 'ready', name: 'Ready', requirements: { accounts: {} } },
};

async function fixture(t) {
  const state = { apps: structuredClone(definitions), catalog: [{ id: 'cat_sample', name: 'Sample', description: 'Generic service', package: 'sample', auth: [{ method: 'oauth', kind: 'oauth2' }], icons: [{ src: 'javascript:private' }, { src: 'https://example.invalid/icon.svg' }] }, { id: 'cat_executor', name: 'Executor', package: 'executor' }], linked: new Map(), connectionStatus: 'pending', signIn: 'saved', fault: null, requests: [] };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  let origin;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString();
    // T3 Code probes / on every new local port; the client never requests it.
    if (req.url !== '/') state.requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: bodyText });
    if (state.fault === 'unauth') return json(res, 401, { error: TOKEN });
    if (state.fault === 'forbidden') return json(res, 403, { error: TOKEN });
    if (state.fault === 'broken-json') { res.end(`private ${TOKEN}`); return; }
    const url = new URL(req.url, origin), route = url.pathname.replace('/api/organizations/workspace', '');
    if (route === '/catalog') {
      const search = (url.searchParams.get('search') ?? '').toLowerCase();
      const matches = state.catalog.filter((entry) => [entry.id, entry.name, entry.package].some((value) => value?.toLowerCase().includes(search)));
      return json(res, 200, url.searchParams.has('limit') ? matches.slice(0, Number(url.searchParams.get('limit'))) : matches);
    }
    if (route === '/apps/install' && req.method === 'POST') {
      const input = JSON.parse(bodyText); state.apps.app_new = { ...structuredClone(definitions.app_many), id: 'app_new', slug: 'new', name: input.name };
      return json(res, 200, { ...state.apps.app_new, privateSource: TOKEN });
    }
    if (route === '/apps') return json(res, 200, [...Object.values(state.apps), { id: 'builtin', slug: 'executor', name: 'Executor' }]);
    const appRoute = route.match(/^\/apps\/([^/]+)$/);
    if (appRoute) {
      const app = state.apps[appRoute[1]];
      if (!app) return json(res, 404, { error: TOKEN });
      if (state.fault === 'app-identity') return json(res, 200, definitions.app_one);
      if (state.fault === 'requirements') return json(res, 200, { ...app, requirements: { accounts: [] } });
      return json(res, 200, { ...app, privateSource: TOKEN });
    }
    const accounts = route.match(/^\/apps\/([^/]+)\/accounts\/(user|app)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (accounts && !route.endsWith('/connections')) {
      const [, id, scope, requirement, chosen] = accounts;
      const key = `${id}/${scope}/${requirement ?? ''}`;
      if (!requirement) {
        const prefix = `${id}/${scope}/`;
        const rows = [...state.linked].filter(([name]) => name.startsWith(prefix)).flatMap(([name, ids]) => [...ids].map((value) => ({ requirement: name.slice(prefix.length), account: account(value), signIn: { state: state.signIn, reconnectAt: null }, private: TOKEN })));
        return json(res, 200, rows);
      }
      const linked = state.linked.get(key) ?? new Set();
      if (chosen && ['PUT', 'DELETE'].includes(req.method)) {
        if (req.method === 'DELETE') linked.delete(chosen);
        else { if (state.apps[id].requirements.accounts[requirement].cardinality === 'one') linked.clear(); linked.add(chosen); }
        state.linked.set(key, linked);
        return json(res, 200, { requirement, account: req.method === 'DELETE' ? chosen : account(chosen) });
      }
      return json(res, 200, { requirement: state.fault === 'choice-identity' ? 'different' : requirement, scope, cardinality: state.apps[id]?.requirements.accounts[requirement]?.cardinality, accounts: ['acct_a', 'acct_b'].map((value) => ({ account: account(value), linked: linked.has(value) })) });
    }
    const launch = route.match(/^\/apps\/([^/]+)\/accounts\/(user|app)\/([^/]+)\/connections$/);
    const poll = route.match(/^\/connections\/([^/]+)$/);
    if (launch || poll) {
      const id = state.fault === 'connection-identity' ? 'con_other' : 'con_fixture';
      const appId = state.fault === 'target-identity' ? 'app_new' : launch?.[1] ?? 'app_many';
      const target = { app: appId, requirement: launch?.[3] ?? 'service', name: 'Sample service' };
      return json(res, 200, { id, target, state: { status: state.connectionStatus, ...(state.fault === 'connection-failure' ? { failure: { error: TOKEN } } : {}), ...(state.connectionStatus === 'completed' ? { account: account('acct_a') } : {}) }, url: `${origin}/org/workspace/connections/${id}`, expiresAt: '2026-12-01T00:00:00Z', checkable: true, redirectUri: `${origin}/callback`, private: TOKEN });
    }
    json(res, 404, { error: 'Unknown fixture route' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const profile = { kind: 'cloud', organization: 'workspace', apiUrl: origin, publicUrl: origin, mcpUrl: `${origin}/org/workspace/mcp`, credential: { source: 'environment', value: TOKEN } };
  return { state, origin, client: createExecutorClient(profile), profile };
}

test('real HTTP catalog uses scoped bearer, validated icon/auth fields and no management app', async (t) => {
  const { client, state } = await fixture(t);
  assert.deepEqual(await client.catalog('  sample  '), { entries: [{ id: 'cat_sample', name: 'Sample', description: 'Generic service', icon: 'https://example.invalid/icon.svg', auth: ['oauth'] }] });
  assert.deepEqual(state.requests[0], { path: '/api/organizations/workspace/catalog?search=sample', method: 'GET', authorization: `Bearer ${TOKEN}`, body: '' });
});

test('the complete catalog reaches apps beyond forty while preserving public category and sign-in metadata', async (t) => {
  const { client, state } = await fixture(t);
  state.catalog = Array.from({ length: 65 }, (_, index) => ({ id: `catalog-${index + 1}`, package: `package-${index + 1}`, name: `App ${index + 1}`, description: 'Generic provider', category: index === 64 ? 'developer tools' : 'email', auth: [{ method: 'apiKey', kind: 'secrets', label: 'API key' }], icons: [], privateSource: TOKEN }));
  const result = await client.catalog();
  assert.equal(result.entries.length, 65);
  assert.deepEqual(result.entries.at(-1), { id: 'catalog-65', name: 'App 65', description: 'Generic provider', category: 'developer tools', icon: null, auth: ['apiKey'], authLabels: ['API key'] });
  assert.doesNotMatch(JSON.stringify(result), /fake-executor|privateSource|Bearer/);
  assert.deepEqual(state.requests.map(({ path, authorization }) => ({ path, authorization })), [{ path: '/api/organizations/workspace/catalog', authorization: `Bearer ${TOKEN}` }]);
});

test('catalog sign-in alternatives retain their labels and reject credential-bearing icons', async (t) => {
  const { client, state } = await fixture(t);
  state.catalog = [{ id: 'browser', name: 'Browser', package: 'browser', auth: [{ label: 'Invalid option' }, { method: 'apiKey', label: 'API token' }, { method: 'oauth' }], icons: [{ src: `https://user:${TOKEN}@example.invalid/private.svg` }, { src: 'https://example.invalid/public.svg' }] }];
  assert.deepEqual(await client.catalog(), { entries: [{ id: 'browser', name: 'Browser', description: '', icon: 'https://example.invalid/public.svg', auth: ['apiKey', 'oauth'], authLabels: ['API token', ''] }] });
});

test('installed requirements remain disconnected until linked and saved; no-account apps are ready', async (t) => {
  const { client, state } = await fixture(t);
  assert.deepEqual((await client.apps()).map(({ id, status }) => ({ id, status })), [{ id: 'app_many', status: 'needs-connection' }, { id: 'app_one', status: 'needs-connection' }, { id: 'app_ready', status: 'ready' }]);
  const updated = await client.link('app_many', { scope: 'user', requirement: 'service', account: 'acct_a', linked: true });
  assert.equal(updated.app.status, 'connected');
  assert.deepEqual(updated.app.requirements[0].accounts, [{ id: 'acct_a', name: 'Personal', linked: true, signIn: 'saved' }, { id: 'acct_b', name: 'Work', linked: false, signIn: 'saved' }]);
  state.signIn = 'reconnect'; assert.equal((await client.app('app_many')).status, 'needs-connection');
  state.signIn = 'unavailable'; assert.equal((await client.app('app_many')).status, 'needs-connection');
  assert.doesNotMatch(JSON.stringify(updated), /fake-executor|privateSource|credentialsFingerprint/);
});

test('one replaces, many adds, unlink preserves choices and exact PUT/DELETE paths carry no body', async (t) => {
  const { client, state } = await fixture(t);
  const change = (id, scope, requirement, chosen, linked = true) => client.link(id, { scope, requirement, account: chosen, linked });
  await change('app_one', 'app', 'shared', 'acct_a');
  const one = await change('app_one', 'app', 'shared', 'acct_b');
  assert.deepEqual(one.app.requirements[0].accounts.map(({ id, linked }) => ({ id, linked })), [{ id: 'acct_a', linked: false }, { id: 'acct_b', linked: true }]);
  await change('app_many', 'user', 'service', 'acct_a');
  const many = await change('app_many', 'user', 'service', 'acct_b');
  assert.deepEqual(many.app.requirements[0].accounts.map(({ id, linked }) => ({ id, linked })), [{ id: 'acct_a', linked: true }, { id: 'acct_b', linked: true }]);
  const unlinked = await change('app_many', 'user', 'service', 'acct_a', false);
  assert.deepEqual(unlinked.app.requirements[0].accounts.map(({ id, linked }) => ({ id, linked })), [{ id: 'acct_a', linked: false }, { id: 'acct_b', linked: true }]);
  assert.deepEqual(state.requests.filter((entry) => ['PUT', 'DELETE'].includes(entry.method)).map(({ path, method, body }) => ({ path, method, body })), [
    { path: '/api/organizations/workspace/apps/app_one/accounts/app/shared/acct_a', method: 'PUT', body: '' },
    { path: '/api/organizations/workspace/apps/app_one/accounts/app/shared/acct_b', method: 'PUT', body: '' },
    { path: '/api/organizations/workspace/apps/app_many/accounts/user/service/acct_a', method: 'PUT', body: '' },
    { path: '/api/organizations/workspace/apps/app_many/accounts/user/service/acct_b', method: 'PUT', body: '' },
    { path: '/api/organizations/workspace/apps/app_many/accounts/user/service/acct_a', method: 'DELETE', body: '' },
  ]);
});

test('installation returns an in-app account view and starts no connection by itself', async (t) => {
  const { client, state } = await fixture(t);
  const result = await client.install({ entry: 'cat_sample', name: 'New sample' });
  assert.equal(result.app.id, 'app_new'); assert.equal(result.app.name, 'New sample'); assert.equal(result.app.status, 'needs-connection');
  assert.deepEqual(state.requests.filter((entry) => entry.method === 'POST').map(({ path, body }) => ({ path, body })), [{ path: '/api/organizations/workspace/apps/install', body: '{"entry":"cat_sample","name":"New sample"}' }]);
  assert.doesNotMatch(JSON.stringify(result), /fake-executor|privateSource/);
});

test('connection and reconnect use explicit bodies and retain authoritative pending/completed/expired/cancelled state', async (t) => {
  const { client, state, origin } = await fixture(t);
  const pending = await client.connect('app_many', { requirement: 'service', scope: 'user' });
  assert.deepEqual(pending, { id: 'con_fixture', backend: 'cloud', appId: 'app_many', requirement: 'service', scope: 'user', url: `${origin}/org/workspace/connections/con_fixture`, status: 'pending', expiresAt: '2026-12-01T00:00:00Z' });
  await client.connect('app_many', { requirement: 'service', scope: 'user', account: 'acct_b' });
  assert.deepEqual(state.requests.filter((entry) => entry.method === 'POST').map(({ body }) => body), ['{}', '{"account":"acct_b"}']);
  for (const status of ['completed', 'expired', 'cancelled']) { state.connectionStatus = status; assert.equal((await client.connection('con_fixture')).status, status); }
  state.connectionStatus = 'pending'; state.fault = 'connection-failure';
  const failed = await client.connection('con_fixture');
  assert.equal(failed.error, 'The connection could not be completed. Continue sign-in or start a new connection.');
  assert.doesNotMatch(JSON.stringify(failed), /fake-executor|credentialsFingerprint|redirectUri/);
});

test('resolve-link verifies origin and resource identity without fetching caller URLs or crossing organizations', async (t) => {
  const { client, state, origin } = await fixture(t);
  assert.equal((await client.resolveLink(`${origin}/org/workspace/connections/con_fixture`)).connection.id, 'con_fixture');
  assert.equal((await client.resolveLink(`${origin}/org/workspace/apps/app_many?connection=con_fixture&view=accounts`)).kind, 'connection');
  assert.equal((await client.resolveLink(`${origin}/org/workspace/apps/many`)).app.id, 'app_many');
  assert.deepEqual(await client.resolveLink(`${origin}/org/workspace/apps`), { kind: 'apps' });
  const before = state.requests.length;
  for (const url of ['http://example.invalid/org/workspace/apps', `http://user:pass@127.0.0.1:${new URL(origin).port}/`, `${origin}/org/other/apps/many`, `${origin}/unknown`]) await assert.rejects(client.resolveLink(url));
  assert.equal(state.requests.length, before, 'rejected URLs create no upstream request');
  assert.ok(state.requests.every((entry) => entry.path.startsWith('/api/organizations/workspace/')));
});

test('upstream auth and schema failures remain backend errors and never expose echoed secrets', async (t) => {
  const { client, state } = await fixture(t);
  for (const [fault, status] of [['unauth', 502], ['forbidden', 403], ['broken-json', 502]]) {
    state.fault = fault;
    await assert.rejects(client.catalog(), (error) => { assert.equal(error.status, status); assert.doesNotMatch(error.message, /fake-executor|private|Bearer|JSON/); return true; });
  }
  state.fault = 'requirements';
  const apps = await client.apps();
  assert.equal(apps.find((entry) => entry.id === 'app_many').status, 'unknown');
  assert.doesNotMatch(JSON.stringify(apps), /fake-executor|privateSource/);
});

for (const fault of ['app-identity', 'choice-identity', 'connection-identity', 'target-identity']) test(`mismatched ${fault} is rejected rather than retargeted`, async (t) => {
  const { client, state } = await fixture(t);
  if (fault === 'target-identity') await client.install({ entry: 'cat_sample', name: 'New sample' });
  state.fault = fault;
  const operation = fault === 'connection-identity' ? () => client.connection('con_fixture') : fault === 'target-identity' ? () => client.connect('app_many', { requirement: 'service', scope: 'user' }) : () => client.app('app_many');
  await assert.rejects(operation(), (error) => error.status === 502);
});

test('apps carry their own logo and sign-in site, so a card for a custom app can show it', async (t) => {
  const { client, state } = await fixture(t);
  state.apps.app_many.requirements.icons = [{ src: 'javascript:private' }, { src: 'data:image/svg+xml;base64,PHN2Zy8+' }];
  state.apps.app_many.requirements.accounts.service.definition.hosts = ['mcp.example.com'];
  const app = await client.app('app_many');
  assert.equal(app.icon, 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(app.domain, 'example.com');
  const ready = await client.app('app_ready');
  assert.equal('icon' in ready || 'domain' in ready, false);
  assert.equal(appIcon([{ src: 'data:text/html,<script>' }, { src: `https://user:${TOKEN}@example.invalid/a.svg` }]), null);
  assert.equal(appIcon([{ src: `data:image/png;base64,${'A'.repeat(70_000)}` }, { src: 'https://example.invalid/b.png' }]), 'https://example.invalid/b.png');
  assert.equal(appIcon([{ src: 'https://example.invalid/dark.svg', theme: 'dark' }, { src: 'https://example.invalid/light.svg', theme: 'light' }]), 'https://example.invalid/light.svg');
  assert.equal(appSiteDomain({ a: { definition: { hosts: ['localhost', 'api.example.co.uk'] } } }), 'example.co.uk');
  assert.equal(appSiteDomain({ a: { definition: {} } }), null);
});
