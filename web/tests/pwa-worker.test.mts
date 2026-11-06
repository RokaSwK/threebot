import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { after, before, test } from "node:test";
import { build } from "vite";
import { pwaPrecache } from "../plugins/pwaPrecache.ts";

// Execute the produced worker, real Request/Response/digest and real HTTP asset
// fetches. CacheStorage and lifecycle dispatch are browser-boundary adapters;
// this proves cache/event behavior, not browser install UI, rendering or eviction.
const web = new URL("../", import.meta.url).pathname;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let temporary, app, nested, update, origin, server;
let files, offline = false, failure, edgeTokens = 0;
const seen = [];
async function tree(directory) {
  const files = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [name, bytes] of await tree(path.join(directory, entry.name))) files.set(entry.name + "/" + name, bytes);
    else files.set(entry.name, await readFile(path.join(directory, entry.name)));
  }
  return files;
}
function produced(directory, files) {
  const source = files.get("sw.js").toString();
  const manifest = JSON.parse(source.match(/^const BUILD = (\{.+\});$/m)[1]);
  return { directory, files, source, manifest };
}
async function fixtureBuild(base, revision) {
  const root = path.join(temporary, revision);
  await mkdir(root);
  await writeFile(path.join(root, "index.html"), '<div id="root">' + revision + '</div><script type="module" src="./main.js"></script>');
  await writeFile(path.join(root, "main.js"), 'import "./style.css"; window.loadDiagram = () => import("./lazy.js");');
  await writeFile(path.join(root, "lazy.js"), 'export const diagram = "' + revision + '";');
  await writeFile(path.join(root, "style.css"), 'body { background: #121212; }');
  const outDir = path.join(root, "built");
  await build({ root, configFile: false, publicDir: path.join(web, "public"), base, plugins: [pwaPrecache()], logLevel: "silent", build: { outDir } });
  return produced(outDir, await tree(outDir));
}
before(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "bot-pwa-worker-"));
  const outDir = path.join(temporary, "app");
  await build({ root: web, configFile: path.join(web, "vite.config.ts"), envDir: false, envPrefix: [], logLevel: "silent", build: { outDir, emptyOutDir: true } });
  app = produced(outDir, await tree(outDir));
  nested = await fixtureBuild("/nested/bot/", "nested-one");
  update = await fixtureBuild("/", "updated-two");
  server = http.createServer((request, response) => {
    seen.push(request.url);
    response.setHeader("Vary", "Origin"); // Vite preview varies even same-origin static responses.
    const filename = decodeURIComponent(request.url.slice(1));
    if (failure?.url === request.url) {
      if (failure.kind === "redirect") { response.writeHead(302, { location: "/cdn-cgi/access/login" }); response.end(); return; }
      if (failure.kind === "missing") { response.writeHead(404); response.end("missing"); return; }
      if (failure.kind === "edge-script") {
        const body = Buffer.from(files.get(filename)).toString().replace("</body>", `<script>window.__CF$cv$params={r:'${++edgeTokens}'}</script></body>`);
        response.writeHead(200, { "content-type": "text/html" }); response.end(body); return;
      }
      if (failure.kind === "flaky") {
        failure.drops = (failure.drops ?? 0) + 1;
        if (failure.drops <= 2) response.destroy(); else response.end(files.get(filename));
        return;
      }
      response.setHeader("content-type", "text/html"); response.end('<title>Cloudflare Access login</title>'); return;
    }
    const bytes = files?.get(filename);
    response.writeHead(bytes ? 200 : 404);
    response.end(bytes ?? "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(temporary, { recursive: true, force: true });
});

function cacheStorage() {
  const stores = new Map();
  const key = (request) => typeof request === "string" ? request : request.url ?? request.href;
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const data = stores.get(name);
      return {
        async put(request, response) {
          data.set(key(request), { request: request instanceof Request ? request.clone() : new Request(key(request)), response: response.clone() });
        },
        async match(request, options: CacheQueryOptions = {}) {
          const stored = data.get(key(request));
          if (!stored) return undefined;
          const query = request instanceof Request ? request : new Request(key(request));
          // Cache API Query Cache matches every response Vary field against the
          // stored request, unless explicitly disabled. URL-only maps hide this.
          if (!options.ignoreVary) {
            const vary = stored.response.headers.get("vary")?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
            if (vary.some((name) => name === "*" || query.headers.get(name) !== stored.request.headers.get(name))) return undefined;
          }
          return stored.response.clone();
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
}
function worker(build, caches = cacheStorage()) {
  const listeners = new Map();
  let claimCalls = 0, skipCalls = 0;
  const navigated = [];
  const self = {
    location: new URL(build.manifest.base + "sw.js", origin),
    clients: {
      async claim() { claimCalls++; },
      async matchAll() { return (build.openWindows ?? []).map((url) => ({ url, async navigate(target) { navigated.push(target); } })); },
    },
    skipWaiting() { skipCalls++; },
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  vm.runInNewContext(build.source, {
    self, caches, URL, Request, Uint8Array, crypto: webcrypto, setTimeout,
    fetch: async (request) => { if (offline) throw new TypeError("Network offline"); return fetch(request); },
  }, { filename: "produced-sw.js" });
  return {
    caches, navigated, get claimCalls() { return claimCalls; }, get skipCalls() { return skipCalls; },
    async lifecycle(name) {
      const pending = [];
      listeners.get(name)({ waitUntil(promise) { pending.push(promise); } });
      await Promise.all(pending);
    },
    async request(pathname: string, { method = "GET", navigate = false, headers }: { method?: string; navigate?: boolean; headers?: HeadersInit } = {}) {
      const request = new Request(new URL(pathname, origin), { method, headers });
      if (navigate) Object.defineProperty(request, "mode", { value: "navigate" });
      let response;
      listeners.get("fetch")({ request, respondWith(promise) { response = promise; } });
      return response;
    },
  };
}
function serve(build) {
  files = new Map([...build.files].map(([name, bytes]) => [build.manifest.base.slice(1) + name, bytes]));
  seen.length = 0; offline = false; failure = undefined;
}

test("actual app build precaches every exact lazy asset before any controlled page fetch", async (t) => {
  serve(app);
  const emitted = [...app.files].filter(([name]) => name === "index.html" || name.startsWith("assets/"));
  for (const [name, bytes] of emitted) {
    const entry = app.manifest.entries.find((entry) => entry.url === "/" + name);
    assert.ok(entry, `${name} is available on the first offline launch`);
    assert.equal(entry.sha256, digest(bytes), name + " digest matches final output");
  }
  assert.ok(emitted.some(([name]) => /mermaid|diagram|flowchart/i.test(name)), "real lazy diagram engine is covered");
  const runtime = worker(app);
  await runtime.lifecycle("install");
  assert.equal(runtime.claimCalls, 0, "installation must finish before activation claims pages");
  assert.equal(runtime.skipCalls, 1, "a verified update applies without waiting for every window to close");
  // The worker never requests `/`; local tools can probe any newly opened port.
  assert.deepEqual(seen.filter((url) => url !== "/").sort(), app.manifest.entries.map((entry) => entry.url).sort());
  assert.equal(runtime.caches.stores.size, 1);
  assert.equal([...runtime.caches.stores.values()][0].size, app.manifest.entries.length);
  await runtime.lifecycle("activate");
  assert.equal(runtime.claimCalls, 1);
  offline = true;
  const shell = await runtime.request("/?thread=example", { navigate: true });
  assert.deepEqual(Buffer.from(await shell.arrayBuffer()), app.files.get("index.html"));
  for (const entry of app.manifest.entries) {
    const response = await runtime.request(entry.url);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), entry.sha256, `${entry.url} loads offline without a second visit`);
  }
  const total = app.manifest.entries.reduce((sum, entry) => sum + app.files.get(decodeURIComponent(entry.url.slice(1))).length, 0);
  const html = app.files.get("index.html").toString();
  const initialUrls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map((match) => match[1]);
  const entryBytes = app.files.get("index.html").length + initialUrls.reduce((sum, url) => sum + app.files.get(url.slice(1)).length, 0);
  t.diagnostic(`Precache ${app.manifest.entries.length} files / ${total} bytes; HTML + its direct script/style references ${entryBytes} bytes (excludes transitive imports).`);
});

test("API, T3, auth, cross-origin, unknown static and mutations never enter shell cache", async () => {
  serve(app);
  const runtime = worker(app);
  await runtime.lifecycle("install");
  offline = true;
  for (const pathname of ["/api", "/api/session", "/t3", "/t3/ws", "/cdn-cgi/access/login", "/login", "/logout", "/auth/callback", "/private.png", "https://external.invalid/assets/app.js"]) {
    assert.equal(await runtime.request(pathname), undefined, pathname);
    if (!pathname.includes("private.png") && !pathname.includes("external")) assert.equal(await runtime.request(pathname, { navigate: true }), undefined, pathname + " navigation");
  }
  assert.equal(await runtime.request("/", { method: "POST", navigate: true }), undefined);
  assert.equal(await runtime.request(app.manifest.entries.find((entry) => entry.url.endsWith(".js")).url + "?private=token"), undefined);
  assert.equal([...runtime.caches.stores.values()][0].size, app.manifest.entries.length);
});

test("SHA-verified static JS and CSS load offline even when request Origin differs from precaching", async () => {
  serve(app);
  const runtime = worker(app);
  await runtime.lifecycle("install"); await runtime.lifecycle("activate");
  const cache = await runtime.caches.open((await runtime.caches.keys())[0]);
  offline = true;
  for (const suffix of [".js", ".css"]) {
    const entry = app.manifest.entries.find((entry) => entry.url.endsWith(suffix));
    assert.ok(entry);
    const query = new Request(origin + entry.url, { headers: { Origin: origin } });
    assert.equal(query.headers.get("origin"), origin, "the simulated fetch-event request actually carries Origin");
    assert.ok(await cache.match(origin + entry.url));
    assert.equal(await cache.match(query), undefined, "normal Cache matching respects Vary: Origin");
    assert.ok(await cache.match(query, { ignoreVary: true }));
    const response = await runtime.request(entry.url, { headers: { Origin: origin } });
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), entry.sha256);
  }
});

for (const kind of ["missing", "redirect", "login-html"]) test(`first install rejects ${kind} asset and leaves prior caches intact`, async () => {
  serve(app);
  failure = { url: kind === "login-html" ? "/index.html" : app.manifest.entries.find((entry) => entry.url.endsWith(".js")).url, kind };
  const caches = cacheStorage(); await caches.open("bot-shell-v7"); await caches.open("unrelated-app-cache");
  const runtime = worker(app, caches);
  await assert.rejects(runtime.lifecycle("install"));
  assert.deepEqual(await caches.keys(), ["bot-shell-v7", "unrelated-app-cache"]);
  assert.equal(runtime.claimCalls, 0);
  assert.equal(runtime.skipCalls, 0);
  assert.equal(seen.includes("/cdn-cgi/access/login"), false, "an Access redirect is never followed");
});

test("an edge rewriting the page per request cannot block an update", async () => {
  serve(app);
  failure = { url: "/index.html", kind: "edge-script" };
  const runtime = worker(app);
  await runtime.lifecycle("install");
  assert.equal(runtime.skipCalls, 1);
  assert.equal([...runtime.caches.stores.values()][0].size, app.manifest.entries.length);
  offline = true;
  assert.match(await (await runtime.request("/", { navigate: true })).text(), /__CF\$cv\$params/);
});

test("a dropped connection retries the file instead of abandoning the update", async () => {
  serve(app);
  failure = { url: app.manifest.entries.find((entry) => entry.url.endsWith(".js")).url, kind: "flaky" };
  const runtime = worker(app);
  await runtime.lifecycle("install");
  assert.equal(failure.drops, 3);
  assert.equal([...runtime.caches.stores.values()][0].size, app.manifest.entries.length);
});

test("an interrupted install resumes without downloading verified files again", async () => {
  serve(app);
  const caches = cacheStorage();
  const key = "bot-shell-" + encodeURIComponent(app.manifest.base) + "-" + app.manifest.revision;
  const first = app.manifest.entries[0];
  await (await caches.open(key)).put(new URL(first.url, origin), new Response("already verified"));
  await worker(app, caches).lifecycle("install");
  assert.equal(seen.includes(first.url), false);
  assert.equal(seen.filter((url) => url !== "/").length, app.manifest.entries.length - 1);
});

test("activating an update reloads open windows once, and a first install does not", async () => {
  serve(app);
  const caches = cacheStorage();
  const first = worker({ ...app, openWindows: [`${origin}/`] }, caches);
  await first.lifecycle("install"); await first.lifecycle("activate");
  assert.deepEqual(first.navigated, []);
  serve(update);
  const next = worker({ ...update, openWindows: [`${origin}/?bot=main`] }, caches);
  await next.lifecycle("install"); await next.lifecycle("activate");
  assert.deepEqual(next.navigated, [`${origin}/?bot=main`]);
});

test("content revisions migrate only this app's caches on activation, leaving old shell usable while waiting", async () => {
  serve(app);
  const caches = cacheStorage();
  await caches.open("bot-shell-v7"); await caches.open("unrelated-app-cache"); await caches.open("bot-shell-%2Fnested%2Fbot%2F-retained");
  const old = worker(app, caches);
  await old.lifecycle("install"); await old.lifecycle("activate");
  const oldKey = (await caches.keys()).find((key) => key.endsWith(app.manifest.revision));
  assert.ok(oldKey);
  assert.equal((await caches.keys()).includes("bot-shell-v7"), false);
  assert.notEqual(app.manifest.revision, update.manifest.revision);
  serve(update);
  const next = worker(update, caches);
  await next.lifecycle("install");
  assert.ok((await caches.keys()).includes(oldKey), "waiting update cannot delete active old shell");
  offline = true;
  assert.deepEqual(Buffer.from(await (await old.request("/", { navigate: true })).arrayBuffer()), app.files.get("index.html"));
  await next.lifecycle("activate");
  assert.deepEqual(Buffer.from(await (await next.request("/", { navigate: true })).arrayBuffer()), update.files.get("index.html"));
  assert.equal((await caches.keys()).includes(oldKey), false);
  assert.ok((await caches.keys()).includes("unrelated-app-cache"));
  assert.ok((await caches.keys()).includes("bot-shell-%2Fnested%2Fbot%2F-retained"));
});

test("non-root base emits scoped manifest, cache and offline navigation without intercepting sibling apps", async () => {
  serve(nested);
  const manifest = JSON.parse(nested.files.get("manifest.webmanifest"));
  assert.equal(manifest.start_url, "/nested/bot/");
  assert.equal(manifest.scope, "/nested/bot/");
  assert.ok(manifest.icons.every((icon) => icon.src.startsWith("/nested/bot/")));
  assert.ok(nested.manifest.entries.every((entry) => entry.url.startsWith("/nested/bot/")));
  const runtime = worker(nested);
  await runtime.lifecycle("install"); await runtime.lifecycle("activate"); offline = true;
  assert.deepEqual(Buffer.from(await (await runtime.request("/nested/bot/thread", { navigate: true })).arrayBuffer()), nested.files.get("index.html"));
  assert.equal(await runtime.request("/nested/bot/api/session", { navigate: true }), undefined);
  assert.equal(await runtime.request("/nested/other/", { navigate: true }), undefined);
  assert.equal(await runtime.request("/", { navigate: true }), undefined);
});
