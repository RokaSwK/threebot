import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Requirement = { scope: string; cardinality: string; provider: string; definition: { name: string } };
type FixtureApp = { id: string; slug: string; name: string; requirements: { accounts: Record<string, Requirement> }; createdAt: string };
type FixtureAccount = { id: string; provider: string; label: string; method: string; owner: string; createdAt: string };
type FixtureConnection = {
  id: string; owner: string; provider: { id: string; definition: { name: string } }; reconnectAccount: FixtureAccount | null | undefined;
  target: { app: string; requirement: string; name: string }; createdAt: string; expiresAt: string;
  state: { status: string; account?: FixtureAccount }; url: string; redirectUri: string;
};
type FixtureState = {
  apps: Map<string, FixtureApp>; accounts: Map<string, FixtureAccount>; links: Map<string, Set<string>>; connections: Map<string, FixtureConnection>;
  serial: number; installed: number; failures: Set<string>; counts: { installs: number; links: number; launches: number; completions: number };
};

export const EXECUTOR_FIXTURE_TOKEN = 'fixture-only';
export const EXECUTOR_FIXTURE_IDS = { service: 'app_generic_service', single: 'app_generic_single', ready: 'app_generic_ready', catalog: 'catalog_generic_new' };
const stamp = '2026-01-01T12:00:00.000Z';
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const escaped = (value: unknown) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[character]);

/** Scripted account storage only. No OAuth provider, credentials or real Executor. */
export async function startFakeExecutor(port = 0) {
  let origin: string, state: FixtureState;
  const seed = () => {
    const app = (id: string, slug: string, name: string, accounts: Record<string, Requirement>): FixtureApp => ({ id, slug, name, requirements: { accounts }, createdAt: stamp });
    const requirement = (scope: string, cardinality: string, provider = 'provider_generic'): Requirement => ({ scope, cardinality, provider, definition: { name: 'Generic service' } });
    state = { apps: new Map([
      ['app_fixture_executor', app('app_fixture_executor', 'executor', 'Executor', {})],
      [EXECUTOR_FIXTURE_IDS.service, app(EXECUTOR_FIXTURE_IDS.service, 'generic-service', 'Generic Service', { service: requirement('user', 'many') })],
      [EXECUTOR_FIXTURE_IDS.single, app(EXECUTOR_FIXTURE_IDS.single, 'generic-single', 'Generic Single', { service: requirement('app', 'one', 'provider_single') })],
      [EXECUTOR_FIXTURE_IDS.ready, app(EXECUTOR_FIXTURE_IDS.ready, 'generic-ready', 'Generic Ready', {})],
    ]), accounts: new Map([
      ['acct_single_personal', { id: 'acct_single_personal', provider: 'provider_single', label: 'Sample Personal', method: 'fixture', owner: 'fixture', createdAt: stamp }],
      ['acct_single_work', { id: 'acct_single_work', provider: 'provider_single', label: 'Sample Work', method: 'fixture', owner: 'fixture', createdAt: stamp }],
    ]), links: new Map(), connections: new Map(), serial: 0, installed: 0, failures: new Set(), counts: { installs: 0, links: 0, launches: 0, completions: 0 } };
  };
  seed();
  const linkKey = (app: string, scope: string, requirement: string) => `${app}/${scope}/${requirement}`;
  const linkAccount = (app: string, scope: string, requirement: string, id: string) => {
    const key = linkKey(app, scope, requirement);
    const linked = state.links.get(key) ?? new Set();
    if (state.apps.get(app)!.requirements.accounts[requirement].cardinality === 'one') linked.clear();
    linked.add(id); state.links.set(key, linked);
  };
  const publicConnection = (entry: FixtureConnection) => ({ ...entry, checkable: true });
  const changeConnection = (entry: FixtureConnection, action: string) => {
    if (entry.state.status !== 'pending') return;
    if (action === 'complete') {
      const definition = state.apps.get(entry.target.app)!.requirements.accounts[entry.target.requirement];
      const saved = entry.reconnectAccount ?? { id: `acct_generic_${state.accounts.size + 1}`, provider: definition.provider,
        label: `Sample account ${state.accounts.size - 1}`, method: 'fixture', owner: 'fixture', createdAt: stamp };
      state.accounts.set(saved.id, saved);
      linkAccount(entry.target.app, definition.scope, entry.target.requirement, saved.id);
      entry.state = { status: 'completed', account: saved }; state.counts.completions++;
    } else entry.state = { status: action === 'cancel' ? 'cancelled' : 'expired' };
  };
  const readBody = async (req: http.IncomingMessage) => {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > 4096) throw Error('Body too large'); chunks.push(chunk); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin), pathname = url.pathname;
      const page = pathname.match(/^\/org\/fixture\/connections\/(con_[a-zA-Z0-9_-]+)(?:\/(complete|cancel|expire))?$/);
      if (page) {
        const entry = state.connections.get(page[1]);
        if (!entry) return json(res, 404, { error: 'Unknown sample connection' });
        if (req.method === 'POST' && page[2]) {
          changeConnection(entry, page[2]);
          res.writeHead(303, { location: `/org/fixture/connections/${entry.id}` }); res.end(); return;
        }
        if (req.method !== 'GET' || page[2]) return json(res, 405, { error: 'Unsupported fixture action' });
        const pending = entry.state.status === 'pending';
        const controls = pending ? [['complete', 'Finish sample sign-in'], ['cancel', 'Cancel sample connection'], ['expire', 'Expire sample connection']]
          .map(([action, label]) => `<form method="post" action="${pathname}/${action}"><button>${label}</button></form>`).join('') : '<button onclick="window.close()">Return to Bot app</button>';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sample connection</title><style>body{font:16px system-ui;max-width:32rem;margin:3rem auto;padding:1rem}button{font:inherit;padding:.8rem;margin:.4rem 0}form{display:inline-block;margin-right:.5rem}</style><h1>${escaped(entry.target.name)}</h1><p>Disposable local fixture. No provider sign-in or credentials.</p><p role="status">Connection ${entry.state.status}</p>${controls}</html>`); return;
      }
      if (req.headers.authorization !== `Bearer ${EXECUTOR_FIXTURE_TOKEN}`) return json(res, 401, { error: 'Fixture access denied' });
      if (pathname === '/fixture/executor' && req.method === 'GET') return json(res, 200, { fixtureOnly: true, ...state.counts,
        apps: state.apps.size, accounts: state.accounts.size, connections: [...state.connections.values()].map(({ id, state }) => ({ id, status: state.status })) });
      if (pathname === '/fixture/executor/fail-once' && req.method === 'POST') {
        const body = await readBody(req);
        if (!['install', 'link', 'connect', 'status'].includes(body.operation)) return json(res, 400, { error: 'Unknown fixture operation' });
        state.failures.add(body.operation); return json(res, 200, { fixtureOnly: true, armed: true });
      }
      if (!pathname.startsWith('/api/organizations/fixture/')) return json(res, 404, { error: 'Unknown fixture route' });
      const route = pathname.slice('/api/organizations/fixture'.length);
      const operation = route === '/apps/install' ? 'install' : route.endsWith('/connections') && req.method === 'POST' ? 'connect' : ['PUT', 'DELETE'].includes(req.method!) ? 'link' : 'status';
      if (state.failures.delete(operation)) return json(res, 503, { error: 'Sample operation failed once' });
      if (route === '/apps' && req.method === 'GET') return json(res, 200, [...state.apps.values()]);
      if (route === '/catalog' && req.method === 'GET') {
        const entry = { id: EXECUTOR_FIXTURE_IDS.catalog, package: 'generic-fixture', name: 'Generic New', description: 'Disposable generic app', icons: [], auth: [{ method: 'fixture', kind: 'oauth2' }] };
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        return json(res, 200, !search || `${entry.name} ${entry.description}`.toLowerCase().includes(search) ? [entry] : []);
      }
      if (route === '/apps/install' && req.method === 'POST') {
        const input = await readBody(req);
        if (input.entry !== EXECUTOR_FIXTURE_IDS.catalog || typeof input.name !== 'string' || !input.name.trim()) return json(res, 400, { error: 'Invalid sample app' });
        const id = `app_generic_new_${++state.installed}`;
        const installed = { ...structuredClone(state.apps.get(EXECUTOR_FIXTURE_IDS.service)!), id, slug: `generic-new-${state.installed}`, name: input.name };
        state.apps.set(id, installed); state.counts.installs++; return json(res, 200, installed);
      }
      const appRoute = route.match(/^\/apps\/([^/]+)$/);
      if (appRoute && req.method === 'GET') return state.apps.has(appRoute[1]) ? json(res, 200, state.apps.get(appRoute[1])) : json(res, 404, { error: 'Unknown sample app' });
      const poll = route.match(/^\/connections\/(con_[a-zA-Z0-9_-]+)$/);
      if (poll && req.method === 'GET') return state.connections.has(poll[1]) ? json(res, 200, publicConnection(state.connections.get(poll[1])!)) : json(res, 404, { error: 'Unknown sample connection' });
      const accounts = route.match(/^\/apps\/([^/]+)\/accounts\/(user|app)(?:\/([^/]+))?(?:\/([^/]+))?$/);
      if (!accounts) return json(res, 404, { error: 'Unknown fixture route' });
      const [, appId, scope, requirement, chosen] = accounts;
      const app = state.apps.get(appId);
      if (!app) return json(res, 404, { error: 'Unknown sample app' });
      if (!requirement && req.method === 'GET') {
        const rows: { requirement: string; account: FixtureAccount | undefined; createdAt: string; signIn: { state: string; reconnectAt: null } }[] = [];
        for (const [name, definition] of Object.entries(app.requirements.accounts)) {
          if (definition.scope !== scope) continue;
          for (const id of state.links.get(linkKey(appId, scope, name)) ?? []) rows.push({ requirement: name, account: state.accounts.get(id), createdAt: stamp, signIn: { state: 'saved', reconnectAt: null } });
        }
        return json(res, 200, rows);
      }
      const definition = app.requirements.accounts[requirement];
      if (!definition || definition.scope !== scope) return json(res, 404, { error: 'Unknown sample requirement' });
      if (chosen === 'connections' && req.method === 'POST') {
        const input = await readBody(req), previous = input.account ? state.accounts.get(input.account) : null;
        if (input.account && (!previous || previous.provider !== definition.provider)) return json(res, 400, { error: 'Invalid sample account' });
        const id = `con_fixture_${++state.serial}`;
        const entry: FixtureConnection = { id, owner: 'fixture', provider: { id: definition.provider, definition: definition.definition }, reconnectAccount: previous,
          target: { app: appId, requirement, name: app.name }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          state: { status: 'pending' }, url: `${origin}/org/fixture/connections/${id}`, redirectUri: `${origin}/fixture/callback` };
        state.connections.set(id, entry); state.counts.launches++; return json(res, 200, publicConnection(entry));
      }
      const linked = state.links.get(linkKey(appId, scope, requirement)) ?? new Set();
      if (!chosen && req.method === 'GET') return json(res, 200, { requirement, scope, provider: definition.provider, cardinality: definition.cardinality,
        accounts: [...state.accounts.values()].filter((entry) => entry.provider === definition.provider).map((account) => ({ account, linked: linked.has(account.id) })) });
      const selected = state.accounts.get(chosen);
      if (!selected || selected.provider !== definition.provider) return json(res, 404, { error: 'Unknown sample account' });
      if (req.method === 'PUT') { linkAccount(appId, scope, requirement, chosen); state.counts.links++; return json(res, 200, { requirement, account: selected, createdAt: stamp, signIn: { state: 'saved', reconnectAt: null } }); }
      if (req.method === 'DELETE') { linked.delete(chosen); state.counts.links++; return json(res, 200, { requirement, account: chosen }); }
      return json(res, 405, { error: 'Unsupported fixture method' });
    } catch { json(res, 400, { error: 'Invalid fixture request' }); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const reset = () => {
    seed();
    state.connections.set('con_fixture_seed', { id: 'con_fixture_seed', owner: 'fixture', provider: { id: 'provider_generic', definition: { name: 'Generic service' } }, reconnectAccount: null,
      target: { app: EXECUTOR_FIXTURE_IDS.service, requirement: 'service', name: 'Generic Service' }, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), state: { status: 'pending' },
      url: `${origin}/org/fixture/connections/con_fixture_seed`, redirectUri: `${origin}/fixture/callback` });
  };
  reset();
  let closed = false;
  return { origin, get port() { return (server.address() as AddressInfo | null)?.port; }, reset,
    links: { app: `${origin}/org/fixture/apps/${EXECUTOR_FIXTURE_IDS.service}`, connection: `${origin}/org/fixture/connections/con_fixture_seed` },
    async close() { if (closed) return; closed = true; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
