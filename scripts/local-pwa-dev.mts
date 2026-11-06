#!/usr/bin/env node
// Two local frontend origins over the existing disposable gateway/runtime fixture.
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createFixture } from './fixture.mts';
import { validateScenario } from './fixture-scenarios.mts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const web = path.join(repo, 'web');
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const HELP = `Usage: node scripts/local-pwa-dev.mts [options]
  --pwa-port PORT     Built PWA + disposable gateway (default 43780; 0 chooses a free port)
  --hmr-port PORT     Vite frontend + proxied disposable gateway (default 5180; 0 chooses a free port)
  --scenario NAME     interactions (default), basic, executor, library, latest-t3, or activity
  --build             Run the web production build before starting
  --help              Show this help

Fixture data only. No live-runtime mode or credentials are used.
Build web/dist first, or use --build. Type restart, reset, or quit while running.`;

// Vite is loaded from web/ at run time, so its types aren't available here; these are the parts used.
interface ViteDevServerLike { httpServer: Server; listen(): Promise<unknown>; close(): Promise<void> }
interface ViteApi {
  createServer(config: object): Promise<ViteDevServerLike>;
  loadConfigFromFile(env: { command: string; mode: string }, configFile: string, root: string): Promise<{ config: object } | null>;
}

function port(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${label} must be an integer from 0 to 65535.`);
  return value;
}

export function parseLocalPwaOptions(args: string[]) {
  const options = { pwaPort: 43780, hmrPort: 5180, scenario: 'interactions', build: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--build') options.build = true;
    else if (['--pwa-port', '--hmr-port', '--scenario'].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
      if (flag === '--scenario') options.scenario = value;
      else options[flag === '--pwa-port' ? 'pwaPort' : 'hmrPort'] = /^\d+$/.test(value) ? Number(value) : NaN;
    } else throw new Error(`Unknown option: ${flag}. Live mode is deliberately unavailable; see docs/parity/local-development.md.`);
  }
  validateScenario(options.scenario);
  port(options.pwaPort, 'PWA port');
  port(options.hmrPort, 'HMR port');
  if (options.pwaPort && options.pwaPort === options.hmrPort) throw new Error('PWA and HMR ports must differ so service workers cannot cache HMR modules.');
  return options;
}

async function buildFrontend(signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], { cwd: web, stdio: 'inherit', shell: false, signal });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Web build failed (${code ?? signal}).`)));
  });
}

export async function startLocalPwaDev({ pwaPort = 43780, hmrPort = 5180, scenario = 'interactions', build = false, signal }: { pwaPort?: number; hmrPort?: number; scenario?: string; build?: boolean; signal?: AbortSignal } = {}) {
  signal?.throwIfAborted();
  validateScenario(scenario);
  port(pwaPort, 'PWA port');
  port(hmrPort, 'HMR port');
  if (pwaPort && pwaPort === hmrPort) throw new Error('PWA and HMR ports must differ so service workers cannot cache HMR modules.');
  if (build) await buildFrontend(signal);
  const fixture = await createFixture({ port: pwaPort, scenario });
  let vite: ViteDevServerLike | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    // Both servers are owned by this invocation. Always try to close both.
    const results = await Promise.allSettled([vite?.close(), fixture.close()]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  })();
  try {
    signal?.throwIfAborted();
    const { createServer, loadConfigFromFile }: ViteApi = await import(pathToFileURL(webRequire.resolve('vite')).href);
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(web, 'vite.config.ts'), web);
    if (!loaded) throw new Error('Could not load the web Vite configuration.');
    vite = await createServer({
      ...loaded.config,
      configFile: false,
      root: web,
      // Do not load local .env files or export inherited VITE_* values to this fixture frontend.
      envDir: false,
      envPrefix: [],
      server: {
        host: '127.0.0.1', port: hmrPort, strictPort: true, open: false,
        // Replace, rather than merge, existing BOT_GATEWAY/BOT_SESSION proxy configuration.
        proxy: {
          '/api': { target: fixture.url, changeOrigin: true },
          '/t3': { target: fixture.url, changeOrigin: true, ws: true },
        },
      },
    });
    await vite.listen();
    signal?.throwIfAborted();
    const address = vite.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port.');
    const hmrUrl = `http://127.0.0.1:${address.port}`;
    return { fixture, hmrUrl, pwaUrl: fixture.url, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

function deviceUrl(origin: string) {
  const url = new URL(origin);
  url.hostname = 'localhost';
  return url.origin;
}

async function main() {
  const options = parseLocalPwaOptions(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const controller = new AbortController();
  const fail = (error: Error) => { console.error(error.message); process.exitCode = 1; };
  let stop: () => void | Promise<void> = () => controller.abort();
  const onSignal = () => void Promise.resolve(stop()).catch(fail);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const removeSignals = () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  let loop: Awaited<ReturnType<typeof startLocalPwaDev>>;
  try { loop = await startLocalPwaDev({ ...options, signal: controller.signal }); }
  catch (error) {
    removeSignals();
    if (controller.signal.aborted) { console.log('Local PWA startup stopped; its servers were cleaned up.'); return; }
    throw error;
  }
  const pwaPort = new URL(loop.pwaUrl).port;
  const hmrPort = new URL(loop.hmrUrl).port;
  console.log(`\nDisposable local PWA loop (scenario: ${options.scenario})\nHMR: ${loop.hmrUrl}\nBuilt PWA: ${loop.pwaUrl}\nFixture directory: ${loop.fixture.root}\nLauncher PID: ${process.pid}; gateway PID: ${loop.fixture.gatewayPid}\nThe built PWA serves web/dist. HMR serves current source; it deliberately registers no service worker.\nNo real T3, inference or account credentials are used.\n\nAndroid port setup (substitute only the serial of your own device):\n  adb -s SERIAL reverse tcp:${hmrPort} tcp:${hmrPort}\n  adb -s SERIAL reverse tcp:${pwaPort} tcp:${pwaPort}\nThen use the device-bound agent-device to open ${deviceUrl(loop.hmrUrl)} or ${deviceUrl(loop.pwaUrl)}.\nCommands: restart, reset, quit. Ctrl-C also stops only this invocation's servers.`);
  const input = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  let stopping: Promise<void> | undefined;
  stop = () => stopping ??= (async () => {
    input.close();
    process.stdin.pause();
    await queue.catch(() => {});
    await loop.close();
    removeSignals();
    console.log('Local PWA loop stopped; its temporary fixture data was removed.');
  })();
  input.on('line', (line) => {
    const command = line.trim();
    if (stopping) return;
    // By now stop is the async one assigned above.
    if (command === 'quit' || command === 'q') { void (stop() as Promise<void>).catch(fail); return; }
    queue = queue.then(async () => {
      if (command === 'restart') await loop.fixture.restart();
      else if (command === 'reset') await loop.fixture.reset();
      else { console.log('Commands: restart, reset, quit. Rebuild web/dist separately to update the built PWA.'); return; }
      console.log(`Ready: ${loop.pwaUrl} and ${loop.hmrUrl} (gateway PID ${loop.fixture.gatewayPid}).`);
    }).catch(fail);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
