// Vite embeds exact build revisions here. The public development template never
// installs a partial shell. API, T3, login and Cloudflare traffic stay online.
const BUILD = /* BOT_BUILD_PRECACHE */ null;
if (!BUILD) throw new Error("Build the PWA before registering its service worker.");
const SCOPE = new URL(BUILD.base, self.location.origin);
const CACHE_PREFIX = "bot-shell-" + encodeURIComponent(SCOPE.pathname) + "-";
const SHELL = CACHE_PREFIX + BUILD.revision;
const INDEX = new URL("index.html", SCOPE).href;
const STATIC = new Set(BUILD.entries.map((entry) => new URL(entry.url, self.location.origin).href));

// One dropped connection must not cost a phone the whole update.
async function retrying(entry, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try { return await verifiedResponse(entry); }
    catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    }
  }
}

async function verifiedResponse(entry) {
  const request = new Request(new URL(entry.url, self.location.origin), {
    credentials: "same-origin", cache: "reload", redirect: "error",
  });
  const response = await fetch(request);
  if (!response.ok || response.redirected || response.type !== "basic" || response.url !== request.url) {
    throw new Error("PWA static asset unavailable.");
  }
  if (entry.markers) {
    const html = await response.clone().text();
    if (!entry.markers.length || !entry.markers.every((marker) => html.includes(marker))) throw new Error("PWA page is not this build.");
    return response;
  }
  const digest = await crypto.subtle.digest("SHA-256", await response.clone().arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (sha256 !== entry.sha256) throw new Error("PWA static asset revision changed.");
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    try {
      // Bound installation traffic even when syntax/diagram engines emit many
      // lazy chunks. No page-controlled fetches are needed to prime this cache.
      let next = 0;
      const results = await Promise.allSettled(Array.from({ length: Math.min(6, BUILD.entries.length) }, async () => {
        while (next < BUILD.entries.length) {
          const entry = BUILD.entries[next++];
          const url = new URL(entry.url, self.location.origin);
          // This cache belongs to one revision, so an interrupted install can resume.
          if (!(await cache.match(url))) await cache.put(url, await retrying(entry));
        }
      }));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    } catch (error) {
      await caches.delete(SHELL);
      throw error;
    }
    // An installed PWA can stay open indefinitely, so a verified update applies now.
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const replaced = keys.filter((key) => key !== SHELL && (
      key.startsWith(CACHE_PREFIX) || (SCOPE.pathname === "/" && /^bot-shell-v\d+$/.test(key))
    ));
    await Promise.all(replaced.map((key) => caches.delete(key)));
    await self.clients.claim();
    if (!replaced.length) return;
    // Old windows have no update logic of their own. Drafts are stored locally,
    // and earlier hashed assets stay on the server until this reload happens.
    const windows = await self.clients.matchAll({ type: "window" });
    await Promise.allSettled(windows.map((client) => client.navigate(client.url)));
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const route = url.pathname.slice(SCOPE.pathname.length);
  if (/^(api|t3|cdn-cgi|login|logout|auth|welcome)(\/|$)/i.test(route)) return;
  if (request.mode === "navigate") {
    // Serve a coherent installed revision. Never overwrite it with runtime HTML
    // (including an Access login page); a new build installs as another worker.
    event.respondWith(caches.open(SHELL).then(async (cache) => (await cache.match(INDEX)) || fetch(request)));
  } else if (STATIC.has(url.href)) {
    event.respondWith(caches.open(SHELL).then(async (cache) => (await cache.match(request, { ignoreVary: true })) || fetch(request)));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url ?? "./", SCOPE).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => client.url.startsWith(SCOPE.href));
    if (!open) return self.clients.openWindow(target);
    await open.focus();
    return open.navigate(target);
  })());
});
