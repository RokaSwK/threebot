import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkExecutor, ExecutorProbeError, probeExecutorMcp } from './executor-probe.mts';

const TOKEN = 'fake-private-probe-token';
const SESSION = 'probe-own-session';
const CLI = new URL('../scripts/executor-check.mts', import.meta.url).pathname;
const json = (res, value, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };

async function fixture(t, options = {}) {
  const state = { requests: [], closed: [], searched: 0, failAt: options.failAt, fault: options.fault };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : null;
    const url = new URL(req.url, 'http://fixture.invalid');
    // The probe never requests `/`; local tools can probe any newly opened port.
    if (req.url !== '/') state.requests.push({ path: req.url, method: req.method, headers: req.headers, body });
    if (!url.pathname.endsWith('/mcp')) {
      if (options.httpAuthFailure) return json(res, { error: TOKEN }, 401);
      const root = '/api/organizations/workspace';
      if (url.pathname === `${root}/apps`) return json(res, [{ id: 'app_sample', slug: 'sample', name: 'Private app label' }]);
      if (url.pathname === `${root}/apps/app_sample`) return json(res, { id: 'app_sample', slug: 'sample', name: 'Private app label', requirements: { accounts: { service: { scope: 'user', definition: { name: 'Private provider' }, cardinality: 'many' } } } });
      if (url.pathname === `${root}/apps/app_sample/accounts/user`) return json(res, options.linked ? [{ requirement: 'service', account: { id: 'acct_sample', label: 'Private account name' }, signIn: { state: 'saved' } }] : []);
      if (url.pathname === `${root}/apps/app_sample/accounts/user/service`) return json(res, { requirement: 'service', scope: 'user', cardinality: 'many', accounts: [{ account: { id: 'acct_sample', label: 'Private account name' }, linked: Boolean(options.linked) }] });
      return json(res, { error: TOKEN }, 404);
    }
    if (req.method === 'DELETE') return json(res, { private: TOKEN }, options.cleanupStatus ?? 200);
    if (body.method === 'notifications/initialized') return json(res, { private: TOKEN }, options.notificationStatus ?? 202);
    if (state.failAt === body.method && state.fault === 'auth') return json(res, { private: TOKEN }, options.authStatus ?? 401);
    if (state.failAt === body.method && state.fault === 'redirect') { res.writeHead(302, { location: '/redirect-capture' }); res.end(TOKEN); return; }
    if (state.failAt === body.method && state.fault === 'hang') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return; }
    let result;
    if (body.method === 'initialize') result = { protocolVersion: options.version ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: '雪 fixture', version: '1', private: TOKEN } };
    else if (body.method === 'tools/list') result = { tools: (options.noSearch ? ['skills', 'call'] : ['skills', 'search', 'describe', 'call', 'execute', 'resume']).map((name) => ({ name, description: TOKEN, inputSchema: { type: 'object' } })) };
    else if (body.method === 'tools/call') {
      state.searched++;
      result = { content: [{ type: 'text', text: JSON.stringify({ tools: [{ path: 'tools.executor.appManagement.list', description: '雪 ' + TOKEN }] }) }], structuredContent: { private: TOKEN } };
    } else return json(res, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: TOKEN } });
    if (state.failAt === body.method && state.fault === 'isError') result = { content: [{ type: 'text', text: TOKEN }], isError: true };
    if (state.failAt === body.method && state.fault === 'wrapped-error') result = { content: [{ type: 'text', text: JSON.stringify({ error: TOKEN }) }] };
    if (state.failAt === body.method && state.fault === 'structured-error') result = { content: [], structuredContent: { ok: false, error: TOKEN } };
    const id = state.failAt === body.method && state.fault === 'wrong-id' ? body.id + 100 : body.id;
    const message = state.failAt === body.method && state.fault === 'rpc-error' ? { jsonrpc: '2.0', id, error: { code: -32000, message: TOKEN } } : { jsonrpc: '2.0', id, result };
    const headers = body.method === 'initialize' && options.session !== false ? { 'Mcp-Session-Id': options.sessionId ?? SESSION } : {};
    if (state.failAt === body.method && state.fault === 'bad-type') { res.writeHead(200, { 'content-type': 'text/plain', ...headers }); res.end(TOKEN); return; }
    if (state.failAt === body.method && state.fault === 'bad-json') { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end('{private ' + TOKEN); return; }
    if (state.failAt === body.method && state.fault === 'oversized') { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { data: 'x'.repeat(5000) } })); return; }
    if (options.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', ...headers });
      const unrelated = { jsonrpc: '2.0', method: 'notifications/message', params: { data: '雪 ' + TOKEN } };
      const wrong = { jsonrpc: '2.0', id: body.id + 200, result: { private: TOKEN } };
      const bytes = Buffer.from(`: comment\r\nevent: message\r\ndata: ${JSON.stringify(unrelated)}\r\n\r\ndata: ${JSON.stringify(wrong)}\n\ndata: ${JSON.stringify(message)}\r\n\r\n`);
      res.on('close', () => state.closed.push(body.method));
      // One-byte chunks force the transport to retain split UTF-8 and CRLF.
      for (const byte of bytes) { if (res.destroyed) break; res.write(Buffer.from([byte])); await new Promise(setImmediate); }
      return; // Deliberately do not end: the client must stop at its matching reply.
    }
    if (options.batch) return json(res, [{ jsonrpc: '2.0', method: 'notifications/message', params: {} }, message], 200, headers);
    json(res, message, 200, headers);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const profile = { kind: 'cloud', organization: 'workspace', apiUrl: origin, publicUrl: origin, mcpUrl: `${origin}/org/workspace/mcp?elicitation_mode=model`, credential: { source: 'environment', value: TOKEN } };
  return { state, origin, profile, configuration: { active: 'cloud', profile, profiles: { cloud: profile, 'self-hosted': { apiUrl: 'http://127.0.0.1:1' } } } };
}

const sanitized = (value) => assert.doesNotMatch(JSON.stringify(value), /fake-private-probe-token|probe-own-session|Private app|Private account|private-fingerprint|serverInfo|description|redirectUri/);
const rejects = async (operation, code) => assert.rejects(operation, (error) => { assert.ok(error instanceof ExecutorProbeError); if (code) assert.equal(error.code, code); sanitized(error.message); return true; });

test('read-only HTTP and JSON MCP verification reports only counts, selected app state and fixed tool names', async (t) => {
  const { state, configuration } = await fixture(t, { linked: true });
  const report = await checkExecutor(configuration, { appId: 'app_sample' });
  assert.deepEqual(report, { ok: true, backend: 'cloud', organization: 'workspace', http: { authenticated: true, apps: { total: 1, ready: 0, connected: 1, needsConnection: 0, unknown: 0 } }, mcp: { authenticated: true, protocolVersion: '2025-03-26', tools: ['call', 'describe', 'execute', 'resume', 'search', 'skills'], searchAccepted: true }, app: { id: 'app_sample', status: 'connected', linkedSaved: 1 } });
  sanitized(report);
  const rpc = state.requests.filter((entry) => entry.path.includes('/mcp'));
  assert.deepEqual(rpc.map((entry) => [entry.method, entry.body?.method]), [['POST', 'initialize'], ['POST', 'notifications/initialized'], ['POST', 'tools/list'], ['POST', 'tools/call'], ['DELETE', undefined]]);
  assert.deepEqual(rpc[0].body, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bot-gateway-verification', version: '1.0.0' } } });
  assert.deepEqual(rpc[3].body.params, { name: 'search', arguments: { query: 'executor appManagement list' } });
  assert.ok(rpc.every((entry) => entry.path === '/org/workspace/mcp?elicitation_mode=model' && entry.headers.authorization === `Bearer ${TOKEN}` && entry.headers['x-executor-organization'] === 'workspace' && entry.headers.accept === 'application/json, text/event-stream'));
  assert.equal(rpc[0].headers['mcp-session-id'], undefined); assert.equal(rpc[0].headers['mcp-protocol-version'], undefined);
  assert.ok(rpc.slice(1).every((entry) => entry.headers['mcp-session-id'] === SESSION && entry.headers['mcp-protocol-version'] === '2025-03-26'));
  assert.equal(state.searched, 1);
});

test('chunked UTF-8 SSE ignores notifications/wrong IDs and cancels open streams after matching replies', { timeout: 4000 }, async (t) => {
  const { profile, state } = await fixture(t, { sse: true });
  const report = await probeExecutorMcp(profile, { timeoutMs: 1500 });
  assert.equal(report.searchAccepted, true); assert.equal(state.searched, 1);
  assert.deepEqual(state.requests.filter((entry) => entry.method === 'DELETE').map((entry) => entry.headers['mcp-session-id']), [SESSION]);
  assert.deepEqual(state.closed.sort(), ['initialize', 'tools/call', 'tools/list']);
  sanitized(report);
});

test('batched JSON responses are correlated and stateless sessions are not deleted', async (t) => {
  const { profile, state } = await fixture(t, { batch: true, session: false });
  assert.equal((await probeExecutorMcp(profile)).searchAccepted, true);
  assert.equal(state.requests.filter((entry) => entry.method === 'DELETE').length, 0);
});

for (const version of ['2025-06-18', '2025-11-25']) test(`negotiated supported protocol ${version} is sent on every subsequent request`, async (t) => {
  const { profile, state } = await fixture(t, { version });
  assert.equal((await probeExecutorMcp(profile)).protocolVersion, version);
  assert.ok(state.requests.slice(1).every((entry) => entry.headers['mcp-protocol-version'] === version));
});

for (const [fault, code] of [['wrong-id', 'MCP_PROTOCOL'], ['rpc-error', 'MCP_RPC'], ['isError', 'MCP_SEARCH'], ['wrapped-error', 'MCP_SEARCH'], ['structured-error', 'MCP_SEARCH'], ['bad-type', 'MCP_PROTOCOL'], ['bad-json', 'MCP_PROTOCOL'], ['redirect', 'MCP_TRANSPORT']]) test(`MCP ${fault} fails without disclosing server content and closes only its own session`, async (t) => {
  const { profile, state } = await fixture(t, { failAt: 'tools/call', fault });
  await rejects(probeExecutorMcp(profile), code);
  assert.deepEqual(state.requests.filter((entry) => entry.method === 'DELETE').map((entry) => entry.headers['mcp-session-id']), [SESSION]);
  assert.equal(state.requests.filter((entry) => entry.path === '/redirect-capture').length, 0);
});

for (const authStatus of [401, 403]) test(`MCP HTTP ${authStatus} rejects without trying the self-hosted backup`, async (t) => {
  const { configuration, state } = await fixture(t, { failAt: 'initialize', fault: 'auth', authStatus });
  await rejects(checkExecutor(configuration), 'MCP_AUTH');
  assert.equal(state.requests.filter((entry) => entry.method === 'DELETE').length, 0, 'failed initialization owns no session');
});

test('HTTP authentication rejection stops before MCP and reports no response body', async (t) => {
  const { configuration, state } = await fixture(t, { httpAuthFailure: true });
  await rejects(checkExecutor(configuration), 'HTTP_VERIFY');
  assert.equal(state.requests.length, 1); assert.match(state.requests[0].path, /\/apps$/);
});

test('unsupported protocol, wrong initialize ID and invalid session IDs never become success', async (t) => {
  const unsupported = await fixture(t, { version: '2099-01-01' });
  await rejects(probeExecutorMcp(unsupported.profile), 'MCP_PROTOCOL');
  assert.equal(unsupported.state.requests.filter((entry) => entry.method === 'DELETE').length, 1);
  const wrong = await fixture(t, { failAt: 'initialize', fault: 'wrong-id' });
  await rejects(probeExecutorMcp(wrong.profile), 'MCP_PROTOCOL');
  assert.equal(wrong.state.requests.filter((entry) => entry.method === 'DELETE').length, 0);
  const invalid = await fixture(t, { sessionId: 'invalid session' });
  await rejects(probeExecutorMcp(invalid.profile), 'MCP_PROTOCOL');
  assert.equal(invalid.state.requests.filter((entry) => entry.method === 'DELETE').length, 0);
});

test('initialized notification must be acknowledged and management search must be listed', async (t) => {
  const bad = await fixture(t, { notificationStatus: 200 }); await rejects(probeExecutorMcp(bad.profile), 'MCP_PROTOCOL');
  assert.equal(bad.state.requests.some((entry) => entry.body?.method === 'tools/list'), false);
  const missing = await fixture(t, { noSearch: true }); await rejects(probeExecutorMcp(missing.profile), 'MCP_TOOLS');
  assert.equal(missing.state.searched, 0);
});

test('stalled and oversized responses are bounded and still close the dedicated session', async (t) => {
  const stalled = await fixture(t, { failAt: 'tools/list', fault: 'hang' });
  await rejects(probeExecutorMcp(stalled.profile, { timeoutMs: 100 }), 'MCP_TIMEOUT');
  assert.equal(stalled.state.requests.filter((entry) => entry.method === 'DELETE').length, 1);
  const big = await fixture(t, { failAt: 'tools/list', fault: 'oversized' });
  await rejects(probeExecutorMcp(big.profile, { maxResponseBytes: 1024 }), 'MCP_LIMIT');
  assert.equal(big.state.requests.filter((entry) => entry.method === 'DELETE').length, 1);
});

test('cleanup405 is acceptable but an actual cleanup failure is not hidden', async (t) => {
  const absent = await fixture(t, { cleanupStatus: 405 }); assert.equal((await probeExecutorMcp(absent.profile)).searchAccepted, true);
  const denied = await fixture(t, { cleanupStatus: 500 }); await rejects(probeExecutorMcp(denied.profile), 'MCP_CLEANUP');
});

test('missing and unavailable credentials fail before any network request', async () => {
  let calls = 0; const network = async () => { calls++; throw Error(TOKEN); };
  await rejects(probeExecutorMcp(null, { fetch: network }), 'CREDENTIAL');
  await rejects(checkExecutor({ active: 'cloud', profile: { kind: 'cloud', credential: null } }, { fetch: network }), 'CREDENTIAL');
  await rejects(probeExecutorMcp({ credential: { source: 'file', path: '/missing/private/credential' } }, { fetch: network }), 'CREDENTIAL');
  assert.equal(calls, 0);
});

function cli(env, args = []) {
  return new Promise((resolve) => execFile(process.execPath, [CLI, ...args], { env: { PATH: path.dirname(process.execPath), ...env }, timeout: 5000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
}

test('CLI reads a private file, reports only selected-app counts and accepts no token arguments', async (t) => {
  const { origin, state } = await fixture(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'executor-check-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'token'); await writeFile(file, TOKEN, { mode: 0o600 });
  const env = { EXECUTOR_URL: origin, EXECUTOR_PUBLIC_URL: origin, EXECUTOR_ORG: 'workspace', EXECUTOR_TOKEN_FILE: file, EXECUTOR_MCP_URL: `${origin}/org/workspace/mcp?elicitation_mode=model` };
  const result = await cli(env, ['--app', 'app_sample']);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout); assert.equal(report.backend, 'self-hosted'); assert.deepEqual(report.app, { id: 'app_sample', status: 'needs-connection', linkedSaved: 0 }); sanitized(report); assert.doesNotMatch(result.stdout, /executor-check-/);
  assert.equal(state.requests.some((entry) => entry.body?.method === 'tools/call'), true);
  const rejected = await cli(env, ['--token', TOKEN]); assert.equal(rejected.code, 1); sanitized(rejected.stderr); assert.equal(rejected.stdout, '');
  const missing = await cli({ EXECUTOR_BACKEND: 'cloud', EXECUTOR_CLOUD_ORG: 'workspace' }); assert.equal(missing.code, 1); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /credential is unavailable/);
});
