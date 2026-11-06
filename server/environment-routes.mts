// Explicit server-side routes. A peer's local token is never sent to another machine.
// T3_ENVIRONMENTS_FILE: { "environment-id": { "baseUrl": "https://...", "tokenFile": "/private/..." } }
import { readFile, lstat } from 'node:fs/promises';

const failure = (message, status = 403) => Object.assign(new Error(message), { status });
export function environmentPath(pathname) {
  const match = /^\/t3\/environments\/([a-zA-Z0-9_-]{1,128})(\/.*)$/.exec(pathname);
  if (pathname.startsWith('/t3/environments/') && !match) throw failure('Invalid environment route', 400);
  return match ? { environmentId: match[1], path: match[2] } : { environmentId: null, path: pathname.slice(3) };
}
async function privateFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw failure('Environment credentials must be private files owned by the gateway user.');
  return readFile(file, 'utf8');
}
export function createEnvironmentRouter({ local, file, readPrivate = privateFile, fetcher = fetch }) {
  return async (environmentId) => {
    if (!environmentId) return local;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(environmentId)) throw failure('Invalid environment', 400);
    if (!file) throw failure('This machine has no scoped gateway access. Configure a credential for this environment.');
    let routes;
    try { routes = JSON.parse(await readPrivate(file)); } catch { throw failure('Scoped environment access is unavailable. Check the gateway credential files.'); }
    const route = Object.hasOwn(routes, environmentId) ? routes[environmentId] : null;
    if (!route) throw failure('This machine has no scoped gateway access. Link or authorize this environment.');
    let base;
    try { base = new URL(route.baseUrl); } catch { throw failure('Invalid configured environment address.'); }
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) throw failure('Environment routes require HTTPS or loopback HTTP origins.');
    let token;
    try { token = (await readPrivate(route.tokenFile)).trim(); } catch { throw failure('This environment credential is unavailable. Authorize the machine again.'); }
    if (!token || /[\r\n]/.test(token)) throw failure('Invalid environment credential.');
    // Prove identity without credentials before forwarding any request or bearer.
    const discovery = await fetcher(base.origin + '/.well-known/t3/environment', { redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(() => null);
    const descriptor = discovery?.ok ? await discovery.json().catch(() => null) : null;
    if (descriptor?.environmentId !== environmentId) throw failure('The configured address did not identify as the requested T3 environment.', 502);
    return { baseUrl: base.origin, token };
  };
}
