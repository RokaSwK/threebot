// The PWA service worker. plugins/pwaPrecache.ts compiles it to /sw.js and embeds the exact
// build revisions in place of BOT_BUILD_PRECACHE, so it never installs a partial core shell. Lazy
// chunks it names (diagrams, PDF, highlighting) are cached on first use, checked against the same hashes.
// API, T3, login and Cloudflare traffic stay online.

/** A file of this build: its bytes' SHA-256, or for index.html the asset URLs it must load. `optional` waits for first use. */
type PrecacheEntry = { url: string; sha256: string; markers?: string[]; optional?: boolean };
type Build = { revision: string; base: string; entries: PrecacheEntry[] };

declare const self: ServiceWorkerGlobalScope;
declare const BOT_BUILD_PRECACHE: Build | null;

const BUILD = BOT_BUILD_PRECACHE;
if (!BUILD) throw new Error("Build the PWA before registering its service worker.");
const SCOPE = new URL(BUILD.base, self.location.origin);
const scopeKey = encodeURIComponent(SCOPE.pathname) + "-";
const LEGACY_PREFIX = "bot-shell-" + scopeKey;
// Previous releases delete everything under their own prefix during activation.
const CACHE_PREFIX = "bot-shell2-" + scopeKey;
const SHELL = CACHE_PREFIX + BUILD.revision;
const SHELL_STATE = "bot-shell-state-" + scopeKey;
const INDEX = new URL("index.html", SCOPE).href;
const STATIC = new Map(BUILD.entries.map((entry) => [new URL(entry.url, self.location.origin).href, entry]));
const CORE = BUILD.entries.filter((entry) => !entry.optional);
const MATCH = { ignoreVary: true };
const isShell = (key: string) => key.startsWith(CACHE_PREFIX) || key.startsWith(LEGACY_PREFIX);

// One dropped connection must not cost a phone the whole update.
async function retrying(entry: PrecacheEntry, attempts = 3): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try { return await verifiedResponse(entry); }
    catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    }
  }
}

/** Whether these bytes are the ones this build names: the page by what it loads, everything else by hash. */
async function matches(entry: PrecacheEntry, response: Response): Promise<boolean> {
  if (response.status !== 200) return false;
  if (entry.markers) {
    const html = await response.clone().text();
    return entry.markers.length > 0 && entry.markers.every((marker) => html.includes(marker));
  }
  const digest = await crypto.subtle.digest("SHA-256", await response.clone().arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") === entry.sha256;
}

async function verifiedResponse(entry: PrecacheEntry, cache: RequestCache = "reload"): Promise<Response> {
  const request = new Request(new URL(entry.url, self.location.origin), {
    credentials: "same-origin", cache, redirect: "error", ...(cache === "only-if-cached" ? { mode: "same-origin" as const } : {}),
  });
  const response = await fetch(request);
  if (!response.ok || response.redirected || response.type !== "basic" || response.url !== request.url) {
    throw new Error("PWA static asset unavailable.");
  }
  if (!(await matches(entry, response))) throw new Error(entry.markers ? "PWA page is not this build." : "PWA static asset revision changed.");
  return response;
}

/**
 * The previous revision's cache may already hold this file: it kept its name, and the name is the
 * content hash, so an unchanged chunk is copied instead of downloaded again. The copy is still
 * checked — a half-written or evicted cache must never put old bytes into a new shell. `ignoreVary`
 * because the gateway marks the bundle `Vary: Accept-Encoding` and this worker always stores the
 * encoding the browser picked.
 */
async function reused(entry: PrecacheEntry, url: URL, previous: readonly Cache[]): Promise<Response | null> {
  for (const cache of previous) {
    const hit = await cache.match(url.href, MATCH);
    if (!hit) continue;
    try {
      if (await matches(entry, hit)) return hit;
    } catch { /* an unreadable copy is a miss */ }
  }
  return null;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    try {
      // A file that kept its name kept its bytes, so an update costs what changed instead of the
      // whole shell. The previous revision's cache is still readable: activate deletes it later.
      const previous = await Promise.all((await caches.keys())
        .filter((key) => key !== SHELL && isShell(key))
        .map((key) => caches.open(key)));
      // Install the core shell immediately; optional modules (diagrams, pdf, highlight)
      // download on demand at runtime and are cached then.
      let next = 0;
      const results = await Promise.allSettled(Array.from({ length: Math.min(6, CORE.length) }, async () => {
        while (next < CORE.length) {
          const entry = CORE[next++];
          const url = new URL(entry.url, self.location.origin);
          const kept = await reused(entry, url, [cache, ...previous]);
          await cache.put(url.href, kept ?? await retrying(entry));
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
    const previous = keys.filter((key) => key !== SHELL && key.startsWith(CACHE_PREFIX));
    const legacy = keys.filter((key) => key.startsWith(LEGACY_PREFIX));
    // Reusing a shell on rollback keeps its original insertion order. Remember
    // the last activated shell so a subsequent update retains the right one.
    const state = await caches.open(SHELL_STATE);
    const lastActive = await (await state.match(SCOPE.href))?.text();
    const predecessor = lastActive && previous.includes(lastActive) ? lastActive : previous.at(-1);
    await state.put(SCOPE.href, new Response(SHELL));
    const obsolete = SCOPE.pathname === "/" ? keys.filter((key) => /^bot-shell-v\d+$/.test(key)) : [];
    const replaced = previous.filter((key) => key !== predecessor);
    await Promise.all([...replaced, ...legacy.slice(0, -1), ...obsolete].map((key) => caches.delete(key)));
    await self.clients.claim();
    if (!predecessor && !legacy.length && !obsolete.length) return;
    // Start the reload without waiting for it, since its fetch waits for activation.
    const windows = await self.clients.matchAll({ type: "window" });
    for (const client of windows) void client.navigate(client.url).catch(() => {});
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const route = url.pathname.slice(SCOPE.pathname.length);
  if (/^(api|t3|cdn-cgi|login|logout|auth|welcome)(\/|$)/i.test(route)) return;
  if (request.mode === "navigate") {
    // An evicted page falls back to the original navigation, including any login redirect.
    event.respondWith(caches.open(SHELL).then(async (cache) => (await cache.match(INDEX, MATCH)) || fetch(request)));
    return;
  }
  const key = url.href;
  const entry = STATIC.get(key);
  if (!entry) return;
  // An evicted or on-demand entry may be served from the network only if it belongs to this worker.
  event.respondWith(caches.open(SHELL).then(async (cache) => {
    const cached = await cache.match(key, MATCH);
    if (cached) return cached;
    const previous = await Promise.all((await caches.keys())
      .filter((k) => k !== SHELL && isShell(k))
      .map((k) => caches.open(k)));
    // A chunk the page loaded before this worker controlled it may sit in the HTTP cache: offline,
    // that copy (checked like any other) is the only one there is.
    const response = await reused(entry, url, previous)
      ?? await verifiedResponse(entry, "only-if-cached").catch(() => verifiedResponse(entry));
    try {
      await cache.put(key, response.clone());
    } catch { /* Quota exceeded or cache write failure must not break the current view */ }
    return response;
  }));
});

self.addEventListener("push", (event) => {
  // Payload shape comes from server/push.mts. Every push is shown: browsers require it, and Safari
  // drops a subscription after three pushes that showed nothing. The gateway is the one that holds
  // back a push about the Bot or room this device has open (lib/push.ts reports that). The tag is the one
  // the page's own notification uses, so the two replace each other instead of stacking. The worker
  // is a classic script with no imports, so the option guards are repeated from lib/notification.ts.
  let payload: {
    title?: unknown; body?: unknown; tag?: unknown; url?: unknown;
    icon?: unknown; badge?: unknown; timestamp?: unknown; kind?: unknown;
  } = {};
  try { payload = event.data?.json() ?? {}; } catch { /* A push without JSON still gets a generic notification. */ }
  const tag = typeof payload.tag === "string" && payload.tag ? payload.tag : "threebot";
  // A request answered here or elsewhere: close its notice. The gateway sends this only to push
  // services that allow it (not Safari or Firefox). Chromium still shows its own "updated in the
  // background" notice when a push leaves nothing on screen, so when no other notice remains and no
  // window is in view, the answered one is replaced, quietly, by a notice that says so.
  if (payload.kind === "resolved") {
    event.waitUntil((async () => {
      for (const notification of await self.registration.getNotifications({ tag })) notification.close();
      if ((await self.registration.getNotifications()).length) return;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.some((client) => client.visibilityState === "visible")) return;
      await self.registration.showNotification(typeof payload.title === "string" && payload.title ? payload.title : "Threebot", {
        body: typeof payload.body === "string" ? payload.body : "Answered",
        tag,
        silent: true,
        icon: typeof payload.icon === "string" && payload.icon ? payload.icon : "/icon-192.png",
        data: { url: typeof payload.url === "string" ? payload.url : "./" },
      });
    })());
    return;
  }
  // The worker's DOM lib predates `timestamp`; the browser supports it.
  const options: NotificationOptions & { timestamp?: number } = {
    body: typeof payload.body === "string" ? payload.body : "Finished",
    tag,
    icon: typeof payload.icon === "string" && payload.icon ? payload.icon : "/icon-192.png",
    data: { url: typeof payload.url === "string" ? payload.url : "./" },
  };
  if (typeof payload.badge === "string" && payload.badge) options.badge = payload.badge;
  if (typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)) options.timestamp = payload.timestamp;
  event.waitUntil(self.registration.showNotification(
    typeof payload.title === "string" && payload.title ? payload.title : "Threebot",
    options,
  ));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const subscription = event.newSubscription;
    if (!subscription) return;
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    }).catch(() => {});
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url ?? "./", SCOPE).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => client.url.startsWith(SCOPE.href));
    if (!open) return self.clients.openWindow(target);
    await open.focus();
    try {
      await open.navigate(target);
    } catch {
      // A window the worker no longer controls cannot be navigated; open a new one instead.
      return self.clients.openWindow(target);
    }
  })());
});
