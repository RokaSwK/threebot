import { executorCredential } from './executor-config.mjs';
import { createExecutorClient } from './executor-client.mjs';

const VERSIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const TOOL_NAMES = new Set(['skills', 'search', 'describe', 'call', 'execute', 'resume']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export class ExecutorProbeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const failure = (code, message) => new ExecutorProbeError(code, message);
const protocolFailure = () => failure('MCP_PROTOCOL', 'Executor MCP returned an invalid response');

function responseResult(value, id) {
  const messages = Array.isArray(value) ? value : [value];
  for (const message of messages) {
    if (!object(message) || message.id !== id || 'method' in message) continue;
    if (message.jsonrpc !== '2.0' || ('result' in message) === ('error' in message)) throw protocolFailure();
    if ('error' in message) throw failure('MCP_RPC', 'Executor MCP rejected the protocol request');
    return { found: true, value: message.result };
  }
  return { found: false };
}

/** Read only until our JSON-RPC response, not until an SSE connection closes. */
async function readResponse(response, id, maxBytes) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!['application/json', 'text/event-stream'].includes(type) || !response.body) { await response.body?.cancel(); throw protocolFailure(); }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, event = [];
  const parse = (text) => { try { return JSON.parse(text); } catch { throw protocolFailure(); } };
  function lines(final = false) {
    for (;;) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0 || (!final && buffer[index] === '\r' && index === buffer.length - 1)) return { found: false };
      const line = buffer.slice(0, index), length = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(index + length);
      if (!line) {
        if (event.length) { const result = responseResult(parse(event.join('\n')), id); event = []; if (result.found) return result; }
      } else if (line === 'data' || line.startsWith('data:')) event.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (type === 'application/json') { const result = responseResult(parse(buffer), id); if (result.found) return result.value; }
        else { const result = lines(true); if (result.found) return result.value; }
        throw protocolFailure();
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw failure('MCP_LIMIT', 'Executor MCP response exceeded the verification limit');
      buffer += decoder.decode(value, { stream: true });
      if (type === 'text/event-stream') { const result = lines(); if (result.found) return result.value; }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function searchFailed(value) {
  return object(value) && (value.isError === true || value.ok === false || value.error != null || value.approvalUrl != null);
}

/** A dedicated, read-only MCP session. No app tools, approvals or existing sessions are used. */
export async function probeExecutorMcp(profile, { fetch: request = globalThis.fetch, timeoutMs = 20_000, maxResponseBytes = 2 * 1024 * 1024 } = {}) {
  let token;
  try { token = executorCredential(profile); } catch { throw failure('CREDENTIAL', 'Executor server credential is unavailable'); }
  if (!profile || !token) throw failure('CREDENTIAL', 'Executor server credential is unavailable');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 2 * 1024 * 1024) throw failure('OPTIONS', 'Executor verification limits are invalid');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let session, version, nextId = 0, result, error;
  const headers = () => ({ authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    ...(profile.kind === 'cloud' ? { 'X-Executor-Organization': profile.organization } : {}),
    ...(session ? { 'Mcp-Session-Id': session } : {}), ...(version ? { 'MCP-Protocol-Version': version } : {}) });
  async function send(method, params, notification = false) {
    const id = notification ? undefined : ++nextId;
    const response = await request(profile.mcpUrl, { method: 'POST', redirect: 'error', signal: controller.signal, headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw failure('MCP_AUTH', 'Executor MCP authentication was rejected'); }
    if (notification) {
      await response.body?.cancel();
      if (response.status !== 202) throw protocolFailure();
      return;
    }
    if (response.status !== 200) { await response.body?.cancel(); throw failure('MCP_HTTP', 'Executor MCP request failed'); }
    const value = await readResponse(response, id, maxResponseBytes);
    if (method === 'initialize' && object(value)) {
      const assigned = response.headers.get('Mcp-Session-Id');
      if (assigned !== null) {
        if (!/^[\x21-\x7e]{1,4096}$/.test(assigned)) throw protocolFailure();
        session = assigned;
      }
    }
    return value;
  }
  try {
    const initialized = await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bot-gateway-verification', version: '1.0.0' } });
    if (!object(initialized) || !VERSIONS.has(initialized.protocolVersion) || !object(initialized.capabilities?.tools)) throw protocolFailure();
    version = initialized.protocolVersion;
    await send('notifications/initialized', undefined, true);
    const listed = await send('tools/list', {});
    if (!object(listed) || !Array.isArray(listed.tools) || listed.tools.some((tool) => !object(tool) || typeof tool.name !== 'string')) throw protocolFailure();
    const tools = listed.tools.map((tool) => tool.name).filter((name) => TOOL_NAMES.has(name)).sort();
    if (!tools.includes('search')) throw failure('MCP_TOOLS', 'Executor MCP management search is unavailable');
    const searched = await send('tools/call', { name: 'search', arguments: { query: 'executor appManagement list' } });
    if (!object(searched) || !Array.isArray(searched.content) || (searched.isError !== undefined && typeof searched.isError !== 'boolean') || searchFailed(searched) || searchFailed(searched.structuredContent)) throw failure('MCP_SEARCH', 'Executor management search failed');
    for (const item of searched.content) if (item.type === 'text' && typeof item.text === 'string') {
      let payload; try { payload = JSON.parse(item.text); } catch { continue; }
      if (searchFailed(payload)) throw failure('MCP_SEARCH', 'Executor management search failed');
    }
    result = { authenticated: true, protocolVersion: version, tools, searchAccepted: true };
  } catch (caught) {
    error = caught instanceof ExecutorProbeError ? caught : failure(timedOut ? 'MCP_TIMEOUT' : 'MCP_TRANSPORT', timedOut ? 'Executor MCP verification timed out' : 'Executor MCP request failed');
  } finally {
    clearTimeout(timer);
    if (session) {
      try {
        const response = await request(profile.mcpUrl, { method: 'DELETE', redirect: 'error', headers: headers(), signal: AbortSignal.timeout(Math.min(2000, timeoutMs)) });
        await response.body?.cancel();
        if (!response.ok && ![404, 405].includes(response.status)) throw new Error();
      } catch { error ??= failure('MCP_CLEANUP', 'Executor MCP verification session could not be closed'); }
    }
  }
  if (error) throw error;
  return result;
}

/** HTTP account metadata plus the dedicated MCP probe; credentials never enter the report. */
export async function checkExecutor(configuration, { appId, ...options } = {}) {
  const profile = configuration?.profile;
  try { if (!profile || !executorCredential(profile)) throw new Error(); }
  catch { throw failure('CREDENTIAL', 'Executor server credential is unavailable'); }
  let apps;
  try { apps = await createExecutorClient(profile, { fetch: options.fetch ?? globalThis.fetch }).apps(); }
  catch { throw failure('HTTP_VERIFY', 'Executor HTTP verification failed'); }
  const counts = { total: apps.length, ready: 0, connected: 0, needsConnection: 0, unknown: 0 };
  for (const app of apps) counts[app.status === 'needs-connection' ? 'needsConnection' : app.status]++;
  let selected;
  if (appId !== undefined) {
    selected = apps.find((app) => app.id === appId);
    if (!selected) throw failure('APP_UNAVAILABLE', 'Requested Executor app is unavailable');
  }
  const mcp = await probeExecutorMcp(profile, options);
  return { ok: true, backend: configuration.active, organization: profile.organization, http: { authenticated: true, apps: counts }, mcp,
    ...(selected ? { app: { id: selected.id, status: selected.status, linkedSaved: selected.status === 'unknown' ? null : selected.requirements.reduce((sum, requirement) => sum + requirement.accounts.filter((account) => account.linked && account.signIn === 'saved').length, 0) } } : {}) };
}
