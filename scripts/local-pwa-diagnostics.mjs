// Served only by the loopback development launchers, before auth/API proxies.
export const LOCAL_PWA_DIAGNOSTICS_PATH = '/api/__local_pwa_diagnostics';
export const LOCAL_PWA_DIAGNOSTICS_HTML = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local PWA diagnostics</title>
<style>body{font:15px system-ui;line-height:1.5;margin:18px;overflow-wrap:anywhere}button,a{display:inline-block;font:inherit;padding:10px;margin:4px 4px 12px 0}pre{white-space:pre-wrap;word-break:break-word;border:1px solid #aaa;padding:10px}h1{font-size:22px}</style>
<h1>Local PWA diagnostics</h1><p>Browser evidence for this origin only. No account data or credentials are inspected.</p>
<button id="inspect">Check state</button><button id="register">Register / check worker</button><a href="/">Open app</a>
<pre id="summary" role="status" aria-live="polite">Checking…</pre>
<h2>Current browser state</h2><pre id="state">Checking…</pre>
<h2>Worker events</h2><pre id="events" role="log" aria-live="polite">No events yet.</pre>
<script>
(() => {
  const output = document.getElementById('state');
  const events = document.getElementById('events');
  const observed = new WeakSet();
  const lines = [];
  const errorText = (error) => ({ name: String(error && error.name || 'Error'), message: String(error && error.message || 'Operation failed').slice(0, 1000) });
  const log = (value) => { lines.push(new Date().toISOString() + ' ' + value); events.textContent = lines.slice(-40).join('\\n'); };
  const workerState = (worker) => worker ? { scriptURL: worker.scriptURL, state: worker.state } : null;
  function observe(worker) {
    if (!worker || observed.has(worker)) return;
    observed.add(worker);
    worker.addEventListener('statechange', () => { log('Worker state: ' + worker.state); void inspect(); });
    worker.addEventListener('error', (event) => log('Worker error: ' + String(event.message || 'Unspecified worker error').slice(0, 1000)));
  }
  async function inspect() {
    const result = { origin: location.origin, isSecureContext: window.isSecureContext, serviceWorkerSupported: 'serviceWorker' in navigator, cacheStorageSupported: 'caches' in window };
    try {
      if ('serviceWorker' in navigator) {
        result.controller = workerState(navigator.serviceWorker.controller);
        result.registrations = (await navigator.serviceWorker.getRegistrations()).map((registration) => {
          for (const worker of [registration.active, registration.waiting, registration.installing]) observe(worker);
          if (!observed.has(registration)) { observed.add(registration); registration.addEventListener('updatefound', () => { log('Update found'); observe(registration.installing); void inspect(); }); }
          return { scope: registration.scope, updateViaCache: registration.updateViaCache, active: workerState(registration.active), waiting: workerState(registration.waiting), installing: workerState(registration.installing) };
        });
      }
      if ('caches' in window) {
        result.caches = [];
        for (const key of await caches.keys()) {
          const cache = await caches.open(key);
          const requests = await cache.keys();
          const indexRequest = requests.find((request) => new URL(request.url).pathname.endsWith('/index.html')) || requests.find((request) => new URL(request.url).pathname === '/');
          const item = { key, entryCount: requests.length, indexURL: indexRequest && indexRequest.url || null, storedIndexOrigin: indexRequest && indexRequest.headers.get('origin') };
          if (indexRequest) {
            const response = await cache.match(indexRequest);
            const html = response ? await response.text() : '';
            const document = new DOMParser().parseFromString(html, 'text/html');
            item.indexScripts = Array.from(document.querySelectorAll('script[src]'), (script) => new URL(script.getAttribute('src'), indexRequest.url).href);
            item.indexVary = response && response.headers.get('vary');
            item.scriptCacheMatches = [];
            for (const url of item.indexScripts) {
              const plain = await cache.match(url);
              const probe = new Request(url, { headers: { Origin: location.origin } });
              const withOrigin = await cache.match(probe);
              const stored = requests.find((request) => request.url === url);
              item.scriptCacheMatches.push({ url, plain: !!plain, withOrigin: !!withOrigin, vary: plain && plain.headers.get('vary'), storedRequestOrigin: stored && stored.headers.get('origin'), constructedProbeOrigin: probe.headers.get('origin') });
            }
          }
          result.caches.push(item);
        }
      }
    } catch (error) { result.error = errorText(error); }
    output.textContent = JSON.stringify(result, null, 2);
    const registration = result.registrations && result.registrations[0];
    const cached = result.caches && result.caches.find((item) => item.indexScripts && item.indexScripts.length);
    const script = cached && cached.scriptCacheMatches[0];
    document.getElementById('summary').textContent = [
      'Secure: ' + result.isSecureContext + '; SW: ' + result.serviceWorkerSupported,
      'Controller: ' + (result.controller && result.controller.state || 'none'),
      'Active: ' + (registration && registration.active && registration.active.state || 'none') + '; waiting: ' + (registration && registration.waiting && registration.waiting.state || 'none'),
      'Cache entries: ' + (cached && cached.entryCount || 0),
      'Script: ' + (script && new URL(script.url).pathname.split('/').pop() || 'none'),
      'Stored Origin: ' + (script && script.storedRequestOrigin || 'null'),
      'Probe Origin: ' + (script && script.constructedProbeOrigin || 'null'),
      'Match plain/probe: ' + (script ? script.plain + '/' + script.withOrigin : 'unknown') + '; Vary: ' + (script && script.vary || 'none'),
      result.error ? 'Error: ' + result.error.name + ': ' + result.error.message : 'Inspection complete',
    ].join('\\n');
  }
  document.getElementById('inspect').addEventListener('click', () => void inspect());
  document.getElementById('register').addEventListener('click', async () => {
    if (!('serviceWorker' in navigator)) { log('Service workers are unavailable'); return; }
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      log('Register resolved; checking for update');
      for (const worker of [registration.active, registration.waiting, registration.installing]) observe(worker);
      await registration.update();
      log('Update check resolved');
    } catch (error) { log('Registration error: ' + JSON.stringify(errorText(error))); }
    await inspect();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', () => { log('Controller changed'); void inspect(); });
  void inspect();
})();
</script></html>`;

export function localPwaDiagnosticsPlugin() {
  const install = (server) => { server.middlewares.use((request, response, next) => {
    if (request.url?.split('?')[0] !== LOCAL_PWA_DIAGNOSTICS_PATH) return next();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    response.writeHead(200);
    response.end(request.method === 'HEAD' ? undefined : LOCAL_PWA_DIAGNOSTICS_HTML);
  }); };
  return { name: 'local-pwa-diagnostics', configureServer: install, configurePreviewServer: install };
}
