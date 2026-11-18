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
import { fileURLToPath } from "node:url";

// Execute the produced worker, real Request/Response/digest and real HTTP asset
// fetches. CacheStorage and lifecycle dispatch are browser-boundary adapters;
// this proves cache/event behavior, not browser install UI, rendering or eviction.
const web = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let temporary, app, nested, update, later, sameLazy, origin, server;
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
async function fixtureBuild(base, revision, lazy = revision) {
  const root = path.join(temporary, revision);
  await mkdir(root);
  await writeFile(path.join(root, "index.html"), '<!doctype html><html><head><title>Fixture</title></head><body><div id="root">' + revision + '</div><script type="module" src="./main.js"></script></body></html>' );
  await writeFile(path.join(root, "main.js"), 'import "./style.css"; window.loadDiagram = () => import("./lazy.js");');
  await writeFile(path.join(root, "lazy.js"), 'export const diagram = "' + lazy + '";');
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
  later = await fixtureBuild("/", "updated-three");
  sameLazy = await fixtureBuild("/", "updated-four", "updated-two");
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
          // Cache.put consumes the body and stores bytes, so repeated matches
          // get independent streams even when the response came from this cache.
          const body = await response.arrayBuffer();
          data.set(key(request), {
            request: request instanceof Request ? request.clone() : new Request(key(request)),
            body,
            status: response.status,
            headers: new Headers(response.headers),
          });
        },
        async match(request, options: CacheQueryOptions = {}) {
          const stored = data.get(key(request));
          if (!stored) return undefined;
          const query = request instanceof Request ? request : new Request(key(request));
          // Cache API Query Cache matches every response Vary field against the
          // stored request, unless explicitly disabled. URL-only maps hide this.
          if (!options.ignoreVary) {
            const vary = stored.headers.get("vary")?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
            if (vary.some((name) => name === "*" || query.headers.get(name) !== stored.request.headers.get(name))) return undefined;
          }
          return new Response(stored.body.slice(0), { status: stored.status, headers: stored.headers });
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
  const opened: string[] = [];
  const shown: { title: string; options: NotificationOptions }[] = [];
  const self = {
    location: new URL(build.manifest.base + "sw.js", origin),
    clients: {
      async claim() { claimCalls++; },
      async matchAll() { return (build.openWindows ?? []).map((url) => ({ url, async focus() {}, async navigate(target) { if (build.navigateFails) throw new Error("not controlled"); navigated.push(target); } })); },
      async openWindow(target: string) { opened.push(target); return null; },
    },
    registration: {
      async showNotification(title: string, options: NotificationOptions) { shown.push({ title, options }); },
    },
    skipWaiting() { skipCalls++; },
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  vm.runInNewContext(build.source, {
    self, caches, URL, Request, Response, Uint8Array, crypto: webcrypto, setTimeout,
    fetch: async (request) => { if (offline) throw new TypeError("Network offline"); return fetch(request); },
  }, { filename: "produced-sw.js" });
  return {
    caches, navigated, opened, shown, get claimCalls() { return claimCalls; }, get skipCalls() { return skipCalls; },
    async lifecycle(name) {
      const pending = [];
      listeners.get(name)({ waitUntil(promise) { pending.push(promise); } });
      await Promise.all(pending);
    },
    async click(data: unknown) {
      const pending: Promise<unknown>[] = [];
      listeners.get("notificationclick")({ notification: { data, close() {} }, waitUntil(promise: Promise<unknown>) { pending.push(promise); } });
      await Promise.all(pending);
    },
    async push(payload: unknown) {
      const pending: Promise<unknown>[] = [];
      listeners.get("push")({ data: { json: () => payload }, waitUntil(promise: Promise<unknown>) { pending.push(promise); } });
      await Promise.all(pending);
      return shown.at(-1);
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
const coreEntries = (manifest) => manifest.entries.filter((entry) => !entry.optional);
const optionalEntries = (manifest) => manifest.entries.filter((entry) => entry.optional);

test("actual app build precaches core shell on install and caches optional assets on demand", async (t) => {
  serve(app);
  const emitted = [...app.files].filter(([name]) => name === "index.html" || name.startsWith("assets/"));
  for (const [name, bytes] of emitted) {
    const entry = app.manifest.entries.find((entry) => entry.url === "/" + name);
    assert.ok(entry, `${name} is indexed in manifest entries`);
    assert.equal(entry.sha256, digest(bytes), name + " digest matches final output");
  }
  const core = coreEntries(app.manifest);
  const optional = optionalEntries(app.manifest);
  assert.ok(core.length > 0 && optional.length > 0, "entries are partitioned into core and optional");
  assert.ok(optional.some((entry) => /mermaid|diagram|flowchart/i.test(entry.url)), "real lazy diagram engine is optional");
  assert.ok(optional.some((entry) => /pdf\.worker/.test(entry.url)), "the PDF worker is optional");
  assert.ok(core.some((entry) => entry.url.endsWith(".woff2")), "math fonts the core CSS names install with the shell");
  const runtime = worker(app);
  await runtime.lifecycle("install");
  assert.equal(runtime.claimCalls, 0, "installation must finish before activation claims pages");
  assert.equal(runtime.skipCalls, 1, "a verified update applies without waiting for every window to close");
  // The worker only installs core entries; lazy chunks stay unrequested.
  assert.deepEqual(seen.filter((url) => url !== "/").sort(), core.map((entry) => entry.url).sort());
  assert.equal(runtime.caches.stores.size, 1);
  assert.equal([...runtime.caches.stores.values()][0].size, core.length);
  await runtime.lifecycle("activate");
  assert.equal(runtime.claimCalls, 1);
  offline = true;
  const shell = await runtime.request("/?thread=example", { navigate: true });
  assert.deepEqual(Buffer.from(await shell.arrayBuffer()), app.files.get("index.html"));
  for (const entry of core) {
    const response = await runtime.request(entry.url);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), entry.sha256, `${entry.url} loads offline immediately`);
  }
  // Optional asset loads on demand when online, then becomes available offline.
  offline = false; seen.length = 0;
  const lazyEntry = optional.find((entry) => entry.url.endsWith(".js"));
  assert.ok(lazyEntry);
  const lazyOnline = await runtime.request(lazyEntry.url);
  assert.equal(digest(Buffer.from(await lazyOnline.arrayBuffer())), lazyEntry.sha256);
  assert.equal(seen.includes(lazyEntry.url), true);
  assert.equal([...runtime.caches.stores.values()][0].size, core.length + 1);
  offline = true; seen.length = 0;
  const lazyOffline = await runtime.request(lazyEntry.url);
  assert.equal(digest(Buffer.from(await lazyOffline.arrayBuffer())), lazyEntry.sha256);
  assert.equal(seen.length, 0, "subsequent load uses the stored cache without network");
  const total = app.manifest.entries.reduce((sum, entry) => sum + app.files.get(decodeURIComponent(entry.url.slice(1))).length, 0);
  const coreBytes = core.reduce((sum, entry) => sum + app.files.get(decodeURIComponent(entry.url.slice(1))).length, 0);
  t.diagnostic(`Total assets ${app.manifest.entries.length} (${total} bytes); Core precache ${core.length} files (${coreBytes} bytes); Optional ${optional.length} files.`);
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
  assert.equal(await runtime.request(coreEntries(app.manifest).find((entry) => entry.url.endsWith(".js")).url + "?private=token"), undefined);
  assert.equal([...runtime.caches.stores.values()][0].size, coreEntries(app.manifest).length);
});

test("SHA-verified static JS and CSS load offline even when request Origin differs from precaching", async () => {
  serve(app);
  const runtime = worker(app);
  await runtime.lifecycle("install"); await runtime.lifecycle("activate");
  const cache = await runtime.caches.open((await runtime.caches.keys())[0]);
  offline = true;
  for (const suffix of [".js", ".css"]) {
    const entry = coreEntries(app.manifest).find((entry) => entry.url.endsWith(suffix));
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
  failure = { url: kind === "login-html" ? "/index.html" : coreEntries(app.manifest).find((entry) => entry.url.endsWith(".js")).url, kind };
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
  assert.equal([...runtime.caches.stores.values()][0].size, coreEntries(app.manifest).length);
  offline = true;
  assert.match(await (await runtime.request("/", { navigate: true })).text(), /__CF\$cv\$params/);
});

test("a dropped connection retries the file instead of abandoning the update", async () => {
  serve(app);
  failure = { url: coreEntries(app.manifest).find((entry) => entry.url.endsWith(".js")).url, kind: "flaky" };
  const runtime = worker(app);
  await runtime.lifecycle("install");
  assert.equal(failure.drops, 3);
  assert.equal([...runtime.caches.stores.values()][0].size, coreEntries(app.manifest).length);
});

test("an interrupted install resumes without downloading verified files again", async () => {
  serve(app);
  const caches = cacheStorage();
  const key = "bot-shell2-" + encodeURIComponent(app.manifest.base) + "-" + app.manifest.revision;
  const core = coreEntries(app.manifest);
  const first = core[0];
  const cache = await caches.open(key);
  const second = core[1];
  await cache.put(new URL(first.url, origin), new Response(app.files.get(decodeURIComponent(first.url.slice(1)))));
  await cache.put(new URL(second.url, origin), new Response("interrupted entry"));
  await worker(app, caches).lifecycle("install");
  assert.equal(seen.includes(first.url), false);
  assert.equal(seen.includes(second.url), true);
  assert.equal(seen.filter((url) => url !== "/").length, core.length - 1);
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
  const changed = coreEntries(update.manifest).filter((entry) => !coreEntries(app.manifest).some((old) => old.url === entry.url && old.sha256 === entry.sha256));
  failure = { url: changed.find((entry) => entry.url.endsWith(".js")).url, kind: "missing" };
  await assert.rejects(next.lifecycle("install"));
  assert.deepEqual(Buffer.from(await (await old.request("/", { navigate: true })).arrayBuffer()), app.files.get("index.html"));
  failure = undefined;
  seen.length = 0;
  await next.lifecycle("install");
  assert.deepEqual(seen.filter((url) => url !== "/").sort(), changed.map((entry) => entry.url).sort());
  assert.ok((await caches.keys()).includes(oldKey), "waiting update cannot delete active old shell");
  offline = true;
  assert.deepEqual(Buffer.from(await (await old.request("/", { navigate: true })).arrayBuffer()), app.files.get("index.html"));
  await next.lifecycle("activate");
  assert.deepEqual(Buffer.from(await (await next.request("/", { navigate: true })).arrayBuffer()), update.files.get("index.html"));
  assert.equal((await caches.keys()).includes(oldKey), true);
  assert.ok((await caches.keys()).includes("unrelated-app-cache"));
  assert.ok((await caches.keys()).includes("bot-shell-%2Fnested%2Fbot%2F-retained"));
});

test("an update after a rollback retains the last active shell", async () => {
  const caches = cacheStorage();
  for (const build of [app, update, app, later, app]) {
    serve(build);
    const runtime = worker(build, caches);
    await runtime.lifecycle("install"); await runtime.lifecycle("activate");
  }
  assert.deepEqual(seen.filter((url) => url !== "/"), [], "the rollback reuses every entry of the last active build");
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

test("unfetched optional assets fail gracefully when offline without crashing shell", async () => {
  serve(app);
  const runtime = worker(app);
  await runtime.lifecycle("install"); await runtime.lifecycle("activate");
  offline = true;
  const unvisited = optionalEntries(app.manifest).find((entry) => entry.url.endsWith(".js"));
  assert.ok(unvisited);
  await assert.rejects(runtime.request(unvisited.url));
  // Core navigation remains fully functional
  const shell = await runtime.request("/", { navigate: true });
  assert.deepEqual(Buffer.from(await shell.arrayBuffer()), app.files.get("index.html"));
});

test("an update serves a lazy chunk the previous shell cached on demand, and never other bytes under its name", async () => {
  serve(update);
  const caches = cacheStorage();
  const first = worker(update, caches);
  await first.lifecycle("install"); await first.lifecycle("activate");
  const lazy = optionalEntries(update.manifest).find((entry) => entry.url.endsWith(".js"));
  assert.ok(lazy);
  await (await first.request(lazy.url)).arrayBuffer();
  serve(sameLazy);
  assert.ok(optionalEntries(sameLazy.manifest).some((entry) => entry.url === lazy.url && entry.sha256 === lazy.sha256), "the chunk is unchanged across these builds");
  const next = worker(sameLazy, caches);
  await next.lifecycle("install"); await next.lifecycle("activate");
  offline = true;
  const reusedChunk = await next.request(lazy.url);
  assert.equal(digest(Buffer.from(await reusedChunk.arrayBuffer())), lazy.sha256, "first use offline after the update still loads");

  // Another release's bytes stored under this build's name are refused, offline and online.
  offline = false;
  serve(later);
  const tampered = cacheStorage();
  const laterLazy = optionalEntries(later.manifest).find((entry) => entry.url.endsWith(".js"));
  await (await tampered.open("bot-shell2-%2F-older")).put(new URL(laterLazy.url, origin).href, new Response('export const diagram = "older";'));
  const third = worker(later, tampered);
  await third.lifecycle("install"); await third.lifecycle("activate");
  offline = true;
  await assert.rejects(third.request(laterLazy.url));
  offline = false; seen.length = 0;
  const fresh = await third.request(laterLazy.url);
  assert.equal(digest(Buffer.from(await fresh.arrayBuffer())), laterLazy.sha256);
  assert.deepEqual(seen, [laterLazy.url]);
});

test("a push shows the Bot's icon, badge and timestamp", async () => {
  const runtime = worker(app);
  const notice = await runtime.push({
    title: "Alpha",
    body: "Waiting for you",
    tag: "waiting:alpha:thread-1",
    url: "/?bot=alpha&thread=thread-1",
    icon: "/api/bots/alpha/avatar.png",
    badge: "/api/bots/alpha/badge.png",
    timestamp: 1_700_000_000_000,
  });
  assert.ok(notice);
  const options = notice.options as NotificationOptions & { timestamp?: number };
  assert.equal(notice.title, "Alpha");
  assert.equal(options.body, "Waiting for you");
  assert.equal(options.tag, "waiting:alpha:thread-1");
  assert.equal(options.icon, "/api/bots/alpha/avatar.png");
  assert.equal(options.badge, "/api/bots/alpha/badge.png");
  assert.equal(options.timestamp, 1_700_000_000_000);
  assert.equal((options.data as { url?: string }).url, "/?bot=alpha&thread=thread-1");
  assert.equal("renotify" in options, false, "a replacement stays quiet");
});

test("a push with no icon keeps the app icon and drops malformed extras", async () => {
  const runtime = worker(app);
  const notice = await runtime.push({
    body: "Finished",
    timestamp: Number.NaN,
    badge: 42,
  });
  assert.ok(notice);
  const options = notice.options as NotificationOptions & { timestamp?: number };
  assert.equal(notice.title, "Threebot");
  assert.equal(options.tag, "threebot");
  assert.equal(options.icon, "/icon-192.png");
  assert.equal(options.timestamp, undefined);
  assert.equal(options.badge, undefined);
});

test("a notification click navigates the open window, and opens a new one when it cannot", async () => {
  const runtime = worker({ ...app, openWindows: [`${origin}/`] });
  await runtime.click({ url: "/?bot=alpha&thread=thread-1" });
  assert.deepEqual(runtime.navigated, [`${origin}/?bot=alpha&thread=thread-1`]);
  const failing = worker({ ...app, openWindows: [`${origin}/`], navigateFails: true });
  await failing.click({ url: "/?bot=beta" });
  assert.deepEqual(failing.opened, [`${origin}/?bot=beta`]);
});
