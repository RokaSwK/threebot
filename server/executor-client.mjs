import { executorCredential } from './executor-config.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string' && value.length > 0;
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const segment = (value) => {
  if (!string(value) || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw failure('Invalid Executor identifier', 400);
  return encodeURIComponent(value);
};
function account(value) {
  if (!object(value) || !string(value.id)) throw failure('Executor returned an invalid account');
  return { id: value.id, name: string(value.label) ? value.label : string(value.name) ? value.name : value.id };
}
function requirements(value) {
  if (!object(value)) throw failure('Executor account requirements are unavailable');
  return Object.entries(value).map(([id, item]) => {
    if (!object(item) || !['user', 'app'].includes(item.scope) || !['one', 'many'].includes(item.cardinality)) throw failure('Executor returned invalid account requirements');
    return { id, scope: item.scope, name: string(item.definition?.name) ? item.definition.name : id, cardinality: item.cardinality };
  });
}

const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i;
/** A public logo for the app: a plain web address, or a small inline image Executor stores. */
export function appIcon(icons) {
  if (!Array.isArray(icons)) return null;
  // Logos sit on a white tile, so a dark-theme variant is the last choice.
  for (const item of [...icons].sort((a, b) => Number(a?.theme === 'dark') - Number(b?.theme === 'dark'))) {
    if (!object(item) || !string(item.src)) continue;
    if (IMAGE_DATA.test(item.src)) { if (item.src.length <= 64 * 1024) return item.src; continue; }
    try { const url = new URL(item.src); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* not a logo */ }
  }
  return null;
}
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** The site behind an app's sign-in host, so mcp.example.com shows example.com's logo. */
export function appSiteDomain(accounts) {
  if (!object(accounts)) return null;
  for (const item of Object.values(accounts)) {
    for (const value of Array.isArray(item?.definition?.hosts) ? item.definition.hosts : []) {
      const host = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.$/, '') : '';
      if (!HOST.test(host)) continue;
      const labels = host.split('.');
      // Keep three labels for two-letter country suffixes such as example.co.uk.
      const keep = labels.length > 2 && labels.at(-1).length === 2 && labels.at(-2).length <= 3 ? 3 : 2;
      return labels.slice(-keep).join('.');
    }
  }
  return null;
}

async function concurrent(items, transform) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await transform(items[index]); }
  }));
  return result;
}

/** The same REST contract is hosted and self-hosted; identity and secrets stay separate. */
export function createExecutorClient(profile, { fetch: request = globalThis.fetch } = {}) {
  if (!profile) throw failure('Executor is not configured', 503);
  const base = `${profile.apiUrl}/api/organizations/${segment(profile.organization)}`;
  async function api(path, init = {}) {
    const token = executorCredential(profile);
    if (!token) throw failure('Executor needs a server access token', 503);
    let response;
    try {
      response = await request(base + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    } catch { throw failure('Executor is not reachable right now'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw failure('Executor rejected the server access token');
      if (response.status === 403) throw failure('Executor does not permit this operation', 403);
      if (response.status === 404) throw failure('This Executor app or connection is unavailable', 404);
      throw failure('Executor could not complete this request');
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw failure('Executor returned an invalid response'); }
  }
  const appPath = (id) => `/apps/${segment(id)}`;
  async function app(id) {
    const raw = await api(appPath(id));
    if (!object(raw) || raw.id !== id || !string(raw.slug) || !string(raw.name)) throw failure('Executor returned an invalid app');
    const definitions = requirements(raw.requirements?.accounts);
    const scopes = [...new Set(definitions.map((item) => item.scope))];
    const links = new Map(await concurrent(scopes, async (scope) => {
      const rows = await api(`${appPath(raw.id)}/accounts/${scope}`);
      if (!Array.isArray(rows) || rows.some((row) => !object(row) || !string(row.requirement) || !object(row.account) || !string(row.account.id))) throw failure('Executor account links are unavailable');
      return [scope, rows];
    }));
    const choices = await concurrent(definitions, async (definition) => {
      const rawChoices = await api(`${appPath(raw.id)}/accounts/${definition.scope}/${segment(definition.id)}`);
      if (!object(rawChoices) || rawChoices.requirement !== definition.id || rawChoices.scope !== definition.scope ||
          rawChoices.cardinality !== definition.cardinality || !Array.isArray(rawChoices.accounts)) throw failure('Executor account choices are unavailable');
      const accounts = rawChoices.accounts.map((choice) => {
        if (!object(choice) || typeof choice.linked !== 'boolean') throw failure('Executor returned invalid account choices');
        const info = account(choice.account);
        const link = links.get(definition.scope).find((row) => row.requirement === definition.id && row.account?.id === info.id);
        const state = link?.signIn?.state;
        return { ...info, linked: choice.linked, signIn: choice.linked ? (['saved', 'reconnect', 'unavailable'].includes(state) ? state : 'unavailable') : 'saved' };
      });
      return { ...definition, accounts };
    });
    const connected = choices.every((requirement) => {
      const linked = requirement.accounts.filter((entry) => entry.linked && entry.signIn === 'saved');
      return requirement.cardinality === 'one' ? linked.length === 1 : linked.length > 0;
    });
    const icon = appIcon(raw.requirements?.icons), domain = appSiteDomain(raw.requirements?.accounts);
    return { id: raw.id, slug: raw.slug, name: raw.name, requirements: choices, status: choices.length ? (connected ? 'connected' : 'needs-connection') : 'ready',
      ...(icon ? { icon } : {}), ...(domain ? { domain } : {}) };
  }
  async function apps() {
    const rows = await api('/apps');
    if (!Array.isArray(rows)) throw failure('Executor app list is unavailable');
    return concurrent(rows.filter((entry) => object(entry) && !['executor', 'executor-admin'].includes(entry.slug)), async (entry) => {
      if (!string(entry.id) || !string(entry.slug) || !string(entry.name)) throw failure('Executor returned an invalid app');
      try { return await app(entry.id); }
      catch (error) { return { id: entry.id, slug: entry.slug, name: entry.name, requirements: [], status: 'unknown', error: error.message }; }
    });
  }
  async function catalog(search = '') {
    // Executor returns every match when limit is omitted. The UI downloads once and
    // filters/pages locally, so a provider never disappears behind an upstream cap.
    const query = new URLSearchParams();
    if (typeof search === 'string' && search.trim()) query.set('search', search.trim().slice(0, 100));
    const entries = await api(`/catalog${query.size ? `?${query}` : ''}`);
    if (!Array.isArray(entries)) throw failure('Executor catalog is unavailable');
    return { entries: entries.filter((entry) => object(entry) && entry.package !== 'executor').map((entry) => {
      if (!string(entry.id) || !string(entry.name)) throw failure('Executor returned an invalid catalog entry');
      const icon = Array.isArray(entry.icons) ? entry.icons.find((item) => {
        if (!object(item) || !string(item.src)) return false;
        try { const url = new URL(item.src); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
      }) : null;
      const auth = Array.isArray(entry.auth) ? entry.auth.filter((item) => object(item) && string(item.method)) : [];
      // Keep positions aligned with methods: an unlabeled OAuth option must not
      // disappear beside a labeled API-key option.
      const authLabels = auth.map((item) => typeof item.label === 'string' ? item.label.trim() : '');
      return { id: entry.id, name: entry.name, description: typeof entry.description === 'string' ? entry.description : '', icon: icon?.src ?? null,
        auth: auth.map((item) => item.method).filter(string),
        ...(typeof entry.category === 'string' && entry.category.trim() ? { category: entry.category.trim() } : {}),
        ...(authLabels.some(string) ? { authLabels } : {}) };
    }) };
  }
  async function install(input) {
    if (!object(input) || !string(input.entry) || !string(input.name) || input.entry.length > 512 || input.name.length > 80) throw failure('App entry and name are required', 400);
    const result = await api('/apps/install', { method: 'POST', body: JSON.stringify({ entry: input.entry, name: input.name }) });
    if (!object(result) || !string(result.id)) throw failure('Executor did not return the installed app');
    return { app: await app(result.id) };
  }
  async function requirement(appId, input) {
    if (!object(input)) throw failure('An account requirement is required', 400);
    const selected = await app(appId);
    const found = selected.requirements.find((entry) => entry.id === input.requirement && entry.scope === input.scope);
    if (!found) throw failure('The app account requirement changed; refresh the app', 409);
    return found;
  }
  async function link(appId, input) {
    const selected = await requirement(appId, input);
    if (!string(input.account) || typeof input.linked !== 'boolean') throw failure('An account and link choice are required', 400);
    await api(`${appPath(appId)}/accounts/${selected.scope}/${segment(selected.id)}/${segment(input.account)}`, { method: input.linked ? 'PUT' : 'DELETE' });
    return { app: await app(appId) };
  }
  async function normalizeConnection(raw, expected = {}) {
    if (!object(raw) || !string(raw.id) || !object(raw.target) || !object(raw.state) ||
        !['pending', 'completed', 'expired', 'cancelled'].includes(raw.state.status) || !string(raw.url) || !string(raw.expiresAt)) throw failure('Executor returned an invalid connection');
    const appId = typeof raw.target.app === 'string' ? raw.target.app : raw.target.app?.id;
    if ((expected.id && raw.id !== expected.id) || (expected.appId && appId !== expected.appId) ||
        (expected.requirement && raw.target.requirement !== expected.requirement)) throw failure('Executor returned a different connection target');
    const selected = await app(appId);
    const selectedRequirement = selected.requirements.find((entry) => entry.id === raw.target.requirement);
    if (!selectedRequirement || (expected.scope && expected.scope !== selectedRequirement.scope)) throw failure('The connection account requirement changed', 409);
    let url;
    try { url = new URL(raw.url); } catch { throw failure('Executor returned an invalid sign-in URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== new URL(profile.publicUrl).origin) throw failure('Executor returned an invalid sign-in URL');
    return { id: raw.id, backend: profile.kind, appId, requirement: selectedRequirement.id, scope: selectedRequirement.scope,
      url: url.href, status: raw.state.status, expiresAt: raw.expiresAt,
      ...(raw.state.failure ? { error: 'The connection could not be completed. Continue sign-in or start a new connection.' } : {}) };
  }
  async function connection(id) { return normalizeConnection(await api(`/connections/${segment(id)}`), { id }); }
  async function connect(appId, input) {
    const selected = await requirement(appId, input);
    const body = {};
    if (input.account !== undefined) { segment(input.account); body.account = input.account; }
    const result = await api(`${appPath(appId)}/accounts/${selected.scope}/${segment(selected.id)}/connections`, { method: 'POST', body: JSON.stringify(body) });
    return normalizeConnection(result, { appId, requirement: selected.id, scope: selected.scope });
  }
  async function resolveLink(href) {
    let url;
    try { url = new URL(href); } catch { throw failure('Invalid Executor link', 400); }
    if (url.username || url.password || url.origin !== new URL(profile.publicUrl).origin) throw failure('This link belongs to another service', 400);
    const pieces = url.pathname.split('/').filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { throw failure('Invalid Executor link', 400); } });
    const connectionId = [...pieces, ...url.searchParams.values()].find((part) => /^con_[a-zA-Z0-9_-]+$/.test(part));
    if (connectionId) return { kind: 'connection', connection: await connection(connectionId) };
    const orgIndex = pieces.indexOf('org');
    if (orgIndex >= 0 && pieces[orgIndex + 1] !== profile.organization) throw failure('This link belongs to another Executor organization', 409);
    const index = pieces.indexOf('apps');
    if (index >= 0 && pieces[index + 1]) {
      const rows = await api('/apps');
      const found = Array.isArray(rows) && rows.find((entry) => entry.id === pieces[index + 1] || entry.slug === pieces[index + 1]);
      if (!found) throw failure('This Executor app is unavailable', 404);
      return { kind: 'app', app: await app(found.id) };
    }
    if (url.pathname === '/' || index >= 0) return { kind: 'apps' };
    throw failure('This Executor link cannot be opened here', 400);
  }
  return { apps, app, catalog, install, link, connect, connection, resolveLink };
}
