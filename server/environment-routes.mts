// Explicit server-side routes. A peer's local token is never sent to another machine.
// T3_ENVIRONMENTS_FILE: { "environment-id": { "baseUrl": "https://...", "tokenFile": "/private/..." } }
// Machines paired in Settings → Machines are written to a second file in the same form; the first
// file that names an environment wins, so the hand-written one overrides.
import { readFile, lstat } from 'node:fs/promises';

/** Where a request goes, and the bearer it carries there. */
export type EnvironmentTarget = { baseUrl: string; token: string };
export type EnvironmentFetch = (url: string, init: RequestInit) => Promise<Response>;

const failure = (message: string, status = 403) => Object.assign(new Error(message), { status });
export function environmentPath(pathname: string): { environmentId: string | null; path: string } {
  const match = /^\/t3\/environments\/([a-zA-Z0-9_-]{1,128})(\/.*)$/.exec(pathname);
  if (pathname.startsWith('/t3/environments/') && !match) throw failure('Invalid environment route', 400);
  return match ? { environmentId: match[1], path: match[2] } : { environmentId: null, path: pathname.slice(3) };
}
async function privateFile(file: string): Promise<string> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw failure('Environment credentials must be private files owned by the gateway user.');
  return readFile(file, 'utf8');
}
export function createEnvironmentRouter<Local = EnvironmentTarget>({ local, file, readPrivate = privateFile, fetcher = fetch }: {
  local?: Local; file?: string | (string | undefined)[]; readPrivate?: (file: string) => Promise<string>; fetcher?: EnvironmentFetch;
})  {
  return async (environmentId: string | null | undefined): Promise<Local | EnvironmentTarget> => {
    // Callers that route local requests pass `local`; the others never ask for it.
    if (!environmentId) return local as Local;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(environmentId)) throw failure('Invalid environment', 400);
    const files = (Array.isArray(file) ? file : [file]).filter((name): name is string => Boolean(name));
    if (!files.length) throw failure('This machine has no scoped gateway access. Configure a credential for this environment.');
    let route = null;
    for (const name of files) {
      let routes;
      try { routes = JSON.parse(await readPrivate(name)); } catch (error) {
        // A routes file that was never written (no paired machines yet) has no routes.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw failure('Scoped environment access is unavailable. Check the gateway credential files.');
      }
      if (routes && typeof routes === 'object' && Object.hasOwn(routes, environmentId)) { route = routes[environmentId]; break; }
    }
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
