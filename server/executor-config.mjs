import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

const text = (value) => typeof value === 'string' ? value.trim() : '';

function address(value, label, { cloud = false, query = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${label}`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || (!query && url.search) ||
      (cloud && url.protocol !== 'https:')) throw new Error(`Invalid ${label}`);
  return url.href.replace(/\/$/, '');
}

function credential(env, tokenName, fileName) {
  const value = text(env[tokenName]), file = text(env[fileName]);
  if (value && file) throw new Error(`Set only one of ${tokenName} and ${fileName}`);
  return file ? { source: 'file', path: file } : value ? { source: 'environment', value } : null;
}

/** Keep both profiles. Selecting Cloud never turns a failed call into a backup call. */
export function executorConfiguration(env = process.env) {
  const active = text(env.EXECUTOR_BACKEND) || 'self-hosted';
  if (!['cloud', 'self-hosted'].includes(active)) throw new Error('Invalid EXECUTOR_BACKEND');
  const legacyUrl = text(env.EXECUTOR_URL);
  const legacyOrg = text(env.EXECUTOR_ORG);
  const selfHosted = legacyUrl ? {
    kind: 'self-hosted',
    organization: legacyOrg || 'executor',
    apiUrl: address(legacyUrl, 'self-hosted Executor API URL'),
    publicUrl: address(text(env.EXECUTOR_PUBLIC_URL) || legacyUrl, 'self-hosted Executor public URL'),
    mcpUrl: address(text(env.EXECUTOR_MCP_URL) || `${legacyUrl.replace(/\/$/, '')}${legacyOrg ? `/org/${encodeURIComponent(legacyOrg)}` : ''}/mcp`, 'self-hosted Executor MCP URL', { query: true }),
    credential: credential(env, 'EXECUTOR_TOKEN', 'EXECUTOR_TOKEN_FILE'),
  } : null;
  const organization = text(env.EXECUTOR_CLOUD_ORG);
  if (organization.length > 256 || /[\u0000-\u001f]/.test(organization)) throw new Error('Invalid EXECUTOR_CLOUD_ORG');
  if (active === 'cloud' && !organization) throw new Error('EXECUTOR_CLOUD_ORG is required for Cloud');
  const cloud = organization ? {
    kind: 'cloud', organization,
    apiUrl: address(text(env.EXECUTOR_CLOUD_API_URL) || 'https://app.executor.sh', 'Executor Cloud API URL', { cloud: true }),
    publicUrl: address(text(env.EXECUTOR_CLOUD_PUBLIC_URL) || 'https://app.executor.sh', 'Executor Cloud public URL', { cloud: true }),
    mcpUrl: address(text(env.EXECUTOR_CLOUD_MCP_URL) || `https://mcp.executor.sh/org/${encodeURIComponent(organization)}/mcp`, 'Executor Cloud MCP URL', { cloud: true, query: true }),
    credential: credential(env, 'EXECUTOR_CLOUD_TOKEN', 'EXECUTOR_CLOUD_TOKEN_FILE'),
    skippedApps: text(env.EXECUTOR_SKIPPED_APPS).split(',').map((name) => name.trim()).filter(Boolean),
  } : null;
  if (cloud) {
    const endpoint = new URL(cloud.mcpUrl);
    const route = endpoint.pathname.match(/^\/org\/([^/]+)\/mcp$/);
    if (route && decodeURIComponent(route[1]) !== organization) throw new Error('Executor Cloud MCP organization does not match EXECUTOR_CLOUD_ORG');
    if (!route && endpoint.pathname !== '/mcp') throw new Error('Invalid Executor Cloud MCP route');
  }
  return { active, profile: active === 'cloud' ? cloud : selfHosted, profiles: { cloud, 'self-hosted': selfHosted } };
}

export function executorMcpDefinition(profile) {
  const value = executorCredential(profile);
  if (!profile || !value) return null;
  return { type: 'http', url: profile.mcpUrl, headers: {
    Authorization: `Bearer ${value}`,
    ...(profile.kind === 'cloud' ? { 'X-Executor-Organization': profile.organization } : {}),
  } };
}

/** Materialize only the selected credential, keeping an unusable backup harmless. */
export function executorCredential(profile) {
  if (!profile?.credential) return '';
  if (profile.credential.source === 'environment') return profile.credential.value;
  let descriptor;
  try {
    descriptor = openSync(profile.credential.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16_384) throw new Error();
    const value = readFileSync(descriptor, 'utf8').trim();
    if (!value) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error('Executor credential is unavailable or its file is not private'), { code: 'ExecutorCredentialUnavailable', status: 503 });
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** The app receives availability and public identity, never token values or paths. */
export function publicExecutorConfiguration(configuration) {
  const profile = configuration.profile;
  const backup = configuration.active === 'cloud' ? configuration.profiles['self-hosted'] : configuration.profiles.cloud;
  return {
    backend: configuration.active,
    configured: Boolean(profile),
    url: profile?.publicUrl ?? null,
    organization: profile?.organization ?? null,
    hasToken: Boolean(profile?.credential),
    backupAvailable: Boolean(backup?.credential),
  };
}
