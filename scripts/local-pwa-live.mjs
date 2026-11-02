#!/usr/bin/env node
// Explicit local frontend over an authenticated, SSH-forwarded existing gateway.
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localPwaDiagnosticsPlugin } from './local-pwa-diagnostics.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const web = path.join(repo, 'web');
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const credentialError = () => new Error('Live credentials are unavailable. Use a private regular token file outside the project and build directory.');
const authenticationError = () => new Error('Live gateway authentication failed. Check the SSH forward and refresh the application token.');
const CF_HEADER = 'cf-access-jwt-assertion';
const PRIVATE_HEADERS = ['authorization', 'cookie', CF_HEADER, 'cf-access-token', 'cf-access-client-id', 'cf-access-client-secret'];
const RESPONSE_PRIVATE_HEADERS = [...PRIVATE_HEADERS, 'cf-authorization', 'set-cookie'];
const gatewayPath = (url = '') => /^\/(?:api|t3)(?:\/|\?|$)/.test(url);
const within = (directory, file) => file === directory || file.startsWith(directory + path.sep);

export function validateLiveGateway(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Live gateway must be an explicit HTTP loopback origin with a port.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Live gateway must be an explicit HTTP loopback origin with a port.');
  }
  return url.origin;
}

function validatePort(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Frontend ports must be integers from 0 to 65535.');
}

function tokenReader(tokenFile, buildDir) {
  if (typeof tokenFile !== 'string' || !tokenFile) throw credentialError();
  return () => {
    let descriptor;
    try {
      const canonical = realpathSync(tokenFile);
      if (within(repo, canonical) || within(buildDir, canonical)) throw credentialError();
      descriptor = openSync(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 8192
        || (process.getuid && stat.uid !== process.getuid())) throw credentialError();
      const token = readFileSync(descriptor, 'utf8').trim();
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw credentialError();
      return token;
    } catch { throw credentialError(); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  };
}

async function verifyGateway(gateway, readToken) {
  const token = readToken();
  try {
    const response = await fetch(gateway + '/api/session', {
      headers: { [CF_HEADER]: token }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw authenticationError();
    const body = await response.json();
    if (body?.authenticated !== true) throw authenticationError();
  } catch { throw authenticationError(); }
}

function denyResponse(response) {
  if (response.writeHead && !response.headersSent) {
    response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: 'Live gateway credentials are unavailable.' }));
  } else if (!response.destroyed) {
    response.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    response.destroy();
  }
}

function authenticatedProxy(gateway, readToken, sockets) {
  const denied = new WeakSet();
  const track = (socket) => {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const prepare = (request) => {
    for (const name of PRIVATE_HEADERS) delete request.headers[name];
    request.headers[CF_HEADER] = readToken();
  };
  const stripResponse = (response) => {
    for (const name of RESPONSE_PRIVATE_HEADERS) delete response.headers[name];
  };
  const install = (server) => {
    server.httpServer.on('connection', track);
    server.middlewares.use((request, response, next) => {
      if (!gatewayPath(request.url)) return next();
      try { prepare(request); next(); }
      catch { denied.add(request); denyResponse(response); }
    });
    // Upgrade listeners do not run through Connect middleware. This hook is
    // registered before Vite's proxy, which still checks the denied marker below.
    server.httpServer.prependListener('upgrade', (request, socket) => {
      if (!gatewayPath(request.url)) return;
      try { prepare(request); }
      catch { denied.add(request); denyResponse(socket); }
    });
  };
  return {
    plugin: { name: 'local-live-gateway-auth', configureServer: install, configurePreviewServer: install },
    proxy: {
      '^/(?:api|t3)(?:/|$)': {
        target: gateway, changeOrigin: true, ws: true, proxyTimeout: 20000,
        configure(proxy) {
          proxy.on('proxyRes', stripResponse);
          proxy.on('proxyReq', (request) => { if (request.socket) track(request.socket); });
          proxy.on('proxyReqWs', (outgoing, request, socket) => {
            for (const name of PRIVATE_HEADERS) outgoing.removeHeader(name);
            if (denied.has(request)) { outgoing.destroy(); return; }
            try { outgoing.setHeader(CF_HEADER, request.headers[CF_HEADER]); }
            catch { outgoing.destroy(); denyResponse(socket); return; }
            outgoing.once('socket', track);
            // The HTTP proxy writes its WS handshake after this earlier listener.
            outgoing.on('upgrade', stripResponse);
            outgoing.on('response', stripResponse);
          });
          proxy.on('open', track);
        },
      },
    },
  };
}

export async function startLivePwaDev({ gateway, tokenFile, hmrPort = 5191, pwaPort = 43792, buildDir = path.join(web, 'dist') } = {}) {
  gateway = validateLiveGateway(gateway);
  validatePort(hmrPort); validatePort(pwaPort);
  if (hmrPort && hmrPort === pwaPort) throw new Error('HMR and built PWA ports must differ.');
  buildDir = path.resolve(buildDir);
  await access(path.join(buildDir, 'index.html')).catch(() => { throw new Error('Missing local web build. Build the frontend before starting live mode.'); });
  buildDir = realpathSync(buildDir);
  const readToken = tokenReader(tokenFile, buildDir);
  await verifyGateway(gateway, readToken);
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'bot-live-frontend-'));
  const sockets = new Set();
  let dev, built, closing;
  const close = () => closing ??= (async () => {
    for (const socket of sockets) socket.destroy();
    const results = await Promise.allSettled([
      dev?.close(),
      built && new Promise((resolve, reject) => built.httpServer.close((error) => error ? reject(error) : resolve())),
    ]);
    await rm(cacheRoot, { recursive: true, force: true });
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  })();
  try {
    const { createServer, loadConfigFromFile, preview } = await import(pathToFileURL(webRequire.resolve('vite')).href);
    const auth = authenticatedProxy(gateway, readToken, sockets);
    const startFrontend = async (mode, start) => {
      // Vite resolves isProduction from NODE_ENV. This launcher owns its process;
      // isolate each plugin instance and resolution so preview cannot turn off HMR.
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = mode;
      try {
        const loaded = await loadConfigFromFile({ command: 'serve', mode }, path.join(web, 'vite.config.ts'), web);
        if (!loaded) throw new Error('Could not load the local frontend configuration.');
        return await start({
          ...loaded.config, configFile: false, root: web, mode, envDir: false, envPrefix: [],
          // A simultaneous fixture frontend must keep its dependency cache intact.
          cacheDir: path.join(cacheRoot, mode),
          plugins: [localPwaDiagnosticsPlugin(), ...(loaded.config.plugins ?? []), auth.plugin],
          build: { ...loaded.config.build, outDir: buildDir },
          server: { host: '127.0.0.1', port: hmrPort, strictPort: true, open: false, proxy: auth.proxy },
          preview: { host: '127.0.0.1', port: pwaPort, strictPort: true, open: false, proxy: auth.proxy },
        });
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
      }
    };
    dev = await startFrontend('development', createServer);
    await dev.listen();
    built = await startFrontend('production', preview);
    const origin = (server) => `http://127.0.0.1:${server.address().port}`;
    return { hmrUrl: origin(dev.httpServer), pwaUrl: origin(built.httpServer), close };
  } catch (error) { await close().catch(() => {}); throw error; }
}

export function parseLivePwaOptions(args) {
  const options = { hmrPort: 5191, pwaPort: 43792, help: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!['--gateway', '--token-file', '--hmr-port', '--pwa-port'].includes(flag)) throw new Error('Unknown live-mode option. Run with --help.');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing live-mode option value. Run with --help.');
    if (flag === '--gateway') options.gateway = value;
    else if (flag === '--token-file') options.tokenFile = value;
    else options[flag === '--hmr-port' ? 'hmrPort' : 'pwaPort'] = /^\d+$/.test(value) ? Number(value) : NaN;
  }
  return options;
}

async function main() {
  const options = parseLivePwaOptions(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/local-pwa-live.mjs --gateway http://127.0.0.1:43781 --token-file PRIVATEFILE [--hmr-port 5191] [--pwa-port 43792]\nExplicit live account access. The gateway stays remote; only local frontend files are served. Build web/dist first.');
    return;
  }
  const loop = await startLivePwaDev(options);
  const input = createInterface({ input: process.stdin });
  let stopping;
  const stop = () => stopping ??= (async () => {
    input.close(); process.stdin.pause();
    await loop.close();
    console.log('Live local frontends stopped. The remote gateway, SSH forward and token file were left untouched.');
  })();
  const fail = () => { console.error('Live frontend operation failed. Check credentials, ports and the SSH forward.'); process.exitCode = 1; };
  process.once('SIGINT', () => void stop().catch(fail));
  process.once('SIGTERM', () => void stop().catch(fail));
  input.on('line', (line) => { if (['quit', 'q'].includes(line.trim())) void stop().catch(fail); });
  console.log(`\nAuthenticated LIVE local frontend\nHMR: ${loop.hmrUrl}\nBuilt PWA: ${loop.pwaUrl}\nLauncher PID: ${process.pid}\nThese frontends use your real account and remote runtime. Tokens are injected only by the server-side proxy.\nAndroid port setup: adb -s SERIAL reverse tcp:${new URL(loop.hmrUrl).port} tcp:${new URL(loop.hmrUrl).port}\nAndroid port setup: adb -s SERIAL reverse tcp:${new URL(loop.pwaUrl).port} tcp:${new URL(loop.pwaUrl).port}\nOpen the localhost version of these URLs through your device-bound agent-device command. Type quit or press Ctrl-C to stop.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Live PWA startup failed. Check the loopback gateway, authenticated private token file, build and available ports.'); process.exitCode = 1; });
}
