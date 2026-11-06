import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { LOCAL_PWA_DIAGNOSTICS_HTML } from './local-pwa-diagnostics.mts';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { JSDOM } = require('jsdom');

test('diagnostics executes in its own origin and shows cache/worker state plus explicit registration errors', async () => {
  const scriptURL = 'http://localhost:43792/sw.js';
  let registrations = 0;
  const window = new JSDOM(LOCAL_PWA_DIAGNOSTICS_HTML, {
    url: 'http://localhost:43792/api/__local_pwa_diagnostics', runScripts: 'dangerously',
    // jsdom comes from web/node_modules through require, untyped; its window is patched freely here.
    beforeParse(window: any) {
      Object.defineProperty(window, 'isSecureContext', { value: true });
      window.Request = Request;
      const active = new window.EventTarget(); Object.assign(active, { scriptURL, state: 'activated' });
      Object.defineProperty(window.navigator, 'serviceWorker', { value: Object.assign(new window.EventTarget(), {
        controller: active,
        getRegistrations: async () => [Object.assign(new window.EventTarget(), { scope: 'http://localhost:43792/', updateViaCache: 'none', active })],
        register: async (url: string, options: RegistrationOptions) => { registrations++; assert.equal(url, '/sw.js'); assert.equal(options.scope, '/'); assert.equal(options.updateViaCache, 'none'); throw new TypeError('Generic diagnostic registration failure'); },
      }) });
      window.caches = {
        keys: async () => ['bot-shell-test'],
        open: async () => ({
          keys: async () => [new Request('http://localhost:43792/index.html'), new Request('http://localhost:43792/assets/app.js')],
          match: async (request: string | Request) => {
            const url = typeof request === 'string' ? request : request.url;
            return new Response(url.endsWith('index.html') ? '<script type="module" src="/assets/app.js"></script>' : 'app', { headers: { Vary: 'Origin' } });
          },
        }),
      };
    },
  }).window;
  try {
    const waitFor = async (predicate: () => boolean) => {
      const until = Date.now() + 2000;
      while (!predicate()) { if (Date.now() > until) assert.fail('Diagnostic state did not appear'); await new Promise((resolve) => setTimeout(resolve, 5)); }
    };
    await waitFor(() => window.document.getElementById('state').textContent.includes('scriptCacheMatches'));
    const state = JSON.parse(window.document.getElementById('state').textContent);
    assert.equal(state.isSecureContext, true);
    assert.equal(state.controller.state, 'activated');
    assert.equal(state.registrations[0].active.scriptURL, scriptURL);
    assert.equal(state.caches[0].entryCount, 2);
    assert.deepEqual(state.caches[0].indexScripts, ['http://localhost:43792/assets/app.js']);
    assert.equal(state.caches[0].scriptCacheMatches[0].storedRequestOrigin, null);
    assert.equal(state.caches[0].scriptCacheMatches[0].constructedProbeOrigin, 'http://localhost:43792');
    assert.match(window.document.getElementById('summary').textContent, /Stored Origin: null\nProbe Origin: http:\/\/localhost:43792/);
    assert.equal(registrations, 0, 'inspection itself never registers or updates a worker');
    window.document.getElementById('register').click();
    await waitFor(() => window.document.getElementById('events').textContent.includes('Generic diagnostic registration failure'));
    assert.equal(registrations, 1);
    assert.match(window.document.getElementById('events').textContent, /TypeError/);
  } finally { window.close(); }
});
